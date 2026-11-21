import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { checkPurchaseOrderReceivable } from './purchaseOrderLifecycle';
import { resolvePoItemLinks } from './purchaseOrderRules';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { lockInventoryRows, type LockedItem } from './inventory/stockLocks';
import { postInbound } from './inventory/inventoryLedger';
import { UNIT_COST_DP } from './inventory/inventoryValueMath';
import { inventoryAccountFor } from './inventory/itemMasterGuard';
import { updateAccountBalance } from '../utils/accountBalance';
import { systemAccounts } from './systemAccounts';
import { logger } from '../lib/logger';

type Tx = Prisma.TransactionClient;

/** Error code (400): a customer-owned STT line into an item that holds goods of the company (owner decision #5). */
export const GR_CUSTOMER_OWNED_OWN_STOCK = 'GR_CUSTOMER_OWNED_OWN_STOCK';

/**
 * Whether the item holds goods of the company: book value, or stock below 0 (own goods went out
 * ahead of a receipt). Customer-owned goods carry no value, so an item that holds only them, or
 * nothing, does not count.
 */
function holdsOwnStock(item: LockedItem): boolean {
  return !item.stockValue.isZero() || item.currentStock.lt(0);
}

/**
 * Until a separate consignment item exists (E3-PR16), customer-owned goods at value 0 would pull the
 * average of the company's own goods down (owner decision #5), so they are refused into such an item.
 */
function customerOwnedIntoOwnStock(itemName: string): BusinessError {
  return new BusinessError(
    `Barang titipan Customer tidak dapat diterima ke item '${itemName}' karena item ini punya stok milik perusahaan. ` +
      'Gunakan item terpisah untuk barang titipan.',
    GR_CUSTOMER_OWNED_OWN_STOCK,
  );
}

export interface SubmitGoodsReceiptInput {
  date: string;
  partyId: string;
  purchaseOrderId?: string | null;
  /** Barang titipan pelanggan (jasa repros/maklon): qty saja, GL nol. */
  isCustomerOwned?: boolean;
  nomorMobil?: string | null;
  driverName?: string | null;
  recipientName?: string | null;
  notes?: string | null;
  items: Array<{
    inventoryItemId: string;
    warehouseId: string;
    itemName: string;
    quantity: number;
    unit: string;
    /** Optional — kalau 0/undefined, service pakai averageCost item saat ini
     * sebagai provisional cost. PI submit nanti yang fix harga aktual. */
    lockedUnitCost?: number;
    description?: string | null;
    purchaseOrderItemId?: string | null;
  }>;
}

/**
 * Submit an STT/BPB: each line posts an In through the value ledger (postInbound) at its line value,
 * linked PO lines get qtyReceived. One JE per STT: DR Persediaan (per inventoryAccountFor) / CR Hutang
 * Belum Tagih (accrual), of the same line values, so book = GL. A customer-owned line comes in at
 * value 0 and is refused into an item that holds own goods (owner decision #5).
 * Caller owns the transaction.
 */
