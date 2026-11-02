// Ledger rows (accounting_ledger_entries) that do not balance as a group, across all fiscal years.
// The group is (reference_type, reference_id) over active rows, the key of the `ledger-balanced`
// year-close check, so the close check and this audit share one definition. The trigger of PR-4.6
// rejects two things and so does this section: a group whose debit and credit differ, and a group
// whose active rows sit in more than one fiscal year (a balanced group split over two years leaves
// each year unbalanced).

import { Prisma } from '@prisma/client';
import { businessDayOf } from '../../../../utils/businessDate';
import type { AuditOptions, AuditRow, AuditSection, Tx } from '../types';

export type AleGroupCause = 'je-missing' | 'je-cancelled-active-ale' | 'fy-split' | 'other';

export interface AleGroupFinding {
  referenceType: string;
  referenceId: string;
  fiscalYearId: string;
  fiscalYearName: string;
  yearClosed: boolean;
  /** Document number when the document still exists, else the reference id. */
  label: string;
  date: Date | null;
  /** Absolute difference of the group's slice in this fiscal year, "0.00" for a balanced slice of a split group. */
  difference: string;
  /** Number of fiscal years the group's active rows are spread over. */
  fiscalYearCount: number;
  cause: AleGroupCause;
}

export interface AleGroupQuery extends Pick<AuditOptions, 'since' | 'fiscalYearId'> {
  /** Also report balanced slices of groups split over several years (default true). */
  includeFySplit?: boolean;
}

interface Row {
  reference_type: string;
  reference_id: string;
  fiscal_year_id: string;
  fiscal_year_name: string;
  is_closed: boolean;
  label: string | null;
  date: Date | null;
  difference: string;
  fy_count: number;
  je_status: string | null;
  je_exists: boolean;
}

function causeOf(r: Row): AleGroupCause {
  if (r.reference_type === 'JournalEntry') {
    if (!r.je_exists) return 'je-missing';
    if (r.je_status === 'Cancelled') return 'je-cancelled-active-ale';
  }
  return r.fy_count > 1 ? 'fy-split' : 'other';
}

/**
 * Slices (one per group and fiscal year) whose debit and credit differ, plus balanced slices of
 * groups split over several years. Ordered by difference, largest first. With `fiscalYearId`
 * only that year's slices are returned; the split test still looks at the group's other years.
 */
export async function findUnbalancedAleGroups(tx: Tx, query: AleGroupQuery = {}): Promise<AleGroupFinding[]> {
  const { fiscalYearId, since, includeFySplit = true } = query;
  const splitScope =
    fiscalYearId && includeFySplit
      ? Prisma.sql`AND (reference_type, reference_id) IN (
          SELECT reference_type, reference_id FROM accounting_ledger_entries
           WHERE fiscal_year_id = ${fiscalYearId} AND is_cancelled = false)`
      : Prisma.empty;
  const yearScope = fiscalYearId && !includeFySplit ? Prisma.sql`AND fiscal_year_id = ${fiscalYearId}` : Prisma.empty;
  const slicePredicate = includeFySplit
    ? Prisma.sql`(s.diff <> 0 OR g.fy_count > 1)`
    : Prisma.sql`s.diff <> 0`;
  const yearFilter = fiscalYearId ? Prisma.sql`AND s.fiscal_year_id = ${fiscalYearId}` : Prisma.empty;
  const sinceFilter = since ? Prisma.sql`AND s.last_created >= ${since}` : Prisma.empty;

  const rows = await tx.$queryRaw<Row[]>`
    WITH slices AS (
      SELECT reference_type, reference_id, fiscal_year_id, MIN(date) AS date,
             SUM(debit) - SUM(credit) AS diff, MAX(created_at) AS last_created
        FROM accounting_ledger_entries
       WHERE is_cancelled = false ${splitScope} ${yearScope}
       GROUP BY reference_type, reference_id, fiscal_year_id
    ),
    grp AS (
      SELECT reference_type, reference_id, COUNT(*)::int AS fy_count FROM slices GROUP BY reference_type, reference_id
    )
    SELECT s.reference_type, s.reference_id, s.fiscal_year_id, fy.name AS fiscal_year_name, fy.is_closed,
           s.date, ABS(s.diff)::text AS difference, g.fy_count,
           je.status::text AS je_status, (je.id IS NOT NULL) AS je_exists,
           COALESCE(je.entry_number, si.invoice_number, pi.invoice_number, p.payment_number) AS label
      FROM slices s
      JOIN grp g ON g.reference_type = s.reference_type AND g.reference_id = s.reference_id
      JOIN fiscal_years fy ON fy.id = s.fiscal_year_id
      LEFT JOIN journal_entries je ON s.reference_type = 'JournalEntry' AND je.id = s.reference_id
      LEFT JOIN sales_invoices si ON s.reference_type = 'SalesInvoice' AND si.id = s.reference_id
      LEFT JOIN purchase_invoices pi ON s.reference_type = 'PurchaseInvoice' AND pi.id = s.reference_id
      LEFT JOIN payments p ON s.reference_type = 'Payment' AND p.id = s.reference_id
     WHERE ${slicePredicate} ${yearFilter} ${sinceFilter}
     ORDER BY ABS(s.diff) DESC, s.reference_id, s.fiscal_year_id
  `;
  return rows.map((r) => ({
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    fiscalYearId: r.fiscal_year_id,
    fiscalYearName: r.fiscal_year_name,
    yearClosed: r.is_closed,
    label: r.label ?? r.reference_id,
    date: r.date,
    difference: new Prisma.Decimal(r.difference).toFixed(2),
    fiscalYearCount: r.fy_count,
    cause: causeOf(r),
  }));
}

export const aleGroupsSection: AuditSection = {
  id: 'aleGroups',
  title: 'Ledger groups that do not balance, or are split over fiscal years',
  gate: 'trigger',
  async run(tx, opts) {
    const found = await findUnbalancedAleGroups(tx, opts);
    return found.map<AuditRow>((f) => ({
      section: 'aleGroups',
      cause: f.cause,
      key: `${f.referenceType}:${f.referenceId}@${f.fiscalYearId}`,
      label: f.label,
      date: f.date ? businessDayOf(f.date) : null,
      amount: f.difference,
      count: 1,
      yearClosed: f.yearClosed,
      gate: !f.yearClosed,
      detail: `${f.referenceType} in fiscal year ${f.fiscalYearName}; group spans ${f.fiscalYearCount} fiscal year(s)`,
    }));
  },
};
