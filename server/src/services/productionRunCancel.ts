import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { assertPeriodsOpen } from '../utils/periodGuard';
import { lockProductionStockInTx, reverseProductionEffectsInTx } from './production/productionPosting';

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
 * E1 cancel model with balances reversed per line, COGS auto-settlements reversed). The cancel
 * claim is the first write, so of two concurrent cancels the second gets STALE_STATUS and reverses
 * nothing; an edit of the same run waits on it (the edit locks the run row) and then refuses.
 */
export async function cancelProductionRunInTx(
  tx: Tx,
  runId: string,
  opts: CancelOptions = {},
): Promise<void> {
  const run = await tx.productionRun.findUnique({ where: { id: runId } });
  if (!run) throw new BusinessError('Data proses produksi tidak ditemukan.');
  if (run.isCancelled) throw new BusinessError('Proses produksi sudah dibatalkan.');
  await claimCancel(tx.productionRun, runId, { isCancelled: true });
  // Its journals and auto-settle journals check their own years when voided; this covers the run.
  await assertPeriodsOpen(tx, [{ date: run.date }, { fiscalYearId: run.fiscalYearId, date: run.date }], 'produksi');

  // Lock order: the claim above, then the items of the run's movements, then the journals.
  await lockProductionStockInTx(tx, { runId });
  await reverseProductionEffectsInTx(tx, { id: runId, runNumber: run.runNumber }, {
    mode: 'cancel',
    allowNegativeStock: opts.allowNegativeStock,
    negativeStockReason: opts.negativeStockReason,
    userId: opts.userId,
    trail: opts.userId ? cancelTrail(opts.userId, opts.reason) : undefined,
  });
}
