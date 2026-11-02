// Submitted journals with fewer than two lines that carry an amount (the L0 rule LINES_TOO_FEW).

import { Prisma } from '@prisma/client';
import { businessDayOf } from '../../../../utils/businessDate';
import type { AuditRow, AuditSection } from '../types';

interface Row {
  id: string;
  entry_number: string;
  date: Date;
  source_type: string | null;
  valued_lines: number;
  total_lines: number;
  amount: string;
  is_closed: boolean;
}

export const journalTooFewLinesSection: AuditSection = {
  id: 'journalTooFewLines',
  title: 'Submitted journals with fewer than 2 lines that carry an amount',
  gate: null,
  async run(tx, opts) {
    const since = opts.since ? Prisma.sql`AND je.created_at >= ${opts.since}` : Prisma.empty;
    const year = opts.fiscalYearId ? Prisma.sql`AND je.fiscal_year_id = ${opts.fiscalYearId}` : Prisma.empty;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT je.id, je.entry_number, je.date, je.source_type::text AS source_type, fy.is_closed,
             COUNT(jea.id) FILTER (WHERE jea.debit > 0 OR jea.credit > 0)::int AS valued_lines,
             COUNT(jea.id)::int AS total_lines,
             COALESCE(SUM(jea.debit), 0)::text AS amount
        FROM journal_entries je
        JOIN fiscal_years fy ON fy.id = je.fiscal_year_id
        LEFT JOIN journal_entry_accounts jea ON jea.journal_entry_id = je.id
       WHERE je.status = 'Submitted' ${since} ${year}
       GROUP BY je.id, je.entry_number, je.date, je.source_type, fy.is_closed
      HAVING COUNT(jea.id) FILTER (WHERE jea.debit > 0 OR jea.credit > 0) < 2
       ORDER BY je.date, je.entry_number
    `;
    return rows.map<AuditRow>((r) => ({
      section: 'journalTooFewLines',
      cause: r.valued_lines === 0 ? 'no-valued-line' : 'one-valued-line',
      key: r.id,
      label: r.entry_number,
      date: businessDayOf(r.date),
      amount: new Prisma.Decimal(r.amount).toFixed(2),
      count: 1,
      yearClosed: r.is_closed,
      gate: false,
      detail: `source ${r.source_type ?? 'NULL'}; ${r.valued_lines} valued of ${r.total_lines} line(s)`,
    }));
  },
};
