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
 * movements taken back at their values through the value ledger, journals JV-<runNumber> and its revisions voided through the
 * E1 cancel model with balances reversed per line, COGS auto-settlements reversed). The cancel
 * claim is the first write, so of two concurrent cancels the second gets STALE_STATUS and reverses
 * nothing; an edit of the same run waits on it (the edit locks the run row) and then refuses.
 */
export async function cancelProductionRunInTx(
  tx: Tx,
  runId: string,
  opts: CancelOptions = {},
): Promise<void> {
  const run = await tx.productionRun.findUnique({ where: { id: runId }, select: { isCancelled: true } });
  if (!run) throw new BusinessError('Data proses produksi tidak ditemukan.');
  if (run.isCancelled) throw new BusinessError('Proses produksi sudah dibatalkan.');
  await claimCancel(tx.productionRun, runId, { isCancelled: true });
  // Re-read under the claim: the claim may have waited on an edit that moved the run's date and
  // fiscal year, and the period check must cover the run as it now stands.
  const claimed = await tx.productionRun.findUniqueOrThrow({ where: { id: runId } });
  // Its journals and auto-settle journals check their own years when voided; this covers the run.
  await assertPeriodsOpen(tx, [{ date: claimed.date }, { fiscalYearId: claimed.fiscalYearId, date: claimed.date }], 'produksi');

  // Lock order: the claim above, then the items of the run's movements, then the journals.
  await lockProductionStockInTx(tx, { runId });
  await reverseProductionEffectsInTx(tx, { id: runId, runNumber: claimed.runNumber }, {
    mode: 'cancel',
    allowNegativeStock: opts.allowNegativeStock,
    negativeStockReason: opts.negativeStockReason,
    // The ledger reversal records a user; a caller that names none (the route always does) is
    // attributed to the run's creator.
    userId: opts.userId ?? claimed.createdById,
    trail: opts.userId ? cancelTrail(opts.userId, opts.reason) : undefined,
  });
}
