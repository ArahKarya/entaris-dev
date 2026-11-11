import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { assertPeriodsOpen } from '../utils/periodGuard';
import { claimCancel } from '../utils/cancelClaim';
import { logger } from '../lib/logger';
import { assertStockAvailable, lockInventoryRows } from './inventory/stockLocks';

type Tx = Prisma.TransactionClient;

/** Error code: the destination warehouse no longer holds the transferred stock. */
export const STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK = 'TRANSFER_CANCEL_INSUFFICIENT_STOCK';
/** Error code: an active movement picked a TransferIn batch of this transfer (sourceMovementId). */
export const STOCK_TRANSFER_CANCEL_BATCH_USED = 'TRANSFER_CANCEL_BATCH_USED';
/** Some of the transfer's movements were cancelled per row (before E3-R2); the route answers 409. */
export const STOCK_TRANSFER_CANCEL_INCOMPLETE = 'TRANSFER_CANCEL_INCOMPLETE';

export interface CancelStockTransferOptions {
  /** Let the destination go negative; the route requires inventory.negative_stock and a reason. */
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
}

export interface SubmitStockTransferInput {
  date: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  notes?: string | null;
  nomorMobil?: string | null;
  driverName?: string | null;
  recipientName?: string | null;
  items: Array<{
    itemId: string;
    quantity: number;
    description?: string | null;
    // Optional batch picker: the TransferOut links to this inbound batch and locks its unitCost.
    sourceMovementId?: string | null;
  }>;
}

/**
 * Submit a stock transfer: paired TransferOut/TransferIn movements with no GL impact (same
 * account, net zero); inventory_items.current_stock (total across warehouses) is unchanged.
 */
