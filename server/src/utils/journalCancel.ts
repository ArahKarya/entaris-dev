import { Prisma } from '@prisma/client';
import { updateAccountBalance } from './accountBalance';
import { journalFamilyWhere } from './journalFamily';
import { assertPeriodOpen, type PeriodLabel } from './periodGuard';
import { cancelTrailData, tryClaimCancel, type CancelTrail } from './cancelClaim';

type Tx = Prisma.TransactionClient;
type JournalWithItems = Prisma.JournalEntryGetPayload<{ include: { items: true } }>;

/**
 * Void one journal in place: status Cancelled, its ledger entries isCancelled, account balances
 * reversed per journal item. Never adds a reversal journal; mirrored [BATAL] rows next to live
 * originals would double ALE totals and break the ALE vs JournalItem health check.
 *
 * Throws PERIOD_CLOSED when the journal's own fiscal year is closed, even when the journal is
 * already cancelled, so satellites, auto-settle and action-dated journals cannot be voided in a
 * closed year through a document that sits in an open one. `label` names the document in the
 * error message. Returns false when the journal was already cancelled.
 *
 * The status flip is a conditional claim on the row, so of two concurrent voids only one
 * reverses the balances; `journal.status` read earlier by the caller may be stale. `trail` (the
 * user and reason of a user-initiated cancel) is stored on the journal; system voids omit it.
 */
export async function voidJournalInTx(
  tx: Tx,
  journal: JournalWithItems,
  label: PeriodLabel = 'jurnal',
  trail?: CancelTrail,
): Promise<boolean> {
  await assertPeriodOpen(tx, { fiscalYearId: journal.fiscalYearId, date: journal.date }, label);
  if (journal.status === 'Cancelled') return false;

  const claimed = await tryClaimCancel(tx.journalEntry, journal.id, {
    status: 'Cancelled',
    cancelledAt: new Date(),
    ...cancelTrailData(trail),
  });
  if (!claimed) return false;
  await tx.accountingLedgerEntry.updateMany({
    where: { referenceId: journal.id, isCancelled: false },
    data: { isCancelled: true },
  });
  for (const ji of journal.items) {
    await updateAccountBalance(tx, ji.accountId, ji.credit, ji.debit);
  }
  return true;
}

/**
 * voidJournalInTx by id. A missing journal is a no-op (returns false), like an already
 * cancelled one; documents whose journal was never posted still cancel.
 */
export async function voidJournalByIdInTx(
  tx: Tx,
  journalEntryId: string,
  label: PeriodLabel = 'jurnal',
  trail?: CancelTrail,
): Promise<boolean> {
  const journal = await tx.journalEntry.findUnique({
    where: { id: journalEntryId },
    include: { items: true },
  });
  if (!journal) return false;
  return voidJournalInTx(tx, journal, label, trail);
}

/**
 * Cancel every active journal that belongs to a document: the exact numbers in `baseNumbers`
 * plus their satellites `<base>-…` (e.g. JV-SI-202604-0038-CORR, -CORR-PPN, -WAPU). The dash
 * boundary keeps JV-SI-202604-0038 from matching JV-SI-202604-00380. Ledger entries are marked
 * cancelled and account balances reversed per journal item. Each journal's own fiscal year
 * must be open (see voidJournalInTx). `trail` is stored on each voided journal.
 *
 * @returns entry numbers that were cancelled, in posting order
 */
export async function cancelDocumentJournals(
  tx: Tx,
  baseNumbers: string[],
  trail?: CancelTrail,
): Promise<string[]> {
  const journals = await tx.journalEntry.findMany({
    where: {
      status: { not: 'Cancelled' },
      OR: baseNumbers.flatMap((base) => [
        { entryNumber: base },
        { entryNumber: { startsWith: `${base}-` } },
      ]),
    },
    include: { items: true },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });

  for (const journal of journals) {
    await voidJournalInTx(tx, journal, 'jurnal', trail);
  }

  return journals.map((j) => j.entryNumber);
}

/**
 * Cancel ALL active journals of one document: the exact `entryNumberPrefix` and its
 * `<prefix>-…` satellites, along with their ledger entries, and reverse account balances.
 * Each journal's own fiscal year must be open (see voidJournalInTx).
 *
 * This handles revision journals (e.g. JV-PR-202601-0004, -R1, -R2) that are created when a
 * production run or stock opname is edited, without touching JV-PR-202601-00040.
 *
 * @returns number of journals cancelled
 */
export async function cancelJournalsByPrefix(
  tx: Tx,
  entryNumberPrefix: string
): Promise<number> {
  const activeJournals = await tx.journalEntry.findMany({
    where: {
      ...journalFamilyWhere(entryNumberPrefix),
      status: { not: 'Cancelled' },
    },
    include: { items: true },
  });

  for (const journal of activeJournals) {
    await voidJournalInTx(tx, journal);
  }

  return activeJournals.length;
}
