// The one definition of a year-close (CLOSE) journal. A close journal is tagged sourceType FY_CLOSE;
// rows the source backfill has not tagged are recognised by their number, CLOSE-<year name> or
// CLOSE-<year name>-R<n>. Used by routes/fiscalYears.ts (numbering and reopen) and
// services/reports/balanceSheet.ts.
import { JournalSourceType, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Close journals in any status. With `year`: only that year's, by the exact rule of the year close.
 * Without: every journal tagged FY_CLOSE or numbered CLOSE-..., in any year. The year-less rule is
 * wider (any CLOSE- number), which is safe because only the year close issues CLOSE- numbers.
 */
export function closeJournalPredicate(year?: { id: string; name: string }): Prisma.JournalEntryWhereInput {
  if (!year) {
    return { OR: [{ sourceType: JournalSourceType.FY_CLOSE }, { entryNumber: { startsWith: 'CLOSE-' } }] };
  }
  const base = `CLOSE-${year.name}`;
  return {
    fiscalYearId: year.id,
    OR: [{ sourceType: JournalSourceType.FY_CLOSE }, { entryNumber: base }, { entryNumber: { startsWith: `${base}-R` } }],
  };
}

/** Ids of all close journals, any year and status (cancelled ones too: callers filter ledger rows by isCancelled). */
export async function closeJournalIds(db: Tx): Promise<string[]> {
  const rows = await db.journalEntry.findMany({ where: closeJournalPredicate(), select: { id: true } });
  return rows.map((r) => r.id);
}