export async function submitStockTransferInTx(
  tx: Tx,
  body: SubmitStockTransferInput,
  userId: string,
) {
  const date = new Date(body.date);
  if (isNaN(date.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  if (body.fromWarehouseId === body.toWarehouseId) {
    throw new BusinessError('Gudang sumber dan tujuan tidak boleh sama.');
  }

  const fy = await getOpenFiscalYear(tx, date);
  const transferNumber = await generateDocumentNumber(tx, 'ST', date, fy.id);

  const fromWh = await tx.warehouse.findUnique({ where: { id: body.fromWarehouseId } });
  const toWh = await tx.warehouse.findUnique({ where: { id: body.toWarehouseId } });
  if (!fromWh || !toWh) throw new BusinessError('Gudang tidak ditemukan.');
  if (!fromWh.isActive || !toWh.isActive) {
    throw new BusinessError('Gudang sumber/tujuan tidak aktif.');
  }

  // Lock every item at both warehouses, then check the source per item: two lines of one item
  // are summed, and a concurrent outbound of the same stock waits for this transfer.
  const locked = await lockInventoryRows(tx, {
    itemIds: body.items.map((it) => it.itemId),
    pairs: body.items.flatMap((it) => [
      { itemId: it.itemId, warehouseId: body.fromWarehouseId },
      { itemId: it.itemId, warehouseId: body.toWarehouseId },
    ]),
  });
  const missing = body.items.find((it) => !locked.items.has(it.itemId));
  if (missing) throw new BusinessError('Item tidak ditemukan.');
  await assertStockAvailable(
    tx,
    body.items.map((it) => ({ itemId: it.itemId, warehouseId: body.fromWarehouseId, quantity: it.quantity })),
    { context: 'stockTransfer.create', userId },
  );

  const transfer = await tx.stockTransfer.create({
    data: {
      transferNumber,
      date,
      fromWarehouseId: body.fromWarehouseId,
      toWarehouseId: body.toWarehouseId,
      status: 'Submitted',
      notes: body.notes || null,
      nomorMobil: body.nomorMobil ?? null,
      driverName: body.driverName ?? null,
      recipientName: body.recipientName ?? null,
      fiscalYearId: fy.id,
      createdBy: userId,
      submittedAt: new Date(),
      items: {
        create: body.items.map((it) => ({
          itemId: it.itemId,
          quantity: it.quantity,
          description: it.description || null,
          sourceMovementId: it.sourceMovementId || null,
        })),
      },
    },
    include: { items: true },
  });

  // Adjust stocks + create paired movements per line.
  for (const it of body.items) {
    const item = locked.items.get(it.itemId)!;
    const qty = it.quantity;
    // A picked batch locks unitCost to its stored cost so the batch consumption ledger stays consistent.
    let unitCost = item.averageCost.toNumber();
    if (it.sourceMovementId) {
      const batch = await tx.stockMovement.findUnique({
        where: { id: it.sourceMovementId },
        select: { id: true, itemId: true, isCancelled: true, movementType: true, unitCost: true },
      });
      if (!batch) throw new BusinessError(`Batch sumber tidak ditemukan untuk item "${item.name}".`);
      if (batch.itemId !== item.id) throw new BusinessError(`Batch sumber tidak cocok dengan item "${item.name}".`);
      if (batch.isCancelled) throw new BusinessError(`Batch sumber "${item.name}" sudah dibatalkan.`);
      if (batch.movementType !== 'In' && batch.movementType !== 'AdjustmentIn' && batch.movementType !== 'TransferIn') {
        throw new BusinessError(`Batch sumber untuk "${item.name}" bukan stok masuk.`);
      }
      unitCost = Number(batch.unitCost);
    }
    const totalValue = qty * unitCost;

    await tx.inventoryStock.upsert({
      where: { itemId_warehouseId: { itemId: it.itemId, warehouseId: body.fromWarehouseId } },
      create: { itemId: it.itemId, warehouseId: body.fromWarehouseId, currentStock: -qty },
      update: { currentStock: { decrement: qty } },
    });
    await tx.inventoryStock.upsert({
      where: { itemId_warehouseId: { itemId: it.itemId, warehouseId: body.toWarehouseId } },
      create: { itemId: it.itemId, warehouseId: body.toWarehouseId, currentStock: qty },
      update: { currentStock: { increment: qty } },
    });

    const smOutNo = await generateDocumentNumber(tx, 'SM', date, fy.id);
    const smOut = await tx.stockMovement.create({
      data: {
        movementNumber: smOutNo,
        date,
        itemId: it.itemId,
        warehouseId: body.fromWarehouseId,
        movementType: 'TransferOut',
        quantity: qty,
        unitCost,
        totalValue,
        // Batch back-link for the batch consumption ledger
        sourceMovementId: it.sourceMovementId || null,
        notes: `Transfer ke ${toWh.name}`,
        referenceType: 'StockTransfer',
        referenceId: transfer.id,
        referenceNumber: transferNumber,
        fiscalYearId: fy.id,
        createdById: userId,
      },
    });
    const smInNo = await generateDocumentNumber(tx, 'SM', date, fy.id);
    await tx.stockMovement.create({
      data: {
        movementNumber: smInNo,
        date,
        itemId: it.itemId,
        warehouseId: body.toWarehouseId,
        movementType: 'TransferIn',
        quantity: qty,
        unitCost,
        totalValue,
        notes: `Transfer dari ${fromWh.name} (ref: ${smOut.movementNumber})`,
        referenceType: 'StockTransfer',
        referenceId: transfer.id,
        referenceNumber: transferNumber,
        fiscalYearId: fy.id,
        createdById: userId,
      },
    });
  }

  logger.info({ transferNumber, items: body.items.length }, 'Stock transfer submitted');
  return transfer;
}

/**
 * Reverse a submitted stock transfer: restore both warehouses and cancel the paired movements.
 * Rejected when a TransferIn batch is already consumed, or when the destination no longer holds
 * the stock (unless opts.allowNegativeStock).
 */
export async function cancelStockTransferInTx(
  tx: Tx,
  transferId: string,
  opts: CancelStockTransferOptions = {},
) {
  // Row lock: a second concurrent cancel waits here, then sees status Cancelled, so the stock
  // checks below never run against a reversal that is about to commit.
  await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${transferId} FOR UPDATE`;
  const transfer = await tx.stockTransfer.findUnique({
    where: { id: transferId },
    include: { items: true },
  });
  if (!transfer) throw new BusinessError('Transfer tidak ditemukan.');
  if (transfer.status === 'Cancelled') throw new BusinessError('Transfer sudah dibatalkan.');
  // First write; any rejection below rolls it back.
  await claimCancel(tx.stockTransfer, transferId, { status: 'Cancelled', cancelledAt: new Date() });
  await assertPeriodsOpen(tx, [{ date: transfer.date }, { fiscalYearId: transfer.fiscalYearId, date: transfer.date }], 'transfer stok');

  // The reversal works from the active movements, never from transfer.items: a movement that was
  // cancelled per row (possible before E3-R2) has already moved stock. Each line owns one TransferOut
  // and one TransferIn; when any is missing the result would be a guess, so the cancel is refused
  // and the accountant corrects stock with an adjustment (e3-movement-reference-audit lists them).
  const active = await tx.stockMovement.findMany({
    where: { referenceType: 'StockTransfer', referenceId: transferId, isCancelled: false },
    select: { id: true, itemId: true, warehouseId: true, movementType: true, quantity: true },
  });
  const transferOuts = active.filter((m) => m.movementType === 'TransferOut');
  const transferIns = active.filter((m) => m.movementType === 'TransferIn');
  const expected = transfer.items.length * 2;
  if (transferOuts.length !== transfer.items.length || transferIns.length !== transfer.items.length) {
    throw new BusinessError(
      `Tidak dapat membatalkan transfer ${transfer.transferNumber}: hanya ${transferOuts.length + transferIns.length} dari ${expected} gerakan stok transfer ini yang masih aktif. ` +
        'Sebagian pernah dibatalkan per baris; koreksi stok gudang lewat Penyesuaian Stok.',
      STOCK_TRANSFER_CANCEL_INCOMPLETE,
    );
  }

  // Block when an outbound movement picked one of the TransferIn batches; cancelling would
  // orphan its cost basis. Same rule as STT cancel; not covered by the negative-stock bypass.
  if (transferIns.length > 0) {
    const consumers = await tx.stockMovement.findMany({
      where: { sourceMovementId: { in: transferIns.map((m) => m.id) }, isCancelled: false },
      select: { movementNumber: true, referenceNumber: true },
      take: 5,
    });
    if (consumers.length > 0) {
      const ref = consumers.map((c) => c.referenceNumber || c.movementNumber).join(', ');
      throw new BusinessError(
        `Tidak dapat membatalkan transfer ${transfer.transferNumber}: barang yang diterima di gudang tujuan sudah dipakai di transaksi lain (${ref}). ` +
          'Batalkan transaksi tersebut terlebih dahulu.',
        STOCK_TRANSFER_CANCEL_BATCH_USED,
      );
    }
  }

  // Lock the items at both warehouses; the destination must still hold what it received (per item,
  // active TransferIn rows summed).
  await lockInventoryRows(tx, {
    itemIds: active.map((m) => m.itemId),
    pairs: active.flatMap((m) => [
      { itemId: m.itemId, warehouseId: transfer.fromWarehouseId },
      { itemId: m.itemId, warehouseId: transfer.toWarehouseId },
    ]),
  });
  await assertStockAvailable(
    tx,
    transferIns.map((m) => ({ itemId: m.itemId, warehouseId: transfer.toWarehouseId, quantity: m.quantity.toString() })),
    {
      context: 'stockTransfer.cancel',
      allowNegative: opts.allowNegativeStock,
      reason: opts.negativeStockReason,
      error: (s) => new BusinessError(
        `Tidak dapat membatalkan transfer ${transfer.transferNumber}: stok '${s.itemName}' di ${s.warehouseName} hanya ${s.available.toFixed(3)} ${s.unit}, perlu ${s.needed.toFixed(3)}. ` +
          'Barang sudah keluar dari gudang tujuan. Batalkan transaksi tersebut dulu.',
        STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK,
      ),
    },
  );

  // TransferOut returns to the source, TransferIn leaves the destination. Upsert: with the bypass
  // the destination row may be missing.
  for (const m of active) {
    const qty = Number(m.quantity);
    const out = m.movementType === 'TransferOut';
    const warehouseId = out ? transfer.fromWarehouseId : transfer.toWarehouseId;
    await tx.inventoryStock.upsert({
      where: { itemId_warehouseId: { itemId: m.itemId, warehouseId } },
      create: { itemId: m.itemId, warehouseId, currentStock: out ? qty : -qty },
      update: { currentStock: { increment: out ? qty : -qty } },
    });
  }

  await tx.stockMovement.updateMany({
    where: { id: { in: active.map((m) => m.id) }, isCancelled: false },
    data: { isCancelled: true },
  });

  return tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId } });
}
