import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';

type Tx = Prisma.TransactionClient;

export const MOVEMENT_SOURCE_BATCH_INVALID = 'MOVEMENT_SOURCE_BATCH_INVALID';

const INBOUND_BATCH_TYPES = new Set(['In', 'AdjustmentIn', 'TransferIn']);

/**
 * The batch an outbound movement consumes from must be an active inbound movement of the same
 * item; anything else skews batch availability and blocks cancelling an unrelated receipt.
 * The warehouse is not checked, as in the production and transfer batch pickers.
 * Production and transfer still keep their own copies of this rule (E6-R1 / E3-PR4 move them here).
 */
export async function assertBatchSource(
  tx: Tx,
  input: { sourceMovementId: string; inventoryItemId: string; itemName: string },
): Promise<{ id: string; unitCost: Prisma.Decimal }> {
  const batch = await tx.stockMovement.findUnique({
    where: { id: input.sourceMovementId },
    select: { id: true, itemId: true, isCancelled: true, movementType: true, unitCost: true },
  });
  const name = input.itemName;
  if (!batch) throw new BusinessError(`Batch sumber tidak ditemukan untuk item "${name}".`, MOVEMENT_SOURCE_BATCH_INVALID);
  if (batch.itemId !== input.inventoryItemId) {
    throw new BusinessError(`Batch sumber tidak cocok dengan item "${name}".`, MOVEMENT_SOURCE_BATCH_INVALID);
  }
  if (batch.isCancelled) throw new BusinessError(`Batch sumber "${name}" sudah dibatalkan.`, MOVEMENT_SOURCE_BATCH_INVALID);
  if (!INBOUND_BATCH_TYPES.has(batch.movementType)) {
    throw new BusinessError(`Batch sumber untuk "${name}" bukan stok masuk.`, MOVEMENT_SOURCE_BATCH_INVALID);
  }
  return { id: batch.id, unitCost: batch.unitCost };
}
