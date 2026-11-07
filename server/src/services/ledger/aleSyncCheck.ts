// The one per-journal ledger sync (E2-R14): the journal lines (journal_entry_accounts) of every
// submitted journal against its active ledger rows (accounting_ledger_entries, reference_type
// 'JournalEntry'), account by account. It takes the caller's transaction, so the year close can run
// it for one year after FOR UPDATE, and the health check runs it over the whole book with a cause
// per journal. Detection only.
import { Prisma } from '@prisma/client';
import { legacyCxlPairSql } from './legacyCxlPair';

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

export type AleMismatchCause =
  | 'no-ledger' // Submitted journal without active ledger rows
  | 'ledger-without-journal' // active ledger rows, the journal is gone
  | 'cancelled-active-ale' // Cancelled journal with active ledger rows, not a legacy cancel pair
  | 'legacy-stt-pair' // Cancelled journal with active ledger rows and a Submitted "<number>-CXL" (legacyCxlPair.ts)
  | 'draft-with-ale' // Draft journal with active ledger rows
  | 'amount-differs'; // lines and ledger rows both there, amounts per account differ

/** The facts a cause is read from: one journal (or missing journal) with a difference. */
export interface AleMismatchFacts {
  journalExists: boolean;
  status: string | null;
  hasLedger: boolean;
  legacyPair: boolean;
}

/**
 * The cause rules, first match wins. Each rule is written once in TypeScript and once in SQL side by
 * side; the query builds its CASE from this list, classifyAleMismatch reads the same list.
 */
const CAUSE_RULES: ReadonlyArray<{ cause: AleMismatchCause; sql: Prisma.Sql; matches: (f: AleMismatchFacts) => boolean }> = [
  { cause: 'ledger-without-journal', sql: Prisma.sql`NOT je_exists`, matches: (f) => !f.journalExists },
  { cause: 'draft-with-ale', sql: Prisma.sql`status = 'Draft' AND has_ledger`, matches: (f) => f.status === 'Draft' && f.hasLedger },
  {
    cause: 'legacy-stt-pair',
    sql: Prisma.sql`status = 'Cancelled' AND has_ledger AND legacy_pair`,
    matches: (f) => f.status === 'Cancelled' && f.hasLedger && f.legacyPair,
  },
  { cause: 'cancelled-active-ale', sql: Prisma.sql`status = 'Cancelled' AND has_ledger`, matches: (f) => f.status === 'Cancelled' && f.hasLedger },
  { cause: 'no-ledger', sql: Prisma.sql`status = 'Submitted' AND NOT has_ledger`, matches: (f) => f.status === 'Submitted' && !f.hasLedger },
];

export const ALE_MISMATCH_CAUSES: readonly AleMismatchCause[] = [...CAUSE_RULES.map((r) => r.cause), 'amount-differs'];

/** Cause of one mismatch (pure; the query applies the same rules). */
export function classifyAleMismatch(f: AleMismatchFacts): AleMismatchCause {
  return CAUSE_RULES.find((r) => r.matches(f))?.cause ?? 'amount-differs';
}

const causeCaseSql = Prisma.sql`CASE ${Prisma.join(
  CAUSE_RULES.map((r) => Prisma.sql`WHEN ${r.sql} THEN ${r.cause}`),
  ' ',
)} ELSE 'amount-differs' END`;

export interface AleMismatchScope {
  /** Journals of this year, plus ledger rows tagged with it whose journal is elsewhere or gone. */
  fiscalYearId?: string;
  /** Only these journals (ids); an empty list matches nothing. */
  journalIds?: readonly string[];
}

export interface AleMismatchRow extends AleJournalMismatch {
  cause: AleMismatchCause;
  /** Year of the journal, or of its ledger rows when the journal is gone. */
  fiscalYearId: string | null;
  fiscalYearName: string | null;
  /** The journal's year or a year of its ledger rows is closed. */
  yearClosed: boolean;
}

export interface AleMismatchResult {
  /** Mismatching journals before `limit`. */
  total: number;
  /** Of those, journals in a closed year. */
  closedTotal: number;
  byCause: Record<AleMismatchCause, number>;
  rows: AleMismatchRow[];
}

interface Row {
  journal_id: string;
  entry_number: string | null;
  date: Date | null;
  status: string | null;
  journal_fy: string | null;
  fiscal_year_id: string | null;
  fiscal_year_name: string | null;
  year_closed: boolean;
  cause: AleMismatchCause;
  difference: string;
  total: bigint;
  closed_total: bigint;
  by_cause: Record<string, number> | null;
}

function scopeSql(scope: AleMismatchScope): { journals: Prisma.Sql; ledger: Prisma.Sql } {
  if (scope.journalIds) {
    const ids = Prisma.join([...scope.journalIds]);
    return { journals: Prisma.sql`WHERE id IN (${ids})`, ledger: Prisma.sql`AND ale.reference_id IN (${ids})` };
  }
  if (scope.fiscalYearId) {
    return {
      journals: Prisma.sql`WHERE fiscal_year_id = ${scope.fiscalYearId}`,
      ledger: Prisma.sql`AND (ale.fiscal_year_id = ${scope.fiscalYearId} OR ale.reference_id IN (SELECT id FROM scoped))`,
    };
  }
  return { journals: Prisma.empty, ledger: Prisma.empty };
}

