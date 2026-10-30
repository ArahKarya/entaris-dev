import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { assertPeriodsOpen } from '../utils/periodGuard';
import { logger } from '../lib/logger';

type Tx = Prisma.TransactionClient;

/** Error code: the destination warehouse no longer holds the transferred stock. */
export const STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK = 'TRANSFER_CANCEL_INSUFFICIENT_STOCK';
/** Error code: an active movement picked a TransferIn batch of this transfer (sourceMovementId). */
export const STOCK_TRANSFER_CANCEL_BATCH_USED = 'TRANSFER_CANCEL_BATCH_USED';

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

  // Per-item stock check at source.
  for (const it of body.items) {
    const stockRow = await tx.inventoryStock.findUnique({
      where: { itemId_warehouseId: { itemId: it.itemId, warehouseId: body.fromWarehouseId } },
    });
    const available = stockRow ? new Decimal(stockRow.currentStock.toString()) : new Decimal(0);
    if (available.lt(it.quantity)) {
      const item = await tx.inventoryItem.findUnique({ where: { id: it.itemId } });
      throw new BusinessError(
        `Stok item "${item?.name ?? it.itemId}" di ${fromWh.name} hanya ${available.toFixed(3)} ${item?.unit ?? ''}, tidak cukup untuk transfer ${it.quantity}.`,
      );
    }
  }

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
    const item = await tx.inventoryItem.findUnique({ where: { id: it.itemId } });
    if (!item) throw new BusinessError('Item tidak ditemukan.');
    const qty = it.quantity;
    // A picked batch locks unitCost to its stored cost so the batch consumption ledger stays consistent.
    let unitCost = Number(item.averageCost);
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
  const transfer = await tx.stockTransfer.findUnique({
    where: { id: transferId },
    include: { items: true },
  });
  if (!transfer) throw new BusinessError('Transfer tidak ditemukan.');
  if (transfer.status === 'Cancelled') throw new BusinessError('Transfer sudah dibatalkan.');
  await assertPeriodsOpen(tx, [{ date: transfer.date }, { fiscalYearId: transfer.fiscalYearId }], 'transfer stok');

  // Block when an outbound movement picked one of the TransferIn batches; cancelling would
  // orphan its cost basis. Same rule as STT cancel; not covered by the negative-stock bypass.
  const transferIns = await tx.stockMovement.findMany({
    where: { referenceType: 'StockTransfer', referenceId: transferId, movementType: 'TransferIn', isCancelled: false },
    select: { id: true },
  });
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

  // The destination must still hold what it received (per item, lines summed).
  const qtyByItem = new Map<string, Decimal>();
  for (const ti of transfer.items) {
    qtyByItem.set(ti.itemId, (qtyByItem.get(ti.itemId) ?? new Decimal(0)).plus(ti.quantity.toString()));
  }
  for (const [itemId, qty] of qtyByItem) {
    const stockRow = await tx.inventoryStock.findUnique({
      where: { itemId_warehouseId: { itemId, warehouseId: transfer.toWarehouseId } },
    });
    const available = stockRow ? new Decimal(stockRow.currentStock.toString()) : new Decimal(0);
    if (available.gte(qty)) continue;
    if (!opts.allowNegativeStock) {
      const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { name: true, unit: true } });
      const toWh = await tx.warehouse.findUnique({ where: { id: transfer.toWarehouseId }, select: { name: true } });
      throw new BusinessError(
        `Tidak dapat membatalkan transfer ${transfer.transferNumber}: stok '${item?.name ?? itemId}' di ${toWh?.name ?? transfer.toWarehouseId} hanya ${available.toFixed(3)} ${item?.unit ?? ''}, perlu ${qty.toFixed(3)}. ` +
          'Barang sudah keluar dari gudang tujuan. Batalkan transaksi tersebut dulu.',
        STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK,
      );
    }
    logger.warn(
      { transferId, itemId, available: available.toNumber(), reverseQty: qty.toNumber(), reason: opts.negativeStockReason },
      'Stock transfer cancel with negative stock bypass',
    );
  }

  for (const ti of transfer.items) {
    const qty = Number(ti.quantity);
    await tx.inventoryStock.update({
      where: { itemId_warehouseId: { itemId: ti.itemId, warehouseId: transfer.fromWarehouseId } },
      data: { currentStock: { increment: qty } },
    });
    // Upsert: with the bypass the destination row may be missing.
    await tx.inventoryStock.upsert({
      where: { itemId_warehouseId: { itemId: ti.itemId, warehouseId: transfer.toWarehouseId } },
      create: { itemId: ti.itemId, warehouseId: transfer.toWarehouseId, currentStock: -qty },
      update: { currentStock: { decrement: qty } },
    });
  }

  await tx.stockMovement.updateMany({
    where: { referenceType: 'StockTransfer', referenceId: transferId },
    data: { isCancelled: true },
  });

  return tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: 'Cancelled', cancelledAt: new Date() },
  });
}
