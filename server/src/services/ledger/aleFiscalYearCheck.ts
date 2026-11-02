// Ledger rows booked to a fiscal year that does not hold their business day. A journal's ledger
// rows must carry the year found by the journal's own date (utils/periodGuard.ts); older code took
// the year of the source document instead. Detection only: moving the rows is a repair decision.
import { Prisma } from '@prisma/client';
import { businessUtcOffset } from '../../utils/businessDate';

type Tx = Prisma.TransactionClient;

export interface AleFiscalYearMismatch {
  journalId: string;
  /** Null when the ledger rows point at a journal that no longer exists. */
  entryNumber: string | null;
  /** Business day (YYYY-MM-DD) of the ledger rows. */
  day: string;
  aleCount: number;
  debit: Prisma.Decimal;
  storedYear: string;
  storedYearClosed: boolean;
  /** Year holding the business day, or null when no fiscal year covers it. */
  expectedYear: string | null;
  expectedYearClosed: boolean | null;
}

export interface AleFiscalYearMismatchResult {
  /** Mismatching journals before `limit` was applied. */
  total: number;
  /** Of those, journals touching a closed year (stored or expected). */
  closedTotal: number;
  rows: AleFiscalYearMismatch[];
}

interface MismatchRow {
  journal_id: string;
  entry_number: string | null;
  day: string;
  ale_count: bigint;
  debit: Prisma.Decimal;
  stored_year: string;
  stored_closed: boolean;
  expected_year: string | null;
  expected_closed: boolean | null;
  total: bigint;
  closed_total: bigint;
}

/**
 * Business day of a UTC `timestamp` column, the same rule as periodGuard.businessDay: an exact
 * UTC midnight is a date-only value and keeps its UTC day, any other instant is shifted by the
 * business offset first. Year bounds are stored at UTC or local midnight, so both forms of a
 * boundary day resolve to that day. The offset is a bound parameter.
 */
function sqlDay(col: Prisma.Sql, offset: string): Prisma.Sql {
  return Prisma.sql`(CASE WHEN ${col} = date_trunc('day', ${col}) THEN ${col}::date ELSE (${col} + ${offset}::interval)::date END)`;
}

/**
 * Active ledger rows of journals whose fiscal year differs from the year holding their business
 * day. Compares days, not instants: a cancel pair created milliseconds apart stays on one day.
 * When two years touch one day the later year wins, as in the period guard. Largest first.
 */
export async function findAleFiscalYearMismatches(
  tx: Tx,
  opts: { limit?: number; journalIds?: readonly string[] } = {},
): Promise<AleFiscalYearMismatchResult> {
  const offset = businessUtcOffset();
  const aleDay = sqlDay(Prisma.sql`ale.date`, offset);
  const startDay = sqlDay(Prisma.sql`f.start_date`, offset);
  const endDay = sqlDay(Prisma.sql`f.end_date`, offset);
  if (opts.journalIds && opts.journalIds.length === 0) return { total: 0, closedTotal: 0, rows: [] };
  const scope = opts.journalIds ? Prisma.sql`AND ale.reference_id IN (${Prisma.join([...opts.journalIds])})` : Prisma.empty;
  const limit = opts.limit !== undefined ? Prisma.sql`LIMIT ${opts.limit}` : Prisma.empty;

  const rows = await tx.$queryRaw<MismatchRow[]>`
    WITH tagged AS (
      SELECT ale.reference_id AS journal_id, ale.fiscal_year_id, ale.debit, ${aleDay} AS day
        FROM accounting_ledger_entries ale
       WHERE ale.reference_type = 'JournalEntry' AND ale.is_cancelled = false ${scope}
    ),
    checked AS (
      SELECT t.journal_id, t.fiscal_year_id, t.debit, t.day, e.id AS expected_id
        FROM tagged t
        LEFT JOIN LATERAL (
          SELECT f.id FROM fiscal_years f
           WHERE ${startDay} <= t.day AND ${endDay} >= t.day
           ORDER BY f.start_date DESC LIMIT 1
        ) e ON true
    ),
    grouped AS (
      SELECT journal_id, fiscal_year_id, expected_id, MIN(day) AS day, COUNT(*) AS ale_count, SUM(debit) AS debit
        FROM checked
       WHERE expected_id IS DISTINCT FROM fiscal_year_id
       GROUP BY journal_id, fiscal_year_id, expected_id
    )
    SELECT g.journal_id, je.entry_number, g.day::text AS day, g.ale_count, g.debit,
           sy.name AS stored_year, sy.is_closed AS stored_closed,
           ey.name AS expected_year, ey.is_closed AS expected_closed,
           COUNT(*) OVER () AS total,
           COUNT(*) FILTER (WHERE sy.is_closed OR COALESCE(ey.is_closed, false)) OVER () AS closed_total
      FROM grouped g
      JOIN fiscal_years sy ON sy.id = g.fiscal_year_id
      LEFT JOIN fiscal_years ey ON ey.id = g.expected_id
      LEFT JOIN journal_entries je ON je.id = g.journal_id
     ORDER BY g.debit DESC, g.journal_id
     ${limit}
  `;

  return {
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
    closedTotal: rows.length > 0 ? Number(rows[0]!.closed_total) : 0,
    rows: rows.map((r) => ({
      journalId: r.journal_id,
      entryNumber: r.entry_number,
      day: r.day,
      aleCount: Number(r.ale_count),
      debit: new Prisma.Decimal(r.debit),
      storedYear: r.stored_year,
      storedYearClosed: r.stored_closed,
      expectedYear: r.expected_year,
      expectedYearClosed: r.expected_closed,
    })),
  };
}