async function queryMismatches(tx: Tx, scope: AleMismatchScope, limit?: number): Promise<Row[]> {
  const { journals, ledger } = scopeSql(scope);
  const limitSql = limit !== undefined ? Prisma.sql`LIMIT ${limit}` : Prisma.empty;
  return tx.$queryRaw<Row[]>`
    WITH scoped AS (
      SELECT id, status FROM journal_entries ${journals}
    ),
    lines AS (
      SELECT jea.journal_entry_id AS journal_id, jea.account_id,
             SUM(jea.debit) AS debit, SUM(jea.credit) AS credit
        FROM journal_entry_accounts jea
        JOIN scoped j ON j.id = jea.journal_entry_id
       WHERE j.status = 'Submitted'
       GROUP BY jea.journal_entry_id, jea.account_id
    ),
    ledger AS (
      SELECT ale.reference_id AS journal_id, ale.account_id,
             SUM(ale.debit) AS debit, SUM(ale.credit) AS credit,
             MIN(ale.fiscal_year_id) AS fiscal_year_id, bool_or(fy.is_closed) AS closed
        FROM accounting_ledger_entries ale
        JOIN fiscal_years fy ON fy.id = ale.fiscal_year_id
       WHERE ale.reference_type = 'JournalEntry'
         AND ale.is_cancelled = false
         ${ledger}
       GROUP BY ale.reference_id, ale.account_id
    ),
    diff AS (
      SELECT COALESCE(l.journal_id, g.journal_id) AS journal_id,
             SUM(ABS(COALESCE(l.debit, 0) - COALESCE(g.debit, 0))
               + ABS(COALESCE(l.credit, 0) - COALESCE(g.credit, 0))) AS difference,
             bool_or(g.journal_id IS NOT NULL) AS has_ledger,
             bool_or(COALESCE(g.closed, false)) AS ledger_closed,
             MIN(g.fiscal_year_id) AS ledger_fy
        FROM lines l
        FULL OUTER JOIN ledger g ON g.journal_id = l.journal_id AND g.account_id = l.account_id
       GROUP BY COALESCE(l.journal_id, g.journal_id)
    ),
    facts AS (
      SELECT d.journal_id, d.difference, d.has_ledger, d.ledger_closed,
             je.entry_number, je.date, je.status::text AS status, je.fiscal_year_id AS journal_fy,
             COALESCE(je.fiscal_year_id, d.ledger_fy) AS fiscal_year_id,
             (je.id IS NOT NULL) AS je_exists,
             COALESCE(${legacyCxlPairSql('je')}, false) AS legacy_pair
        FROM diff d
        LEFT JOIN journal_entries je ON je.id = d.journal_id
       WHERE d.difference <> 0
    ),
    classified AS (
      SELECT facts.*, ${causeCaseSql} AS cause FROM facts
    ),
    found AS (
      SELECT c.*, fy.name AS fiscal_year_name,
             (COALESCE(fy.is_closed, false) OR c.ledger_closed) AS year_closed
        FROM classified c
        LEFT JOIN fiscal_years fy ON fy.id = c.fiscal_year_id
    )
    SELECT journal_id, entry_number, date, status, journal_fy, fiscal_year_id, fiscal_year_name, year_closed,
           cause, difference::text AS difference,
           COUNT(*) OVER () AS total,
           COUNT(*) FILTER (WHERE year_closed) OVER () AS closed_total,
           (SELECT jsonb_object_agg(c.cause, c.n) FROM (SELECT cause, COUNT(*)::int AS n FROM found GROUP BY cause) c) AS by_cause
      FROM found
     ORDER BY found.difference DESC, found.entry_number, found.journal_id
     ${limitSql}
  `;
}

const emptyByCause = (): Record<AleMismatchCause, number> =>
  Object.fromEntries(ALE_MISMATCH_CAUSES.map((c) => [c, 0])) as Record<AleMismatchCause, number>;

/**
 * Journals of `fiscalYearId` whose lines and ledger rows differ, plus ledger rows tagged with this
 * year whose journal is in another year or gone. Lines count only for Submitted journals, so a
 * cancelled journal with active ledger rows, or a submitted one without them, is a mismatch.
 * Ordered by difference, largest first. (Year-close check ale-vs-journal and its baseline.)
 */
export function findAleJournalMismatches(tx: Tx, fiscalYearId: string): Promise<AleJournalMismatch[]>;
/**
 * The same comparison over the whole book (no scope), one year or some journals, with a cause per
 * journal, the full count before `limit`, and the count per cause.
 */
export function findAleJournalMismatches(tx: Tx, scope: AleMismatchScope, opts?: { limit?: number }): Promise<AleMismatchResult>;
export async function findAleJournalMismatches(
  tx: Tx,
  scope: string | AleMismatchScope,
  opts: { limit?: number } = {},
): Promise<AleJournalMismatch[] | AleMismatchResult> {
  if (typeof scope === 'string') {
    const rows = await queryMismatches(tx, { fiscalYearId: scope });
    return rows.map((r) => ({
      journalId: r.journal_id,
      entryNumber: r.entry_number,
      date: r.date,
      status: r.status,
      otherYear: r.journal_fy !== scope,
      difference: new Prisma.Decimal(r.difference),
    }));
  }
  if (scope.journalIds && scope.journalIds.length === 0) return { total: 0, closedTotal: 0, byCause: emptyByCause(), rows: [] };
  const rows = await queryMismatches(tx, scope, opts.limit);
  const first = rows[0];
  return {
    total: first ? Number(first.total) : 0,
    closedTotal: first ? Number(first.closed_total) : 0,
    byCause: { ...emptyByCause(), ...(first?.by_cause ?? {}) },
    rows: rows.map((r) => ({
      journalId: r.journal_id,
      entryNumber: r.entry_number,
      date: r.date,
      status: r.status,
      otherYear: scope.fiscalYearId !== undefined && r.journal_fy !== scope.fiscalYearId,
      difference: new Prisma.Decimal(r.difference),
      cause: r.cause,
      fiscalYearId: r.fiscal_year_id,
      fiscalYearName: r.fiscal_year_name,
      yearClosed: r.year_closed,
    })),
  };
}
