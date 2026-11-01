// Atomic claim of an approval decision (E7-R1). The claim is the first write of the decision's
// transaction: `updateMany` filtered on the exact from-status, so a second decision that read the
// same Pending row waits for the row lock, re-evaluates the filter after the first commits, finds
// nothing and fails before any document, stock or journal moves.

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { STALE_STATUS } from '../utils/cancelClaim';

type Tx = Prisma.TransactionClient;

export const APPROVAL_ALREADY_DECIDED = 'Pengajuan sudah diproses.';

// A decision that waited on the row lock longer than its own transaction allows.
export const APPROVAL_BUSY = 'APPROVAL_BUSY';
export const APPROVAL_BUSY_MESSAGE = 'Pengajuan sedang diproses, coba lagi.';

export interface ApprovalDecisionClaim {
  status: 'Approved' | 'Rejected' | 'NeedsRevision';
  approvedBy?: string;
  rejectedBy?: string;
  notes?: string;
  decidedAt: Date;
}

/**
 * Moves the request from `from` to the decided status, or throws STALE_STATUS when another
 * decision got there first. Not `{ not: <target> }` like claimCancel: that would let a Rejected
 * request become Approved. `from` stays a parameter for decisions out of other statuses.
 */
export async function claimApprovalDecision(
  tx: Tx,
  id: string,
  data: ApprovalDecisionClaim,
  from = 'Pending',
): Promise<void> {
  const res = await tx.approvalRequest.updateMany({ where: { id, status: from }, data });
  if (res.count !== 1) throw new BusinessError(APPROVAL_ALREADY_DECIDED, STALE_STATUS);
}

/**
 * Prisma's interactive-transaction error (P2028): the transaction timed out or could not start,
 * typically while waiting on the request row another decision holds.
 */
export function isTransactionBusyError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2028';
}
