import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { cancelTrail } from '../utils/cancelClaim';
import { assertPeriodsOpen } from '../utils/periodGuard';
import { reverseProductionEffectsInTx } from './production/productionPosting';

type Tx = Prisma.TransactionClient;

interface CancelOptions {
  /** When true, skip the "stock cukup untuk dibalikin" guard. Used by Admin
   *  override route — logs a warning instead of throwing. */
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
  /** The user cancelling the run, stored with `reason` on each voided journal. */
  userId?: string;
  reason?: string | null;
}

/**
 * Cancel a production run: undo its effects through the production posting module (stock
 * movements reversed, WAC replayed, journals JV-<runNumber> and its revisions voided through the
 * E1 cancel model with balances reversed per line, COGS auto-settlements reversed).
 */
export async function cancelProductionRunInTx(
  tx: Tx,
  runId: string,
  opts: CancelOptions = {},
): Promise<void> {
  const run = await tx.productionRun.findUnique({ where: { id: runId } });
  if (!run) throw new BusinessError('Data proses produksi tidak ditemukan.');
  if (run.isCancelled) throw new BusinessError('Proses produksi sudah dibatalkan.');
  // Its journals and auto-settle journals check their own years when voided; this covers the run.
  await assertPeriodsOpen(tx, [{ date: run.date }, { fiscalYearId: run.fiscalYearId, date: run.date }], 'produksi');

  await reverseProductionEffectsInTx(tx, { id: runId, runNumber: run.runNumber }, {
    mode: 'cancel',
    allowNegativeStock: opts.allowNegativeStock,
    negativeStockReason: opts.negativeStockReason,
    trail: opts.userId ? cancelTrail(opts.userId, opts.reason) : undefined,
  });

  await tx.productionRun.update({
    where: { id: runId },
    data: { isCancelled: true },
  });
}
