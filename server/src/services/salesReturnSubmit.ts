import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { updateAccountBalance, recalcPartyOutstanding } from '../utils/accountBalance';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { systemAccounts } from './systemAccounts';
import { cogsAccountFor, salesReturnAccount } from './ledger/systemRoleAccounts';
import { logger } from '../lib/logger';
import { lockArThenSalesInvoiceInTx, setSalesInvoiceOutstandingInTx } from './salesInvoiceStatus';
import { lockInventoryRows } from './inventory/stockLocks';
import { postInbound } from './inventory/inventoryLedger';
import { inventoryAccountFor } from './inventory/itemAccount';
import { UNIT_COST_DP, VALUE_DP } from './inventory/inventoryValueMath';

type Tx = Prisma.TransactionClient;

/** Error code (400): a return request lists the same invoice line twice. */
export const SALES_RETURN_DUPLICATE_LINE = 'SALES_RETURN_DUPLICATE_LINE';

// Mirrors CreateSalesReturnSchema (already Zod-validated at the route).
export interface SubmitSalesReturnInput {
  salesInvoiceId: string;
  date: string;
  items: Array<{
    salesInvoiceItemId: string;
    quantity: number;
    restock?: boolean;
    warehouseId?: string | null;
  }>;
  reason?: string | null;
  notes?: string | null;
}

/**
 * Submit a sales return (credit note) against one sales invoice.
 *
 * Posts, inside the caller's $transaction:
 *   - main JE (JV-RN-...): DR 4.3 Retur Penjualan (subtotal) + DR PPN Keluaran
 *     (tax) / CR Piutang (porsi yang mengurangi outstanding) + CR Uang Muka
 *     Pelanggan (sisa → kredit pelanggan)
 *   - for restock lines: an In through the value ledger (referenceType 'SalesReturn'), which
 *     blends into the average (E3-R7), and a COGS-reversal JE (JV-COGS-RN-...): DR Persediaan /
 *     CR HPP of the same value (returnLineValue)
 *   - a CustomerDeposit Payment row for the credit portion (no own JE — the
 *     liability is already CR'd by the main JE)
 */
