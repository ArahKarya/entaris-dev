import { unlinkTemporaryNotesFromDoInTx } from './temporaryDeliveryNote';
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { adjustWarehouseStock } from '../utils/warehouseStock';
import { assertPeriodOpen } from '../utils/periodGuard';
import { recomputeDeliveredQtyInTx } from './salesOrderDelivery';
import { logger } from '../lib/logger';
import { claimCancel } from '../utils/cancelClaim';
import { lockInventoryRows } from './inventory/stockLocks';

type Tx = Prisma.TransactionClient;

/**
 * Cancel a submitted delivery order: rejected if already invoiced (cancel the invoice first);
 * restores item and per-warehouse stock. No GL impact. Caller owns the transaction.
 */
export async function cancelDeliveryOrderInTx(
  tx: Tx,
  doId: string,
): Promise<{ id: string; status: 'Cancelled' }> {
  const current = await tx.deliveryOrder.findUnique({ where: { id: doId }, select: { status: true } });
  if (!current) throw new BusinessError('Surat jalan tidak ditemukan.');
  if (current.status === 'Cancelled') {
    throw new BusinessError('Surat jalan sudah dibatalkan.');
  }
  // First write, and before the SO recompute below so the cancelled note's lines drop out of it.
  await claimCancel(tx.deliveryOrder, doId, { status: 'Cancelled', cancelledAt: new Date() });
  // Read again after the claim: an invoice submit that billed the note, or an edit that replaced
  // its lines, committed while the claim waited for the row and must be seen here.
  const deliveryOrder = await tx.deliveryOrder.findUniqueOrThrow({
    where: { id: doId },
    include: {
      items: {
        include: { stockMovement: true },
      },
    },
  });
  if (deliveryOrder.invoiceId) {
    throw new BusinessError('Batalkan invoice terkait dulu sebelum batalkan surat jalan.');
  }
  // By date: the stored fiscal year can be stale after an older edit moved the note.
  await assertPeriodOpen(tx, { date: deliveryOrder.date }, 'surat jalan');

  // Lock the items of the lines being returned (an Out reversal needs no stock check).
  const returning = deliveryOrder.items.filter((line) => line.inventoryItemId && line.stockMovement && !line.stockMovement.isCancelled);
  await lockInventoryRows(tx, {
    itemIds: returning.map((line) => line.inventoryItemId!),
    pairs: returning.flatMap((line) => (line.warehouseId ? [{ itemId: line.inventoryItemId!, warehouseId: line.warehouseId }] : [])),
  });

  for (const line of deliveryOrder.items) {
    if (!line.stockMovementId) continue;

    const sm = line.stockMovement;
    if (!sm || sm.isCancelled) {
      logger.warn(
        { doId, doNumber: deliveryOrder.doNumber, lineId: line.id, stockMovementId: line.stockMovementId },
        'DO cancel: linked stockMovement missing or already cancelled, skipping reversal',
      );
      continue;
    }

    const qty = Number(line.quantity);

    if (line.inventoryItemId) {
      await tx.inventoryItem.update({
        where: { id: line.inventoryItemId },
        data: { currentStock: { increment: qty } },
      });
      await adjustWarehouseStock(tx, line.inventoryItemId, line.warehouseId, qty);
    }

    await tx.stockMovement.update({
      where: { id: sm.id },
      data: { isCancelled: true },
    });
  }

  // Surat Jalan Sementara yang tertaut ke DO ini kembali Terbuka
  await unlinkTemporaryNotesFromDoInTx(tx, doId);

  // Re-derive SO delivered_qty + status from the remaining active DO lines
  // (single source of truth — no fragile per-line decrement).
  if (deliveryOrder.salesOrderId) {
    await recomputeDeliveredQtyInTx(tx, deliveryOrder.salesOrderId);
  }

  logger.info({ doId, doNumber: deliveryOrder.doNumber }, 'Delivery order cancelled');

  return { id: deliveryOrder.id, status: 'Cancelled' };
}
