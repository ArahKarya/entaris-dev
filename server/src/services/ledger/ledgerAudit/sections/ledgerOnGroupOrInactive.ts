// Accounts that are a group or inactive but still carry active ledger rows (a group account holds
// no postings of its own; the development data has account 5 here).

import { Prisma } from '@prisma/client';
import { businessDayOf } from '../../../../utils/businessDate';
import type { AuditRow, AuditSection } from '../types';

interface Row {
  account_id: string;
  account_number: string;
  name: string;
  is_group: boolean;
  is_active: boolean;
  entries: number;
  debit: string;
  credit: string;
  last_date: Date;
}

export const ledgerOnGroupOrInactiveSection: AuditSection = {
  id: 'ledgerOnGroupOrInactive',
  title: 'Group or inactive accounts with active ledger rows',
  gate: null,
  async run(tx, opts) {
    const since = opts.since ? Prisma.sql`AND ale.created_at >= ${opts.since}` : Prisma.empty;
    const year = opts.fiscalYearId ? Prisma.sql`AND ale.fiscal_year_id = ${opts.fiscalYearId}` : Prisma.empty;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT a.id AS account_id, a."accountNumber" AS account_number, a.name, a."isGroup" AS is_group, a."isActive" AS is_active,
             COUNT(*)::int AS entries, SUM(ale.debit)::text AS debit, SUM(ale.credit)::text AS credit,
             MAX(ale.date) AS last_date
        FROM accounting_ledger_entries ale
        JOIN accounts a ON a.id = ale.account_id
       WHERE ale.is_cancelled = false AND (a."isGroup" = true OR a."isActive" = false) ${since} ${year}
       GROUP BY a.id, a."accountNumber", a.name, a."isGroup", a."isActive"
       ORDER BY a."accountNumber"
    `;
    return rows.map<AuditRow>((r) => ({
      section: 'ledgerOnGroupOrInactive',
      cause: r.is_group && !r.is_active ? 'group-inactive' : r.is_group ? 'group' : 'inactive',
      key: r.account_id,
      label: `${r.account_number} ${r.name}`,
      date: businessDayOf(r.last_date),
      amount: new Prisma.Decimal(r.debit).minus(r.credit).toFixed(2),
      count: r.entries,
      yearClosed: null,
      gate: false,
      detail: `${r.entries} active ledger row(s); debit ${r.debit}, credit ${r.credit}; amount is debit minus credit; date is the latest row`,
    }));
  },
};