/** Net value of one returned line: qty × invoice rate less the line discount (before tax). */
export function returnLineAmount(quantity: number, rate: number, discountPct: number): number {
  return new Decimal(quantity)
    .mul(new Decimal(rate))
    .mul(new Decimal(1).minus(new Decimal(discountPct).div(100)))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** Return value including line tax, for the given lines. */
export function returnTotal(lines: Array<{ amount: number; taxPct: number }>): number {
  const subtotal = lines.reduce((s, r) => s.plus(new Decimal(r.amount)), new Decimal(0));
  const tax = lines
    .reduce((s, r) => s.plus(new Decimal(r.amount).mul(new Decimal(r.taxPct).div(100))), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return subtotal.plus(tax).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/** What earlier restocked returns of one invoice line took back of its delivery note's Out. */
export interface ReturnedFromDelivery {
  quantity: Decimal;
  value: Decimal;
}

/**
 * Value of a restocked return of `quantity` taken from a delivery note Out of `deliveredQty` that
 * took `deliveredValue` out of the book (−value_delta, the invoice's COGS): the proportional share,
 * 2 dp, never more than what earlier returns left of it; the return that brings the returned
 * quantity to the delivered quantity takes the rest, so the returns of a line add up to its COGS.
 */
export function returnLineValue(
  quantity: Decimal.Value,
  delivery: { quantity: Decimal.Value; value: Decimal.Value },
  prior: ReturnedFromDelivery,
): Decimal {
  const deliveredQty = new Decimal(delivery.quantity);
  const left = Decimal.max(new Decimal(delivery.value).minus(prior.value), 0);
  if (deliveredQty.lte(0)) return new Decimal(0);
  if (prior.quantity.plus(quantity).gte(deliveredQty)) return left;
  return Decimal.min(new Decimal(delivery.value).times(quantity).div(deliveredQty).toDecimalPlaces(VALUE_DP), left);
}

/** Σ quantity and value_delta of the active restocked returns of each invoice line. */
async function returnedFromDelivery(tx: Tx, invoiceItemIds: string[]): Promise<Map<string, ReturnedFromDelivery>> {
  const prior = await tx.salesReturnItem.findMany({
    where: {
      salesInvoiceItemId: { in: invoiceItemIds }, restock: true, stockMovementId: { not: null },
      salesReturn: { status: { not: 'Cancelled' } },
    },
    select: { salesInvoiceItemId: true, stockMovementId: true },
  });
  const movements = await tx.stockMovement.findMany({
    where: { id: { in: prior.map((p) => p.stockMovementId!) }, isCancelled: false },
    select: { id: true, quantity: true, valueDelta: true },
  });
  const byId = new Map(movements.map((m) => [m.id, m]));
  const out = new Map<string, ReturnedFromDelivery>();
  for (const p of prior) {
    const m = byId.get(p.stockMovementId!);
    if (!m) continue;
    const sum = out.get(p.salesInvoiceItemId) ?? { quantity: new Decimal(0), value: new Decimal(0) };
    out.set(p.salesInvoiceItemId, {
      quantity: sum.quantity.plus(m.quantity.toString()), value: sum.value.plus(m.valueDelta.toString()),
    });
  }
  return out;
}

/**
 * Value a return would have when posted, priced from the invoice lines like submitSalesReturnInTx.
 * Used to show the amount of a return that waits for approval; unknown lines count as zero.
 */
export async function estimateSalesReturnAmount(
  tx: Prisma.TransactionClient,
  body: Pick<SubmitSalesReturnInput, 'salesInvoiceId' | 'items'>,
): Promise<number> {
  const ids = body.items.map((l) => l.salesInvoiceItemId);
  const src = await tx.salesInvoiceItem.findMany({
    where: { id: { in: ids }, salesInvoiceId: body.salesInvoiceId },
    select: { id: true, rate: true, discount: true, taxPct: true },
  });
  const byId = new Map(src.map((s) => [s.id, s]));
  const total = returnTotal(
    body.items.flatMap((l) => {
      const s = byId.get(l.salesInvoiceItemId);
      return s ? [{ amount: returnLineAmount(l.quantity, Number(s.rate), Number(s.discount)), taxPct: Number(s.taxPct) }] : [];
    }),
  );
  // Display only: an absurd quantity must not block queueing (approval validates and rejects it).
  return Number.isFinite(total) && total >= 0 && total < 1e15 ? total : 0;
}

export async function submitSalesReturnInTx(
  tx: Tx,
  body: SubmitSalesReturnInput,
  userId: string,
) {
  const parsedDate = new Date(body.date);
  if (isNaN(parsedDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  const fiscalYear = await getOpenFiscalYear(tx, parsedDate);

  // Row lock before reading: the AR split below uses the current outstanding, and a concurrent
  // invoice cancel either finishes first (this return then sees Cancelled) or waits for this one
  // (and then sees an active return). AR row first, like payment submit, so the two cannot deadlock.
  await lockArThenSalesInvoiceInTx(tx, body.salesInvoiceId);
  const invoice = await tx.salesInvoice.findUnique({
    where: { id: body.salesInvoiceId },
    include: {
      customer: true,
      items: {
        include: {
          deliveryOrderItem: { include: { stockMovement: true } },
          inventoryItem: { select: { id: true, name: true, accountId: true, averageCost: true, isActive: true } },
        },
      },
    },
  });
  if (!invoice) throw new BusinessError('Invoice penjualan tidak ditemukan.');
  if (invoice.status === 'Cancelled') throw new BusinessError('Invoice sudah dibatalkan, tidak bisa diretur.');
  if (invoice.status === 'Draft') throw new BusinessError('Invoice masih draft, belum bisa diretur.');

  // One return line per invoice line: the qty guard and the value cap below read earlier returns
  // per invoice line, and each return item is linked to its own In by invoice line.
  const seenLines = new Set<string>();
  for (const line of body.items) {
    if (seenLines.has(line.salesInvoiceItemId)) {
      throw new BusinessError('Satu baris invoice hanya boleh muncul sekali dalam satu retur.', SALES_RETURN_DUPLICATE_LINE);
    }
    seenLines.add(line.salesInvoiceItemId);
  }

  // Already-returned quantity per invoice line (non-cancelled returns) — guard.
  const priorReturns = await tx.salesReturnItem.groupBy({
    by: ['salesInvoiceItemId'],
    where: {
      salesInvoiceItemId: { in: invoice.items.map((i) => i.id) },
      salesReturn: { status: { not: 'Cancelled' } },
    },
    _sum: { quantity: true },
  });
  const returnedMap = new Map<string, number>(
    priorReturns.map((r) => [r.salesInvoiceItemId, Number(r._sum.quantity ?? 0)]),
  );

  // System / contra accounts.
  const arAccount = await systemAccounts.getAccount('AR');
  const customerDepositAccount = await systemAccounts.getAccount('CUSTOMER_DEPOSIT');
  const cogsAccount = await cogsAccountFor(tx);
  const returAccount = await salesReturnAccount(tx);

  // Resolve & validate each return line
  const resolved: Array<{
    salesInvoiceItemId: string;
    inventoryItemId: string | null;
    warehouseId: string | null;
    accountId: string;
    itemName: string;
    quantity: number;
    unit: string;
    rate: number;
    discount: number;
    amount: number;
    taxPct: number;
    restock: boolean;
    unitCostLoaded: number | null;
    /** What the restock puts into the book and the COGS reversal debits to inventory (2 dp). */
    value: Decimal;
  }> = [];
  const returned = await returnedFromDelivery(tx, invoice.items.map((i) => i.id));

  for (const line of body.items) {
    const src = invoice.items.find((i) => i.id === line.salesInvoiceItemId);
    if (!src) {
      throw new BusinessError(`Baris invoice tidak ditemukan (id=${line.salesInvoiceItemId}).`);
    }
    const alreadyReturned = returnedMap.get(src.id) ?? 0;
    const remaining = new Decimal(src.quantity.toString()).minus(alreadyReturned).toNumber();
    if (line.quantity > remaining + 1e-9) {
      throw new BusinessError(
        `Qty retur "${src.itemName}" (${line.quantity}) melebihi sisa yang bisa diretur (${remaining}).`,
      );
    }

    const discount = Number(src.discount);
    const rate = Number(src.rate);
    const amount = returnLineAmount(line.quantity, rate, discount);

    const restock = line.restock !== false && !!src.inventoryItemId;

    // Value of the line: its share of the value the delivery note's Out took out of the book (the
    // invoice's COGS), capped by what earlier restocked returns left of it. A line billed without
    // a note (legacy direct sale) falls back to its loaded cost, then the current average. Only a
    // restocked line posts it (and counts against the cap); a damaged one keeps it for display.
    const delivery = src.deliveryOrderItem?.stockMovement;
    let value = new Decimal(0);
    if (delivery) {
      if (!delivery.isCancelled) {
        const prior = returned.get(src.id) ?? { quantity: new Decimal(0), value: new Decimal(0) };
        value = returnLineValue(line.quantity, { quantity: delivery.quantity.toString(), value: new Decimal(delivery.valueDelta.toString()).negated() }, prior);
      }
    } else if (src.inventoryItemId) {
      const legacyCost = src.unitCostLoaded != null ? new Decimal(src.unitCostLoaded.toString()) : Decimal.max(0, src.inventoryItem?.averageCost.toString() ?? 0);
      value = legacyCost.times(line.quantity).toDecimalPlaces(VALUE_DP);
    }
    const warehouseId = line.warehouseId || src.warehouseId || delivery?.warehouseId || null;
    if (restock && !warehouseId) throw new BusinessError(`Gudang retur untuk '${src.itemName}' wajib dipilih.`);

    resolved.push({
      salesInvoiceItemId: src.id,
      inventoryItemId: src.inventoryItemId,
      warehouseId,
      accountId: src.accountId,
      itemName: src.itemName,
      quantity: line.quantity,
      unit: src.unit,
      rate,
      discount,
      amount,
      taxPct: Number(src.taxPct),
      restock,
      unitCostLoaded: src.inventoryItemId && line.quantity > 0 ? value.div(line.quantity).toDecimalPlaces(UNIT_COST_DP).toNumber() : null,
      value,
    });
  }

  // Totals
  const subtotal = resolved.reduce((s, r) => s.plus(new Decimal(r.amount)), new Decimal(0));
  const taxAmount = resolved
    .reduce((s, r) => s.plus(new Decimal(r.amount).mul(new Decimal(r.taxPct).div(100))), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const totalReturn = new Decimal(returnTotal(resolved));
  const totalReturnNum = totalReturn.toNumber();
  // Retur qty-only (rate 0, mis. barang titipan pelanggan) valid selama minimal 1
  // baris punya qty>0 — hanya mengembalikan stok fisik, tanpa nilai piutang/kredit.
  const hasReturnedQty = resolved.some((r) => r.quantity > 0);
  if (totalReturnNum < 0) throw new BusinessError('Nilai retur tidak boleh negatif.');
  if (totalReturnNum === 0 && !hasReturnedQty) throw new BusinessError('Pilih minimal satu baris dengan qty > 0.');

  // AR vs credit split
  const outstanding = new Decimal(invoice.outstanding.toString());
  const arReduce = Decimal.min(totalReturn, outstanding).toDecimalPlaces(2);
  const arReduceNum = arReduce.toNumber();
  const creditPortion = totalReturn.minus(arReduce).toDecimalPlaces(2);
  const creditPortionNum = creditPortion.toNumber();

  // Lock the restocked items (and their rows at the return warehouses) before the RN number and
  // the journal's account locks (lock order in services/inventory/stockLocks.ts).
  const restocked = resolved.filter((r) => r.restock && r.inventoryItemId);
  await lockInventoryRows(tx, {
    itemIds: restocked.map((r) => r.inventoryItemId!),
    pairs: restocked.flatMap((r) => (r.warehouseId ? [{ itemId: r.inventoryItemId!, warehouseId: r.warehouseId }] : [])),
  });

  const returnNumber = await generateDocumentNumber(tx, 'RN', parsedDate, fiscalYear.id);
  const salesReturn = await tx.salesReturn.create({
    data: {
      returnNumber,
      date: parsedDate,
      partyId: invoice.partyId,
      salesInvoiceId: invoice.id,
      status: 'Submitted',
      subtotal: subtotal.toDecimalPlaces(2).toNumber(),
      taxAmount: taxAmount.toNumber(),
      totalReturn: totalReturnNum,
      arReducedAmount: arReduceNum,
      creditCreatedAmount: creditPortionNum,
      reason: body.reason || null,
      notes: body.notes || null,
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
      items: {
        create: resolved.map((r) => ({
          salesInvoiceItemId: r.salesInvoiceItemId,
          inventoryItemId: r.inventoryItemId,
          warehouseId: r.warehouseId,
          accountId: r.accountId,
          itemName: r.itemName,
          quantity: r.quantity,
          unit: r.unit,
          rate: r.rate,
          discount: r.discount,
          amount: r.amount,
          taxPct: r.taxPct,
          restock: r.restock,
          unitCostLoaded: r.unitCostLoaded,
        })),
      },
    },
    include: { customer: true, items: true },
  });

  // Main reversal JE (JV-RN-...)
  const jeItems: Array<{ accountId: string; debit: number; credit: number; description: string; partyId?: string }> = [
    { accountId: returAccount.id, debit: subtotal.toDecimalPlaces(2).toNumber(), credit: 0, description: `Retur Penjualan: ${returnNumber}` },
  ];
  const taxAmountNum = taxAmount.toNumber();
  if (taxAmountNum > 0) {
    const taxOutputAccount = await systemAccounts.getAccount('TAX_OUTPUT');
    jeItems.push({ accountId: taxOutputAccount.id, debit: taxAmountNum, credit: 0, description: `PPN Keluaran (retur): ${returnNumber}` });
  }
  if (arReduceNum > 0) {
    jeItems.push({ accountId: arAccount.id, partyId: invoice.partyId, debit: 0, credit: arReduceNum, description: `Pengurang Piutang (retur): ${returnNumber}` });
  }
  if (creditPortionNum > 0) {
    jeItems.push({ accountId: customerDepositAccount.id, partyId: invoice.partyId, debit: 0, credit: creditPortionNum, description: `Kredit pelanggan dari retur: ${returnNumber}` });
  }

  const jvNumber = `JV-${returnNumber}`;
  const journalEntry = await tx.journalEntry.create({
    data: {
      entryNumber: jvNumber,
      date: parsedDate,
      narration: `Retur Penjualan: ${returnNumber} - ${invoice.customer.name}`,
      status: 'Submitted',
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
      items: { create: jeItems.map((j) => ({ accountId: j.accountId, partyId: j.partyId, debit: j.debit, credit: j.credit, description: j.description })) },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: jeItems.map((j) => ({
      date: parsedDate, accountId: j.accountId, partyId: j.partyId, debit: j.debit, credit: j.credit,
      referenceType: 'JournalEntry', referenceId: journalEntry.id, description: j.description, fiscalYearId: fiscalYear.id,
    })),
  });
  // The account balances of this journal are updated after the restock loop below: postInbound
  // takes SM numbers, and the JV number of a negative-stock settlement (E3-R9), which come before
  // account row locks (LOCK ORDER of stockLocks.ts, step 3 before step 4).

  // Reduce invoice outstanding by the AR portion; a full return leaves the invoice Paid.
  if (arReduceNum > 0) {
    await setSalesInvoiceOutstandingInTx(tx, invoice.id, { delta: arReduce.neg() });
  }
  await recalcPartyOutstanding(tx, invoice.partyId);

  // Credit portion → CustomerDeposit Payment (no own JE; liability already CR'd)
  let customerDepositId: string | null = null;
  if (creditPortionNum > 0) {
    const paymentNumber = await generateDocumentNumber(tx, 'PAY', parsedDate, fiscalYear.id);
    const deposit = await tx.payment.create({
      data: {
        paymentNumber,
        date: parsedDate,
        paymentType: 'CustomerDeposit',
        partyId: invoice.partyId,
        accountId: customerDepositAccount.id,
        amount: creditPortionNum,
        status: 'Submitted',
        referenceNo: returnNumber,
        notes: `Kredit dari Retur Penjualan ${returnNumber} (invoice ${invoice.invoiceNumber})`,
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
      },
    });
    customerDepositId = deposit.id;
    await tx.salesReturn.update({ where: { id: salesReturn.id }, data: { customerDepositId } });
    // Keep the cached deposit balance on the party in sync so the invoice UI
    // can offer 'Gunakan Uang Muka' for credit created by this return.
    await tx.party.update({
      where: { id: invoice.partyId },
      data: { customerDepositBalance: { increment: creditPortionNum } },
    });
  }

  // Stock-in + COGS reversal for restock lines
  const createdReturnItems = await tx.salesReturnItem.findMany({ where: { salesReturnId: salesReturn.id } });
  const returnItemByInvLine = new Map(createdReturnItems.map((ri) => [ri.salesInvoiceItemId, ri]));

  let totalCogsReversal = new Decimal(0);
  const cogsCreditByAccount = new Map<string, { amount: Decimal; names: string[] }>();

  for (const r of resolved) {
    if (!r.restock || !r.inventoryItemId) continue;
    const ri = returnItemByInvLine.get(r.salesInvoiceItemId);
    const invItem = invoice.items.find((i) => i.id === r.salesInvoiceItemId)!.inventoryItem;
    const acctId = invItem ? await inventoryAccountFor(tx, invItem) : null;
    if (!acctId) throw new BusinessError('Akun Persediaan belum dipetakan di Akun Sistem.');

    // In through the value ledger at the line's value: it blends into the average (E3-R7), and the
    // COGS reversal below debits the same amount to the item's inventory account (book = GL).
    const { movement } = await postInbound(tx, {
      movementType: 'In',
      itemId: r.inventoryItemId,
      warehouseId: r.warehouseId!,
      quantity: r.quantity,
      value: r.value,
      date: parsedDate,
      fiscalYearId: fiscalYear.id,
      createdById: userId,
      referenceType: 'SalesReturn',
      referenceId: salesReturn.id,
      referenceNumber: returnNumber,
      // The COGS reversal journal credits HPP for every valued restock line.
      offsetAccountId: cogsAccount.id,
    });
    if (ri) {
      await tx.salesReturnItem.update({ where: { id: ri.id }, data: { stockMovementId: movement.id } });
    }

    if (r.value.gt(0)) {
      totalCogsReversal = totalCogsReversal.plus(r.value);
      const ex = cogsCreditByAccount.get(acctId);
      if (ex) { ex.amount = ex.amount.plus(r.value); ex.names.push(r.itemName); }
      else cogsCreditByAccount.set(acctId, { amount: r.value, names: [r.itemName] });
    }
  }

  for (const j of jeItems) {
    await updateAccountBalance(tx, j.accountId, j.debit, j.credit);
  }

  // COGS reversal JE: DR Persediaan / CR HPP
  const totalCogsNum = totalCogsReversal.toDecimalPlaces(2).toNumber();
  if (totalCogsNum > 0) {
    const cogsJv = `JV-COGS-${returnNumber}`;
    const cogsItems: Array<{ accountId: string; debit: number; credit: number; description: string }> = [];
    for (const [acctId, data] of cogsCreditByAccount) {
      cogsItems.push({ accountId: acctId, debit: data.amount.toNumber(), credit: 0, description: `Persediaan masuk (retur) ${data.names.join(', ')}: ${returnNumber}` });
    }
    cogsItems.push({ accountId: cogsAccount.id, debit: 0, credit: totalCogsNum, description: `Balik HPP (retur): ${returnNumber}` });

    const cogsJournal = await tx.journalEntry.create({
      data: {
        entryNumber: cogsJv,
        date: parsedDate,
        narration: `Balik HPP Retur Penjualan: ${returnNumber} - ${invoice.customer.name}`,
        status: 'Submitted',
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
        items: { create: cogsItems },
      },
    });
    await tx.accountingLedgerEntry.createMany({
      data: cogsItems.map((ji) => ({
        date: parsedDate, accountId: ji.accountId, debit: ji.debit, credit: ji.credit,
        referenceType: 'JournalEntry', referenceId: cogsJournal.id, description: ji.description, fiscalYearId: fiscalYear.id,
      })),
    });
    for (const ji of cogsItems) {
      await updateAccountBalance(tx, ji.accountId, ji.debit, ji.credit);
    }
  }

  logger.info(
    { returnId: salesReturn.id, returnNumber, invoice: invoice.invoiceNumber, totalReturn: totalReturnNum, arReduce: arReduceNum, credit: creditPortionNum, cogsReversal: totalCogsNum },
    'Sales return submitted',
  );

  return tx.salesReturn.findUnique({
    where: { id: salesReturn.id },
    include: { customer: true, items: true, salesInvoice: { select: { invoiceNumber: true } } },
  });
}
