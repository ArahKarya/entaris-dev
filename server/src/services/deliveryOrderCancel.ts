import { unlinkTemporaryNotesFromDoInTx } from './temporaryDeliveryNote';
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { assertPeriodOpen } from '../utils/periodGuard';
import { recomputeDeliveredQtyInTx } from './salesOrderDelivery';
import { logger } from '../lib/logger';
import { claimCancel } from '../utils/cancelClaim';
import { lockInventoryRows } from './inventory/stockLocks';
import { reverseMovement } from './inventory/inventoryLedger';

type Tx = Prisma.TransactionClient;

/**
 * Cancel a submitted delivery order: rejected if already invoiced (cancel the invoice first);
 * each line's Out is taken back exactly through the value ledger (quantity and value). No GL
 * impact: the note has no journal until it is invoiced. Caller owns the transaction.
 */
export async function cancelDeliveryOrderInTx(
  tx: Tx,
  doId: string,
  userId: string,
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

    await reverseMovement(tx, sm.id, { userId });
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
