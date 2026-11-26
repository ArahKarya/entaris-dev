import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { updateAccountBalance, recalcPartyOutstanding } from '../utils/accountBalance';
import { assertPartySideLocked } from './ledger/partySides';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { systemAccounts } from './systemAccounts';
import { computePurchaseInvoiceTotals } from './purchaseInvoiceCalc';
import { resolvePurchaseLineType, resolvePurchaseOrderIdFromReceipts } from './purchaseInvoiceLinks';
import { lockInventoryRows } from './inventory/stockLocks';
import { postRevaluation } from './inventory/inventoryLedger';
import { cogsAccountFor } from './ledger/systemRoleAccounts';

type Tx = Prisma.TransactionClient;

export interface SubmitPurchaseInvoiceInput {
  date: string;
  partyId: string;
  items: Array<{
    itemName: string;
    inventoryItemId?: string | null;
    warehouseId?: string | null;
    quantity: number;
    unit?: string | null;
    rate: number;
    discount?: number;
    taxPct?: number;
    pphPct?: number;
    potonganItem?: number;
    kualitas?: string | null;
    refaksi?: number | null;
    timbanganTruk?: number | null;
    timbanganDiterima?: number | null;
    nomorMobil?: string | null;
    description?: string | null;
    itemType?: string;
    /** Optional: link to STT/BPB line. When set, PI does NOT create a stock
     * movement for this line (STT already did). PI posts variance against
     * STT's provisional cost instead. */
    goodsReceiptItemId?: string | null;
  }>;
  dueDate?: string | null;
  notes?: string | null;
  terms?: string | null;
  biayaLain?: number;
  taxPct?: number;
  potongan?: number;
}

/**
 * Submit a purchase invoice: hargaAkhir per item includes PPN/PPh/potonganItem, landed cost
 * (biayaLain + non-linked items) is allocated across STT-linked items, and the JE posts DR per
 * item inventory account / CR AP. The landed-cost delta of an STT line (invoice amount − the STT's
 * locked cost) is a Revaluation of the received item through the value ledger (postRevaluation,
 * reference 'PurchaseInvoice', adjusting the STT movement, which is never rewritten): the part stock
 * absorbs goes to the item's inventory account, the rest (no stock left, or a decrease beyond
 * stock_value) to COGS in the same journal.
 */
