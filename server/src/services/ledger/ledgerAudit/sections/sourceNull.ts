// Journals whose source_type is still NULL, by number prefix and month: checks the result of the
// source-type backfill (scripts/repair/e1-journal-source-backfill.ts). NULL means "not manual".

import { Prisma } from '@prisma/client';
import { sqlBusinessTs } from '../../../../utils/businessDate';
import type { AuditRow, AuditSection } from '../types';

interface Row {
  prefix: string;
  month: string;
  journals: number;
  amount: string;
}

export const sourceNullSection: AuditSection = {
  id: 'sourceNull',
  title: 'Journals without a source type, by number prefix and month',
  gate: null,
  async run(tx, opts) {
    const since = opts.since ? Prisma.sql`AND je.created_at >= ${opts.since}` : Prisma.empty;
    const year = opts.fiscalYearId ? Prisma.sql`AND je.fiscal_year_id = ${opts.fiscalYearId}` : Prisma.empty;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT COALESCE(substring(je.entry_number from '^[A-Za-z]+'), '(none)') AS prefix,
             to_char(${sqlBusinessTs(Prisma.sql`je.date`)}, 'YYYY-MM') AS month,
             COUNT(*)::int AS journals,
             COALESCE(SUM(t.total), 0)::text AS amount
        FROM journal_entries je
        LEFT JOIN LATERAL (SELECT SUM(debit) AS total FROM journal_entry_accounts WHERE journal_entry_id = je.id) t ON true
       WHERE je.source_type IS NULL AND je.status <> 'Draft' ${since} ${year}
       GROUP BY 1, 2
       ORDER BY 2, 1
    `;
    return rows.map<AuditRow>((r) => ({
      section: 'sourceNull',
      cause: 'source-null',
      key: `${r.prefix}@${r.month}`,
      label: `${r.prefix} ${r.month}`,
      date: null,
      amount: new Prisma.Decimal(r.amount).toFixed(2),
      count: r.journals,
      yearClosed: null,
      gate: false,
      detail: `${r.journals} journal(s) with source_type NULL; amount is the sum of debits`,
    }));
  },
};
