// Submitted journals whose lines (journal_entry_accounts) do not add up: SUM(debit) <> SUM(credit).
// A difference of 0.01 or less is flagged sub-cent: the journal trigger of 2026-05 tolerates it,
// the zero-tolerance trigger of PR-4.6 does not. Guards the tolerance gate.

import { Prisma } from '@prisma/client';
import { businessDayOf } from '../../../../utils/businessDate';
import type { AuditRow, AuditSection } from '../types';

interface Row {
  id: string;
  entry_number: string;
  date: Date;
  source_type: string | null;
  difference: string;
  signed: string;
  is_closed: boolean;
  fiscal_year_name: string;
}

const SUB_CENT = new Prisma.Decimal('0.01');

export const journalSubCentSection: AuditSection = {
  id: 'journalSubCent',
  title: 'Submitted journals whose debit and credit differ (sub-cent differences flagged)',
  gate: 'tolerance',
  async run(tx, opts) {
    const since = opts.since ? Prisma.sql`AND je.created_at >= ${opts.since}` : Prisma.empty;
    const year = opts.fiscalYearId ? Prisma.sql`AND je.fiscal_year_id = ${opts.fiscalYearId}` : Prisma.empty;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT je.id, je.entry_number, je.date, je.source_type::text AS source_type,
             ABS(SUM(jea.debit) - SUM(jea.credit))::text AS difference,
             (SUM(jea.debit) - SUM(jea.credit))::text AS signed,
             fy.is_closed, fy.name AS fiscal_year_name
        FROM journal_entries je
        JOIN journal_entry_accounts jea ON jea.journal_entry_id = je.id
        JOIN fiscal_years fy ON fy.id = je.fiscal_year_id
       WHERE je.status = 'Submitted' ${since} ${year}
       GROUP BY je.id, je.entry_number, je.date, je.source_type, fy.is_closed, fy.name
      HAVING SUM(jea.debit) <> SUM(jea.credit)
       ORDER BY ABS(SUM(jea.debit) - SUM(jea.credit)) DESC, je.entry_number
    `;
    return rows.map<AuditRow>((r) => {
      const diff = new Prisma.Decimal(r.difference);
      return {
        section: 'journalSubCent',
        cause: diff.lte(SUB_CENT) ? 'sub-cent' : 'unbalanced',
        key: r.id,
        label: r.entry_number,
        date: businessDayOf(r.date),
        amount: diff.toFixed(2),
        count: 1,
        yearClosed: r.is_closed,
        gate: !r.is_closed,
        detail: `source ${r.source_type ?? 'NULL'}; debit minus credit ${r.signed}; fiscal year ${r.fiscal_year_name}`,
      };
    });
  },
};