export async function submitPurchaseInvoiceInTx(
  tx: Tx,
  body: SubmitPurchaseInvoiceInput,
  userId: string,
) {
  const parsedDate = new Date(body.date);
  if (isNaN(parsedDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  const fiscalYear = await getOpenFiscalYear(tx, parsedDate);

  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Data supplier tidak ditemukan.');
  if (!party.isActive) throw new BusinessError('Supplier sudah tidak aktif.');

  const apAccount = await systemAccounts.getAccount('AP');
  const inventoryAccount = await systemAccounts.getAccount('INVENTORY');
  // Lazy-loaded, only needed on the STT-linked path.
  let accruedAccount: { id: string; name: string } | null = null;

  // Pre-validate any STT-linked items. Reject early if STT cancelled,
  // already invoiced, or supplier mismatch.
  const sttItemIds = body.items
    .map((i) => i.goodsReceiptItemId)
    .filter((id): id is string => !!id);
  const sttItemMap = new Map<string, any>();
  if (sttItemIds.length > 0) {
    // Lock the STT headers before reading them: a concurrent STT cancel holds the same row lock,
    // so this read sees it committed (and rejects), and a later cancel waits and sees the PI link.
    await tx.$queryRaw`
      SELECT id FROM goods_receipts
      WHERE id IN (SELECT goods_receipt_id FROM goods_receipt_items WHERE id IN (${Prisma.join(sttItemIds)}))
      ORDER BY id FOR UPDATE`;
    const sttItems = await tx.goodsReceiptItem.findMany({
      where: { id: { in: sttItemIds } },
      include: { goodsReceipt: true, invoiceItem: { select: { id: true } } },
    });
    for (const grItem of sttItems) {
      if (grItem.goodsReceipt.status === 'Cancelled') {
        throw new BusinessError(`STT ${grItem.goodsReceipt.sttNumber} sudah dibatalkan.`);
      }
      if (grItem.goodsReceipt.isCustomerOwned) {
        throw new BusinessError(
          `STT ${grItem.goodsReceipt.sttNumber} adalah barang titipan customer (repros). Tidak bisa di-invoice sebagai pembelian.`,
        );
      }
      if (grItem.goodsReceipt.partyId !== body.partyId) {
        throw new BusinessError(
          `Supplier baris dari STT ${grItem.goodsReceipt.sttNumber} berbeda dengan supplier invoice.`,
        );
      }
      if (grItem.invoiceItem) {
        throw new BusinessError(
          `Baris STT ${grItem.goodsReceipt.sttNumber} sudah di-invoice sebelumnya.`,
        );
      }
      sttItemMap.set(grItem.id, grItem);
    }
  }

  // Lock the received items before the invoice number, the Revaluation numbers and the journal
  // accounts (LOCK ORDER in services/inventory/stockLocks.ts): the landed-cost Revaluations below
  // read stock and stock_value under it.
  const receivedItemIds = Array.from(sttItemMap.values()).map((gri) => gri.inventoryItemId as string);
  await lockInventoryRows(tx, { itemIds: receivedItemIds });

  // Goods enter only via STT/BPB: every line with inventoryItemId must link to a submitted
  // goodsReceiptItemId (no double stock-in). Service / free-account lines need no link.
  const orphanInventoryLines = body.items.filter(
    (it) => it.inventoryItemId && !it.goodsReceiptItemId,
  );
  if (orphanInventoryLines.length > 0) {
    const orphanIds = orphanInventoryLines
      .map((l) => l.inventoryItemId)
      .filter((id): id is string => !!id);
    const offenders = await tx.inventoryItem.findMany({
      where: { id: { in: orphanIds } },
      select: { id: true, name: true },
    });
    const names = orphanInventoryLines
      .map((l) => offenders.find((o) => o.id === l.inventoryItemId)?.name ?? l.itemName)
      .filter((n, i, arr) => arr.indexOf(n) === i)
      .join(', ');
    throw new BusinessError(
      `Item inventori "${names}" tidak bisa di-invoice langsung. ` +
      `Buat STT / BPB (Bukti Penerimaan Barang) terlebih dahulu. Invoice hanya bisa di-generate dari STT yang sudah submit. ` +
      `Stok masuk lewat STT, bukan invoice.`,
    );
  }

  const totals = computePurchaseInvoiceTotals(body);
  const itemsWithAmount = body.items.map((item, i) => ({
    ...item,
    effectiveQty: totals.lines[i].effectiveQuantity,
    computedAmount: totals.lines[i].hargaAkhir,
  }));
  const headerPotongan = totals.potonganItemTotal;
  const grandTotal = totals.grandTotal;
  const grandTotalNum = grandTotal.toNumber();
  const invoiceNumber = await generateDocumentNumber(tx, 'PI', parsedDate, fiscalYear.id);

  // Pre-fetch inventory items (of the lines and of the received STT lines) to resolve per-item accounts.
  const invItemIds = [...body.items.map((i) => i.inventoryItemId).filter(Boolean) as string[], ...receivedItemIds];
  const inventoryItems = invItemIds.length > 0
    ? await tx.inventoryItem.findMany({ where: { id: { in: invItemIds } } })
    : [];
  const invItemMap = new Map(inventoryItems.map((i) => [i.id, i]));

  // Header PO link from the billed STTs (only when they all share one PO).
  const linkedReceipts = new Map<string, { purchaseOrderId: string | null }>();
  for (const gri of sttItemMap.values()) linkedReceipts.set(gri.goodsReceiptId, gri.goodsReceipt);
  const purchaseOrderId = resolvePurchaseOrderIdFromReceipts([...linkedReceipts.values()]);

  const invoice = await tx.purchaseInvoice.create({
    data: {
      invoiceNumber,
      date: parsedDate,
      purchaseOrderId,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      partyId: body.partyId,
      grandTotal: grandTotalNum,
      outstanding: grandTotalNum,
      taxPct: 0,
      potongan: headerPotongan.toNumber(),
      biayaLain: body.biayaLain ?? 0,
      status: 'Submitted',
      notes: body.notes || null,
      terms: body.terms || null,
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
      items: {
        create: itemsWithAmount.map((item) => {
          const linkedItem = item.inventoryItemId ? invItemMap.get(item.inventoryItemId) : null;
          const itemAccountId = linkedItem?.accountId || inventoryAccount.id;
          return {
            itemName: item.itemName,
            itemType: resolvePurchaseLineType(item),
            inventoryItemId: item.inventoryItemId || null,
            warehouseId: item.warehouseId || null,
            quantity: item.effectiveQty.toNumber(),
            unit: item.unit || 'pcs',
            rate: item.rate,
            discount: item.discount ?? 0,
            amount: item.computedAmount.toNumber(),
            taxPct: item.taxPct ?? 0,
            pphPct: item.pphPct ?? 0,
            potonganItem: item.potonganItem ?? 0,
            kualitas: item.kualitas ?? null,
            refaksi: item.refaksi ?? null,
            timbanganTruk: item.timbanganTruk ?? null,
            timbanganDiterima: item.timbanganDiterima ?? null,
            nomorMobil: item.nomorMobil ?? null,
            accountId: itemAccountId,
            description: item.description || null,
            goodsReceiptItemId: item.goodsReceiptItemId || null,
          };
        }),
      },
    },
    include: { supplier: true, items: true },
  });

  // Landed cost allocation.
  const linkedInvItems = invoice.items.filter((i) => i.inventoryItemId);
  const nonLinkedInvItems = invoice.items.filter((i) => !i.inventoryItemId);
  const linkedSubtotal = linkedInvItems.reduce(
    (s, i) => s.plus(new Decimal(i.amount.toString())), new Decimal(0));
  const nonLinkedTotal = nonLinkedInvItems.reduce(
    (s, i) => s.plus(new Decimal(i.amount.toString())), new Decimal(0));
  const adjustmentRemainder = new Decimal(body.biayaLain ?? 0);
  const landedCostPool = nonLinkedTotal.plus(adjustmentRemainder);
  const canDistribute = linkedInvItems.length > 0 && linkedSubtotal.gt(0) && !landedCostPool.isZero();

  const effectiveAmountMap = new Map<string, Decimal>();
  if (canDistribute) {
    let allocatedSoFar = new Decimal(0);
    linkedInvItems.forEach((invItem, idx) => {
      const original = new Decimal(invItem.amount.toString());
      let share: Decimal;
      if (idx === linkedInvItems.length - 1) {
        share = landedCostPool.minus(allocatedSoFar);
      } else {
        share = landedCostPool.mul(original).div(linkedSubtotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        allocatedSoFar = allocatedSoFar.plus(share);
      }
      effectiveAmountMap.set(invItem.id, original.plus(share));
    });
  }

  // DR Persediaan per item account for non-linked lines. STT-linked lines were accrued at STT
  // submit; PI reverses the accrual and posts the landed-cost delta to Persediaan, not 5.11, so
  // the batch cost reflects the full PI cost (incl. "Resiko Macan" and header biaya_lain).
  const debitByAccount = new Map<string, { amount: Decimal; names: string[] }>();
  let accruedReversal = new Decimal(0); // DR Hutang Belum Tagih (provisional total)
  // Part of the landed-cost deltas stock could not absorb (revaluationSplit): DR (+) / CR (−) COGS.
  let landedToCogs = new Decimal(0);
  const cogsNames: string[] = [];

  for (const invItem of invoice.items) {
    const effective = effectiveAmountMap.get(invItem.id);
    const amt = effective ?? new Decimal(invItem.amount.toString());

    if (invItem.goodsReceiptItemId) {
      // STT booked stock at sttQty (physical qty before refaksi); the paid qty may be smaller but
      // movement qty stays sttQty. Final price per kg = PI total / sttQty; landed cost adjustment
      // = effectiveAmount - (sttQty x provisionalCost).
      const grItem = sttItemMap.get(invItem.goodsReceiptItemId);
      if (!grItem) continue; // shouldn't happen (pre-validated)
      const sttQty = new Decimal(grItem.quantity.toString());
      const provisionalCost = new Decimal(grItem.lockedUnitCost.toString());
      const provisionalTotal = sttQty.times(provisionalCost).toDecimalPlaces(2);
      const effectiveAmount = amt;
      const delta = effectiveAmount.minus(provisionalTotal).toDecimalPlaces(2);
      accruedReversal = accruedReversal.plus(provisionalTotal);
      if (delta.isZero()) continue;

      // The delta revalues the received item (the STT movement keeps its locked cost). What stock
      // absorbs goes to the item's inventory account (1.4.x, else default INVENTORY), aggregated per
      // account like non-linked lines; the rest goes to COGS.
      const reval = await postRevaluation(tx, {
        itemId: grItem.inventoryItemId, date: parsedDate, fiscalYearId: fiscalYear.id, createdById: userId, delta,
        referenceType: 'PurchaseInvoice', referenceId: invoice.id, referenceNumber: invoice.invoiceNumber,
        adjustsMovementId: grItem.stockMovementId ?? null,
        notes: `Selisih harga Invoice pembelian ${invoice.invoiceNumber} atas STT ${grItem.goodsReceipt.sttNumber}`,
      });
      if (!reval.toCogs.isZero()) {
        landedToCogs = landedToCogs.plus(reval.toCogs);
        cogsNames.push(invItem.itemName);
      }
      if (reval.valueDelta.isZero()) continue;
      const drAccountId = invItemMap.get(grItem.inventoryItemId)?.accountId || inventoryAccount.id;
      const existing = debitByAccount.get(drAccountId);
      // A negative delta (inventory down) becomes a CR when the journal is built.
      if (existing) {
        existing.amount = existing.amount.plus(reval.valueDelta);
        existing.names.push(`adj-landed ${invItem.itemName}`);
      } else {
        debitByAccount.set(drAccountId, { amount: reval.valueDelta, names: [`adj-landed ${invItem.itemName}`] });
      }
      continue;
    }

    // Standalone line: DR Persediaan.
    if (canDistribute && !invItem.inventoryItemId) continue;
    let drAccountId = inventoryAccount.id;
    if (invItem.inventoryItemId) {
      const linkedItem = invItemMap.get(invItem.inventoryItemId);
      if (linkedItem?.accountId) drAccountId = linkedItem.accountId;
    }
    const existing = debitByAccount.get(drAccountId);
    if (existing) {
      existing.amount = existing.amount.plus(amt);
      existing.names.push(invItem.itemName);
    } else {
      debitByAccount.set(drAccountId, { amount: amt, names: [invItem.itemName] });
    }
  }
  // Fallback when no linked items: biayaLain → generic inventory account.
  if (!canDistribute && !adjustmentRemainder.isZero()) {
    const existing = debitByAccount.get(inventoryAccount.id);
    if (existing) existing.amount = existing.amount.plus(adjustmentRemainder);
    else debitByAccount.set(inventoryAccount.id, { amount: new Decimal(adjustmentRemainder), names: ['Biaya tambahan'] });
  }

  // Accrual account is needed only for STT-linked lines; landed cost goes to Persediaan, not 5.11.
  if (!accruedReversal.isZero()) {
    accruedAccount = await systemAccounts.getAccount('ACCRUED_PAYABLE');
  }

  // A Persediaan account with a negative delta (landed cost below provisional) moves to
  // creditJournalItems so the JE stays balanced.
  const creditJournalItems: { accountId: string; partyId?: string | null; debit: number; credit: number; description: string }[] = [];
  for (const [accountId, data] of Array.from(debitByAccount.entries())) {
    if (data.amount.isNegative()) {
      creditJournalItems.push({
        accountId,
        debit: 0,
        credit: data.amount.abs().toDecimalPlaces(2).toNumber(),
        description: `Persediaan adj. landed cost ${data.names.join(', ')}: ${invoice.invoiceNumber}`,
      });
      debitByAccount.delete(accountId);
    }
  }

  const jvNumber = `JV-${invoice.invoiceNumber}`;
  const debitJournalItems: { accountId: string; partyId?: string | null; debit: number; credit: number; description: string }[] =
    Array.from(debitByAccount.entries()).map(([accountId, data]) => ({
      accountId,
      debit: data.amount.toDecimalPlaces(2).toNumber(),
      credit: 0,
      description: `Persediaan ${data.names.join(', ')}: ${invoice.invoiceNumber}`,
    }));

  // Landed cost on goods already gone (or a decrease beyond their value) goes to COGS.
  if (!landedToCogs.isZero()) {
    const cogsAccount = await cogsAccountFor(tx);
    const amount = landedToCogs.abs().toDecimalPlaces(2).toNumber();
    const description = `HPP adj. landed cost ${cogsNames.join(', ')}: ${invoice.invoiceNumber}`;
    if (landedToCogs.gt(0)) debitJournalItems.push({ accountId: cogsAccount.id, debit: amount, credit: 0, description });
    else creditJournalItems.push({ accountId: cogsAccount.id, debit: 0, credit: amount, description });
  }

  // STT-linked accrual reversal: DR Hutang Belum Tagih @ provisional total.
  if (!accruedReversal.isZero() && accruedAccount) {
    debitJournalItems.push({
      accountId: accruedAccount.id,
      partyId: body.partyId,
      debit: accruedReversal.toNumber(),
      credit: 0,
      description: `Reverse accrual STT: ${invoice.invoiceNumber}`,
    });
  }

  // Always: CR Hutang Usaha @ grand total.
  creditJournalItems.push({
    accountId: apAccount.id,
    partyId: body.partyId,
    debit: 0,
    credit: grandTotalNum,
    description: `Hutang: ${invoice.invoiceNumber}`,
  });

  const allJeItems = [...debitJournalItems, ...creditJournalItems];

  const journalEntry = await tx.journalEntry.create({
    data: {
      entryNumber: jvNumber,
      date: parsedDate,
      narration: `Pembelian: ${invoice.invoiceNumber} - ${invoice.supplier.name}`,
      status: 'Submitted',
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
      items: { create: allJeItems },
    },
  });

  const ledgerData = allJeItems.map((it) => ({
    date: parsedDate,
    accountId: it.accountId,
    partyId: it.partyId ?? null,
    debit: it.debit,
    credit: it.credit,
    referenceType: 'JournalEntry',
    referenceId: journalEntry.id,
    description: it.description,
    fiscalYearId: fiscalYear.id,
  }));
  await tx.accountingLedgerEntry.createMany({ data: ledgerData });

  for (const it of allJeItems) {
    await updateAccountBalance(tx, it.accountId, it.debit, it.credit);
  }
  // The type is re-read under the party row lock: a type change committed meanwhile is seen here.
  await assertPartySideLocked(tx, body.partyId, 'PAYABLE');
  await recalcPartyOutstanding(tx, body.partyId);

  // Mark linked STTs as Invoiced (header-level shortcut).
  if (sttItemMap.size > 0) {
    const grIds = Array.from(new Set(
      Array.from(sttItemMap.values()).map((gri) => gri.goodsReceiptId),
    ));
    await tx.goodsReceipt.updateMany({
      where: { id: { in: grIds }, invoiceId: null },
      data: { invoiceId: invoice.id, invoicedAt: parsedDate },
    });
  }

  return invoice;
}
