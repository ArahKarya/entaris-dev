import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { assertBatchSource, MOVEMENT_SOURCE_BATCH_INVALID } from '../batchSource';

type Batch = { id: string; itemId: string; isCancelled: boolean; movementType: string; unitCost: number };

const txWith = (batch: Batch | null) =>
  ({ stockMovement: { findUnique: async () => batch } }) as unknown as Prisma.TransactionClient;

const good: Batch = { id: 'sm-1', itemId: 'gkp', isCancelled: false, movementType: 'In', unitCost: 6000 };
const named = { sourceMovementId: 'sm-1', inventoryItemId: 'gkp', itemName: 'GKP' };
const byLine = { ...named, inputLine: 2 };

async function errorOf(batch: Batch | null, input: typeof named & { inputLine?: number }) {
  try {
    await assertBatchSource(txWith(batch), input);
  } catch (e) {
    return e as { message: string; code?: string };
  }
  throw new Error('expected assertBatchSource to throw');
}

describe('assertBatchSource', () => {
  it('returns the batch id and unit cost of an active inbound movement of the item', async () => {
    for (const movementType of ['In', 'AdjustmentIn', 'TransferIn']) {
      await expect(assertBatchSource(txWith({ ...good, movementType }), named)).resolves.toEqual({ id: 'sm-1', unitCost: 6000 });
    }
  });

  it.each([
    ['missing', null, 'Batch sumber tidak ditemukan untuk item "GKP".', 'Batch sumber tidak ditemukan untuk input ke-2.'],
    ['another item', { ...good, itemId: 'beras' }, 'Batch sumber tidak cocok dengan item "GKP".', 'Batch sumber tidak cocok dengan item input ke-2.'],
    ['cancelled', { ...good, isCancelled: true }, 'Batch sumber "GKP" sudah dibatalkan.', 'Batch sumber sudah dibatalkan (input ke-2).'],
    ['outbound', { ...good, movementType: 'Out' }, 'Batch sumber untuk "GKP" bukan stok masuk.', 'Batch sumber bukan stok masuk (input ke-2).'],
  ])('rejects a %s batch, naming the item or the production input line', async (_case, batch, byItem, byInputLine) => {
    expect(await errorOf(batch, named)).toMatchObject({ message: byItem, code: MOVEMENT_SOURCE_BATCH_INVALID });
    expect(await errorOf(batch, byLine)).toMatchObject({ message: byInputLine, code: MOVEMENT_SOURCE_BATCH_INVALID });
  });
});
