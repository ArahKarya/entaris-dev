// Per-journal ledger sync for one fiscal year: the journal lines (journal_entry_accounts) of every
// submitted journal against its active ledger rows (accounting_ledger_entries, reference_type
// 'JournalEntry'), account by account. Unlike the global health check (routes/health/checks.ts),
// it takes the caller's transaction and one year, so the year close can run it after FOR UPDATE.
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface AleJournalMismatch {
  journalId: string;
  /** Null when the ledger rows point at a journal that no longer exists. */
  entryNumber: string | null;
  /** Stored date of the journal, or null for a missing journal. */
  date: Date | null;
  /** Journal status (Submitted, Cancelled, Draft) or null for a missing journal. */
  status: string | null;
  /** True when the journal is not in this fiscal year (another year, or gone) and only its ledger rows are tagged with it. */
  otherYear: boolean;
  /** Sum over the journal's accounts of |line debit - ledger debit| + |line credit - ledger credit|. */
  difference: Prisma.Decimal;
}

interface MismatchRow {
  journal_id: string;
  entry_number: string | null;
  date: Date | null;
  status: string | null;
  journal_fy: string | null;
  difference: string;
}

/**
 * Journals of `fiscalYearId` whose lines and ledger rows differ, plus ledger rows tagged with this
 * year whose journal is in another year or gone. Lines count only for Submitted journals, so a
 * cancelled journal with active ledger rows, or a submitted one without them, is a mismatch.
 * Ordered by difference, largest first.
 */
export async function findAleJournalMismatches(tx: Tx, fiscalYearId: string): Promise<AleJournalMismatch[]> {
  const rows = await tx.$queryRaw<MismatchRow[]>`
    WITH fy_journals AS (
      SELECT id, status FROM journal_entries WHERE fiscal_year_id = ${fiscalYearId}
    ),
    lines AS (
      SELECT jea.journal_entry_id AS journal_id, jea.account_id,
             SUM(jea.debit) AS debit, SUM(jea.credit) AS credit
        FROM journal_entry_accounts jea
        JOIN fy_journals j ON j.id = jea.journal_entry_id
       WHERE j.status = 'Submitted'
       GROUP BY jea.journal_entry_id, jea.account_id
    ),
    ledger AS (
      SELECT ale.reference_id AS journal_id, ale.account_id,
             SUM(ale.debit) AS debit, SUM(ale.credit) AS credit
        FROM accounting_ledger_entries ale
       WHERE ale.reference_type = 'JournalEntry'
         AND ale.is_cancelled = false
         AND (ale.fiscal_year_id = ${fiscalYearId} OR ale.reference_id IN (SELECT id FROM fy_journals))
       GROUP BY ale.reference_id, ale.account_id
    ),
    diff AS (
      SELECT COALESCE(l.journal_id, g.journal_id) AS journal_id,
             SUM(ABS(COALESCE(l.debit, 0) - COALESCE(g.debit, 0))
               + ABS(COALESCE(l.credit, 0) - COALESCE(g.credit, 0))) AS difference
        FROM lines l
        FULL OUTER JOIN ledger g ON g.journal_id = l.journal_id AND g.account_id = l.account_id
       GROUP BY COALESCE(l.journal_id, g.journal_id)
    )
    SELECT d.journal_id, je.entry_number, je.date, je.status::text AS status,
           je.fiscal_year_id AS journal_fy, d.difference::text AS difference
      FROM diff d
      LEFT JOIN journal_entries je ON je.id = d.journal_id
     WHERE d.difference <> 0
     ORDER BY d.difference DESC, je.entry_number
  `;
  return rows.map((r) => ({
    journalId: r.journal_id,
    entryNumber: r.entry_number,
    date: r.date,
    status: r.status,
    otherYear: r.journal_fy !== fiscalYearId,
    difference: new Prisma.Decimal(r.difference),
  }));
}