export async function submitGoodsReceiptInTx(
  tx: Tx,
  body: SubmitGoodsReceiptInput,
  userId: string,
) {
  const parsedDate = new Date(body.date);
  if (isNaN(parsedDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');

  const fiscalYear = await getOpenFiscalYear(tx, parsedDate);

  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Supplier tidak ditemukan.');
  if (!party.isActive) throw new BusinessError(`Supplier '${party.name}' tidak aktif.`);
  if (party.partyType !== 'Supplier' && party.partyType !== 'Both') {
    throw new BusinessError(`Party '${party.name}' bukan supplier.`);
  }

  const isCustomerOwned = body.isCustomerOwned === true;
  if (isCustomerOwned && body.purchaseOrderId) {
    throw new BusinessError('STT barang titipan tidak boleh terkait Purchase Order.');
  }

  // PO validation (optional)
  if (body.purchaseOrderId) {
    const po = await tx.purchaseOrder.findUnique({ where: { id: body.purchaseOrderId } });
    if (!po) throw new BusinessError('Purchase Order tidak ditemukan.');
    // Only ordered (Submitted), non-closed POs — Draft / pending approval excluded.
    const receivable = checkPurchaseOrderReceivable(po);
    if (!receivable.ok) throw new BusinessError(receivable.error);
    // PO Khusus: kalau partyId di-set, supplier harus match
    if (po.partyId && po.partyId !== body.partyId) {
      throw new BusinessError(
        'Supplier STT berbeda dengan supplier yang ditetapkan di PO. PO ini khusus untuk supplier lain.',
      );
    }
  }

  // PO set but a line has no PO-line link → auto-match by inventory item (unique candidate only).
  // Without this the header links to the PO yet qtyReceived never moves (silent).
  if (body.purchaseOrderId) {
    const poItems = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId: body.purchaseOrderId },
      select: { id: true, inventoryItemId: true },
    });
    const resolved = resolvePoItemLinks(body.items, poItems, (l) =>
      new BusinessError(
        `Item '${l.itemName}' muncul lebih dari satu kali di PO. Pilih baris PO secara eksplisit (muat ulang baris dari PO).`,
      ),
    );
    body.items.forEach((l, i) => {
      l.purchaseOrderItemId = resolved[i];
    });
  }

  // Each PO-line link must belong to the PO this STT points at; otherwise the
  // receipt would bump qtyReceived on a different PO.
  const linkedPoItemIds = [...new Set(body.items.map((l) => l.purchaseOrderItemId).filter((v): v is string => !!v))];
  if (linkedPoItemIds.length > 0) {
    if (!body.purchaseOrderId) {
      throw new BusinessError('Baris STT terhubung ke baris PO, tetapi PO tidak dipilih.');
    }
    const owned = await tx.purchaseOrderItem.count({
      where: { id: { in: linkedPoItemIds }, purchaseOrderId: body.purchaseOrderId },
    });
    if (owned !== linkedPoItemIds.length) {
      throw new BusinessError('Ada baris STT yang terhubung ke baris PO lain. Pilih ulang PO agar baris dimuat dari PO tersebut.');
    }
  }

  const accruedAcct = await systemAccounts.getAccount('ACCRUED_PAYABLE');

  const sttNumber = await generateDocumentNumber(tx, 'STT', parsedDate, fiscalYear.id);

  const goodsReceipt = await tx.goodsReceipt.create({
    data: {
      sttNumber,
      date: parsedDate,
      partyId: body.partyId,
      purchaseOrderId: body.purchaseOrderId ?? null,
      isCustomerOwned,
      status: 'Submitted',
      notes: body.notes ?? null,
      nomorMobil: body.nomorMobil ?? null,
      driverName: body.driverName ?? null,
      recipientName: body.recipientName ?? null,
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
    },
  });

  // Lock every line's item (and its row at the line warehouse) once, before the first SM number:
  // the reads inside the loop then see the stock and average no concurrent posting can change.
  await lockInventoryRows(tx, {
    itemIds: body.items.map((l) => l.inventoryItemId),
    pairs: body.items.map((l) => ({ itemId: l.inventoryItemId, warehouseId: l.warehouseId })),
  });

  const drByAccount = new Map<string, { amount: Decimal; names: string[] }>();
  let totalCr = new Decimal(0);

  for (const line of body.items) {
    // Read again per line: a line repeating an item sees the book after the earlier line.
    const invItem = (await lockInventoryRows(tx, { itemIds: [line.inventoryItemId] })).items.get(line.inventoryItemId);
    if (!invItem) throw new BusinessError(`Item '${line.itemName}' tidak ditemukan.`);
    if (!invItem.isActive) throw new BusinessError(`Item '${invItem.name}' tidak aktif.`);
    if (isCustomerOwned && holdsOwnStock(invItem)) throw customerOwnedIntoOwnStock(invItem.name);

    const wh = await tx.warehouse.findUnique({ where: { id: line.warehouseId } });
    if (!wh) throw new BusinessError(`Gudang tidak ditemukan untuk '${line.itemName}'.`);

    const qty = new Decimal(line.quantity);
    // Provisional cost, in order: price entered on the STT line → item's current averageCost →
    // linked PO line's estimatedRate. The PI later sets the actual price and posts the variance.
    const provided = Number(line.lockedUnitCost ?? 0);
    let unitCost = new Decimal(0);
    if (!isCustomerOwned) {
      if (provided > 0) unitCost = new Decimal(provided);
      else if (invItem.averageCost.gt(0)) unitCost = invItem.averageCost;
      else if (line.purchaseOrderItemId) {
        const poLine = await tx.purchaseOrderItem.findUnique({
          where: { id: line.purchaseOrderItemId },
          select: { estimatedRate: true },
        });
        if (poLine && Number(poLine.estimatedRate) > 0) unitCost = new Decimal(poLine.estimatedRate.toString());
      }
    }
    unitCost = unitCost.toDecimalPlaces(UNIT_COST_DP);
    // Customer-owned goods are valued at 0 (not our asset), so the JE is skipped (totalCr = 0).

    // Own goods must not come in at cost 0: it dilutes WAC to 0 and later Outs drive the
    // inventory GL balance negative. Customer-owned goods are exempt.
    if (!isCustomerOwned && unitCost.lte(0)) {
      throw new BusinessError(
        `Harga satuan untuk '${invItem.name}' belum ada (item baru, belum pernah ada stok masuk). ` +
          `Isi Harga perkiraan di baris STT, atau tandai STT ini sebagai Barang Titipan Customer ` +
          `bila barang bukan milik perusahaan.`,
      );
    }

    // The line's debit to inventory; the ledger books the same amount (book = GL).
    const totalValue = qty.times(unitCost).toDecimalPlaces(2);
    const acctId = await inventoryAccountFor(tx, invItem);
    if (!acctId) throw new BusinessError('Akun Persediaan belum dipetakan di Akun Sistem.');

    const { movement } = await postInbound(tx, {
      movementType: 'In',
      itemId: invItem.id,
      warehouseId: wh.id,
      quantity: qty,
      value: totalValue,
      date: parsedDate,
      fiscalYearId: fiscalYear.id,
      createdById: userId,
      referenceType: 'GoodsReceipt',
      referenceId: goodsReceipt.id,
      referenceNumber: sttNumber,
      // The STT journal credits Hutang Belum Tagih for every valued line.
      offsetAccountId: accruedAcct.id,
      notes: `Penerimaan barang dari ${party.name} (${sttNumber})`,
    });

    // Create GR item row with SM link
    const grItem = await tx.goodsReceiptItem.create({
      data: {
        goodsReceiptId: goodsReceipt.id,
        inventoryItemId: invItem.id,
        warehouseId: wh.id,
        itemName: line.itemName,
        quantity: qty.toNumber(),
        unit: line.unit,
        lockedUnitCost: unitCost.toString(),
        description: line.description ?? null,
        purchaseOrderItemId: line.purchaseOrderItemId ?? null,
        stockMovementId: movement.id,
      },
    });

    if (line.purchaseOrderItemId) {
      await tx.purchaseOrderItem.update({
        where: { id: line.purchaseOrderItemId },
        data: { qtyReceived: { increment: qty.toNumber() } },
      });
    }

    const existing = drByAccount.get(acctId);
    if (existing) {
      existing.amount = existing.amount.plus(totalValue);
      existing.names.push(line.itemName);
    } else {
      drByAccount.set(acctId, { amount: totalValue, names: [line.itemName] });
    }
    totalCr = totalCr.plus(totalValue);

    logger.info(
      { sttId: goodsReceipt.id, grItemId: grItem.id, smId: movement.id, qty: qty.toNumber(), cost: unitCost.toNumber() },
      'Goods receipt line posted (stock In)',
    );
  }

  // Post single JE for STT: DR Persediaan / CR Hutang Belum Tagih
  if (totalCr.gt(0)) {
    const jvNumber = `JV-${sttNumber}`;
    const items: { accountId: string; partyId: string | null; debit: number; credit: number; description: string }[] = [];

    for (const [acctId, data] of drByAccount) {
      items.push({
        accountId: acctId,
        partyId: null,
        debit: data.amount.toNumber(),
        credit: 0,
        description: `Penerimaan barang (${data.names.join(', ')}): ${sttNumber}`,
      });
    }
    items.push({
      accountId: accruedAcct.id,
      partyId: body.partyId,
      debit: 0,
      credit: totalCr.toNumber(),
      description: `Accrual hutang belum tagih: ${sttNumber} - ${party.name}`,
    });

    const journalEntry = await tx.journalEntry.create({
      data: {
        entryNumber: jvNumber,
        date: parsedDate,
        narration: `Penerimaan barang ${sttNumber} - ${party.name}`,
        status: 'Submitted',
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
        items: { create: items },
      },
    });

    await tx.accountingLedgerEntry.createMany({
      data: items.map((it) => ({
        date: parsedDate,
        accountId: it.accountId,
        partyId: it.partyId,
        debit: it.debit,
        credit: it.credit,
        referenceType: 'JournalEntry',
        referenceId: journalEntry.id,
        description: it.description,
        fiscalYearId: fiscalYear.id,
      })),
    });

    for (const it of items) {
      await updateAccountBalance(tx, it.accountId, it.debit, it.credit);
    }
  }

  logger.info(
    { sttId: goodsReceipt.id, sttNumber, partyId: body.partyId, totalValue: totalCr.toNumber(), lines: body.items.length },
    'Goods receipt submitted',
  );

  return goodsReceipt;
}
