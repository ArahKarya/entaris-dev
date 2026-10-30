import { BusinessError } from './errors';
import { STALE_STATUS_ERROR } from '../services/paymentRequestRules';

/** Error code: a concurrent request (double click, AIRA retry) already cancelled the document. */
export const STALE_STATUS = 'STALE_STATUS';

/** Who cancelled a document and why; stored as cancelled_by_id / cancel_reason. */
export interface CancelTrail {
  cancelledById: string;
  cancelReason: string | null;
}

/** The trail for a user-initiated cancel; a blank reason is stored as null. */
export function cancelTrail(userId: string, reason?: string | null): CancelTrail {
  const trimmed = reason?.trim();
  return { cancelledById: userId, cancelReason: trimmed ? trimmed : null };
}

/** Trail columns for an update; none when the void is not a user action. */
export function cancelTrailData(trail: CancelTrail | undefined): Partial<CancelTrail> {
  return trail ? { cancelledById: trail.cancelledById, cancelReason: trail.cancelReason } : {};
}

/** The cancelled state the claim writes: a status value, or the isCancelled flag. */
type CancelledState = { status: string } | { isCancelled: true };

/** Matches the row only while it does not hold the cancelled state `D` yet. */
type ClaimWhere<D> = D extends { status: infer S }
  ? { id: string; status: { not: S } }
  : { id: string; isCancelled: false };

/** A Prisma model delegate on the transaction, e.g. `tx.payment`. */
interface ClaimDelegate<D> {
  updateMany: (args: { where: ClaimWhere<D>; data: D }) => PromiseLike<{ count: number }>;
}

/**
 * Writes `data` only while the row is not cancelled yet: `status` other than the value being
 * written, or `isCancelled` still false. Postgres re-checks that filter after waiting for the row
 * lock, so of two concurrent cancels exactly one gets count 1. Returns false when the row was
 * already cancelled (or is missing).
 */
export async function tryClaimCancel<const D extends CancelledState>(
  delegate: ClaimDelegate<NoInfer<D>>,
  id: string,
  data: D,
): Promise<boolean> {
  const where = ('isCancelled' in data ? { id, isCancelled: false } : { id, status: { not: data.status } }) as ClaimWhere<D>;
  const claimed = await delegate.updateMany({ where, data });
  return claimed.count === 1;
}

/**
 * tryClaimCancel as the first write of a cancel transaction: the loser of a race gets 400
 * STALE_STATUS before any balance, stock or journal moves, instead of reversing them a second time.
 */
export async function claimCancel<const D extends CancelledState>(
  delegate: ClaimDelegate<NoInfer<D>>,
  id: string,
  data: D,
): Promise<void> {
  if (!(await tryClaimCancel(delegate, id, data))) {
    throw new BusinessError(STALE_STATUS_ERROR, STALE_STATUS);
  }
}
