// One cancel model for document journals: void in place (G-70 option a). A document cancel calls
// cancelJournalsInTx with its journals; each one is voided by voidJournalInTx: status Cancelled,
// its ledger entries isCancelled, account balances reversed per journal line. No reversal journal
// (`-CXL`, `-REV`) is posted, so the ALE vs JournalItem health check stays green, and a cancel in a
// closed year is rejected (PERIOD_CLOSED) instead of reversed in an open one.
//
// A reverse mode (post a mirrored journal in the open period and set the original's reversedById)
// would plug in here, chosen per journal from a cancellation policy; it does not exist until G-70
// changes. Today reversedById is only set on legacy STT pairs (original + `-CXL`), which are
// already reversed and must not be voided as well.

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { voidJournalInTx } from '../../utils/journalCancel';
import { journalFamilyWhere } from '../../utils/journalFamily';
import type { PeriodGuardOptions, PeriodLabel } from '../../utils/periodGuard';
import type { CancelTrail } from '../../utils/cancelClaim';

type Tx = Prisma.TransactionClient;
export type JournalWithItems = Prisma.JournalEntryGetPayload<{ include: { items: true } }>;

/** The only cancellation policy: void while the journal's year is open, reject when it is closed. */
export const CANCELLATION_POLICY = 'void_or_reject' as const;

/** Error code: the journal already has a reversal journal; voiding it too would undo it twice. */
export const JOURNAL_ALREADY_REVERSED = 'JOURNAL_ALREADY_REVERSED';

export interface CancelJournalsOptions {
  /** Names the document in the PERIOD_CLOSED message. */
  label: PeriodLabel;
  /** User and reason of a user-initiated cancel, stored on each voided journal. */
  trail?: CancelTrail;
  /**
   * Passed to the period guard of each void. { ignoreLock: true } only for the opening balance
   * service with a period.lock holder's reason (owner decision #10); a closed year still refuses.
   */
  periodOptions?: PeriodGuardOptions;
}

/**
 * Voids `journals` in the given order. Every journal is checked for a reversal before any is
 * voided, so a rejection leaves all of them untouched. A journal that is already cancelled is
 * skipped (its year must still be open, see voidJournalInTx).
 *
 * @returns entry numbers of the journals this call voided
 */
export async function cancelJournalsInTx(
  tx: Tx,
  journals: readonly JournalWithItems[],
  { label, trail, periodOptions }: CancelJournalsOptions,
): Promise<string[]> {
  const reversed = journals.find((j) => j.reversedById);
  if (reversed) {
    throw new BusinessError(
      `Jurnal ${reversed.entryNumber} sudah dibalik dengan jurnal lain, jadi tidak dibatalkan lagi. Periksa jurnal pembaliknya di Buku Besar.`,
      JOURNAL_ALREADY_REVERSED,
    );
  }
  const voided: string[] = [];
  for (const journal of journals) {
    if (await voidJournalInTx(tx, journal, label, trail, periodOptions)) voided.push(journal.entryNumber);
  }
  return voided;
}

/** Active journals of a document: `base` and its `<base>-…` satellites, in posting order. */
export function findDocumentJournals(tx: Tx, base: string): Promise<JournalWithItems[]> {
  return tx.journalEntry.findMany({
    where: { ...journalFamilyWhere(base), status: { not: 'Cancelled' } },
    include: { items: true },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });
}
