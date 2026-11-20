import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';

type Tx = Prisma.TransactionClient;

export const MOVEMENT_SOURCE_BATCH_INVALID = 'MOVEMENT_SOURCE_BATCH_INVALID';

const INBOUND_BATCH_TYPES = new Set(['In', 'AdjustmentIn', 'TransferIn']);

/**
 * The batch an outbound movement consumes from must be an active inbound movement of the same
 * item; anything else skews batch availability and blocks cancelling an unrelated receipt.
 * The warehouse is not checked, as in the production and transfer batch pickers.
 * `inputLine` (1-based) names the production input line in the message instead of the item.
 * Transfer still keeps its own copy of this rule (E3-PR4 moves it here).
 */
export async function assertBatchSource(
  tx: Tx,
  input: { sourceMovementId: string; inventoryItemId: string; itemName: string; inputLine?: number },
): Promise<{ id: string; unitCost: Prisma.Decimal }> {
  const batch = await tx.stockMovement.findUnique({
    where: { id: input.sourceMovementId },
    select: { id: true, itemId: true, isCancelled: true, movementType: true, unitCost: true },
  });
  const name = input.itemName;
  const line = input.inputLine;
  const code = MOVEMENT_SOURCE_BATCH_INVALID;
  if (!batch) {
    if (line) throw new BusinessError(`Batch sumber tidak ditemukan untuk input ke-${line}.`, code);
    throw new BusinessError(`Batch sumber tidak ditemukan untuk item "${name}".`, code);
  }
  if (batch.itemId !== input.inventoryItemId) {
    if (line) throw new BusinessError(`Batch sumber tidak cocok dengan item input ke-${line}.`, code);
    throw new BusinessError(`Batch sumber tidak cocok dengan item "${name}".`, code);
  }
  if (batch.isCancelled) {
    if (line) throw new BusinessError(`Batch sumber sudah dibatalkan (input ke-${line}).`, code);
    throw new BusinessError(`Batch sumber "${name}" sudah dibatalkan.`, code);
  }
  if (!INBOUND_BATCH_TYPES.has(batch.movementType)) {
    if (line) throw new BusinessError(`Batch sumber bukan stok masuk (input ke-${line}).`, code);
    throw new BusinessError(`Batch sumber untuk "${name}" bukan stok masuk.`, code);
  }
  return { id: batch.id, unitCost: batch.unitCost };
}
