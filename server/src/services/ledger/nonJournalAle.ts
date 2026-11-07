// Active ledger rows booked to a document (reference_type SalesInvoice, PurchaseInvoice, Payment, ...)
// instead of a journal. Today every writer books a document through its journal (reference_type
// 'JournalEntry'); rows of another type are left from old generators and repair scripts. Where the
// same document is also booked through a journal, reports and the year-close profit (which add
// every reference type) count it twice. Detection only (owner decision #7): the health check
// (routes/health/aleChecks.ts), the ledger audit section nonJournalAle and the year-close check
// non-journal-ale-duplicate all read this one function.
import { Prisma } from '@prisma/client';
import { businessUtcOffset } from '../../utils/businessDate';

type Tx = Prisma.TransactionClient;

/** The ledger rows of one document in one fiscal year. */
export interface NonJournalAleGroup {
  referenceType: string;
  referenceId: string;
  /** Document number when the document is known and still exists, else the reference id. */
  label: string;
  fiscalYearId: string;
  fiscalYearName: string;
  yearClosed: boolean;
  /** Earliest row date. */
  date: Date;
  rows: number;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  /**
   * Submitted journal of the document in the same fiscal year: "JV-<number>" (and its "-..."
   * satellites) or the payment's journal.
   */
  linkedJournal: string | null;
  /**
   * Rows with a twin journal ledger row: same account, party, business day, fiscal year, debit and
   * credit. Not paired one to one (one journal row can be the twin of several document rows), so it
   * is a hint for the accountant, never a gate.
   */
  mirroredRows: number;
  /**
   * The document is also booked through its own journal (linkedJournal): counted twice. Keyed on
   * the document, so an unrelated posting with the same amount cannot make it one; this is what the
   * year close blocks on.
   */
  duplicate: boolean;
  /** Not linked, but every row has a twin journal row: possibly counted twice, report only. */
  possibleDuplicate: boolean;
}

export interface NonJournalAleTypeSummary {
  referenceType: string;
  documents: number;
  rows: number;
  debit: Prisma.Decimal;
  duplicates: number;
  possibleDuplicates: number;
}

export interface NonJournalAleScope {
  fiscalYearId?: string;
  /** Only these documents (reference ids); an empty list matches nothing. */
  referenceIds?: readonly string[];
  /** Only documents that are counted twice (`duplicate`). */
  duplicatesOnly?: boolean;
  limit?: number;
}

export interface NonJournalAleResult {
  /** Groups (document and fiscal year) before `limit`. */
  total: number;
  duplicateTotal: number;
  closedTotal: number;
  /** Per reference type, over all groups (not limited). */
  byType: NonJournalAleTypeSummary[];
  rows: NonJournalAleGroup[];
}

interface Row {
  reference_type: string;
  reference_id: string;
  fiscal_year_id: string;
  fiscal_year_name: string;
  is_closed: boolean;
  label: string | null;
  date: Date;
  n_rows: number;
  debit: string;
  credit: string;
  linked_journal: string | null;
  mirrored_rows: number;
  duplicate: boolean;
  possible_duplicate: boolean;
  total: bigint;
  duplicate_total: bigint;
  closed_total: bigint;
  by_type: Array<{ referenceType: string; documents: number; rows: number; debit: string; duplicates: number; possibleDuplicates: number }> | null;
}

/** Groups of active non-journal ledger rows, largest debit first. */
export async function findNonJournalAle(tx: Tx, scope: NonJournalAleScope = {}): Promise<NonJournalAleResult> {
  if (scope.referenceIds && scope.referenceIds.length === 0) {
    return { total: 0, duplicateTotal: 0, closedTotal: 0, byType: [], rows: [] };
  }
  const offset = businessUtcOffset();
  const year = scope.fiscalYearId ? Prisma.sql`AND ale.fiscal_year_id = ${scope.fiscalYearId}` : Prisma.empty;
  const ids = scope.referenceIds ? Prisma.sql`AND ale.reference_id IN (${Prisma.join([...scope.referenceIds])})` : Prisma.empty;
  const onlyDuplicates = scope.duplicatesOnly ? Prisma.sql`WHERE duplicate` : Prisma.empty;
  const limit = scope.limit !== undefined ? Prisma.sql`LIMIT ${scope.limit}` : Prisma.empty;

  const rows = await tx.$queryRaw<Row[]>`
    WITH doc_rows AS (
      SELECT ale.reference_type, ale.reference_id, ale.fiscal_year_id, ale.debit, ale.credit, ale.date,
             EXISTS (
               SELECT 1 FROM accounting_ledger_entries m
                 JOIN journal_entries mj ON mj.id = m.reference_id AND mj.status = 'Submitted'
                WHERE m.reference_type = 'JournalEntry' AND m.is_cancelled = false
                  AND m.account_id = ale.account_id AND m.fiscal_year_id = ale.fiscal_year_id
                  AND m.party_id IS NOT DISTINCT FROM ale.party_id
                  AND m.debit = ale.debit AND m.credit = ale.credit
                  AND (m.date + ${offset}::interval)::date = (ale.date + ${offset}::interval)::date
             ) AS mirrored
        FROM accounting_ledger_entries ale
       WHERE ale.is_cancelled = false AND ale.reference_type <> 'JournalEntry' ${year} ${ids}
    ),
    groups AS (
      SELECT reference_type, reference_id, fiscal_year_id, COUNT(*)::int AS n_rows,
             SUM(debit) AS debit, SUM(credit) AS credit, MIN(date) AS date,
             (COUNT(*) FILTER (WHERE mirrored))::int AS mirrored_rows
        FROM doc_rows
       GROUP BY reference_type, reference_id, fiscal_year_id
    ),
    documents AS (
      SELECT g.*, fy.name AS fiscal_year_name, fy.is_closed,
             COALESCE(si.invoice_number, pi.invoice_number, p.payment_number) AS label,
             p.journal_entry_id AS payment_journal_id
        FROM groups g
        JOIN fiscal_years fy ON fy.id = g.fiscal_year_id
        LEFT JOIN sales_invoices si ON g.reference_type = 'SalesInvoice' AND si.id = g.reference_id
        LEFT JOIN purchase_invoices pi ON g.reference_type = 'PurchaseInvoice' AND pi.id = g.reference_id
        LEFT JOIN payments p ON g.reference_type = 'Payment' AND p.id = g.reference_id
    ),
    found AS (
      SELECT d.*, lj.entry_number AS linked_journal,
             (lj.entry_number IS NOT NULL) AS duplicate,
             (lj.entry_number IS NULL AND d.mirrored_rows = d.n_rows) AS possible_duplicate
        FROM documents d
        LEFT JOIN LATERAL (
          SELECT je.entry_number FROM journal_entries je
           WHERE je.status = 'Submitted' AND je.fiscal_year_id = d.fiscal_year_id
             AND (je.id = d.payment_journal_id
               OR (d.label IS NOT NULL
                   AND (je.entry_number = 'JV-' || d.label OR starts_with(je.entry_number, 'JV-' || d.label || '-'))))
           ORDER BY je.entry_number
           LIMIT 1
        ) lj ON true
    ),
    picked AS (
      SELECT * FROM found ${onlyDuplicates}
    )
    SELECT reference_type, reference_id, fiscal_year_id, fiscal_year_name, is_closed, label, date, n_rows,
           debit::text AS debit, credit::text AS credit, linked_journal, mirrored_rows, duplicate, possible_duplicate,
           COUNT(*) OVER () AS total,
           COUNT(*) FILTER (WHERE duplicate) OVER () AS duplicate_total,
           COUNT(*) FILTER (WHERE is_closed) OVER () AS closed_total,
           (SELECT jsonb_agg(t ORDER BY t."referenceType") FROM (
              SELECT reference_type AS "referenceType", COUNT(*)::int AS documents, SUM(n_rows)::int AS rows,
                     SUM(debit)::text AS debit, (COUNT(*) FILTER (WHERE duplicate))::int AS duplicates,
                     (COUNT(*) FILTER (WHERE possible_duplicate))::int AS "possibleDuplicates"
                FROM picked GROUP BY reference_type) t) AS by_type
      FROM picked
     ORDER BY picked.debit DESC, picked.reference_id, picked.fiscal_year_id
     ${limit}
  `;

  const first = rows[0];
  return {
    total: first ? Number(first.total) : 0,
    duplicateTotal: first ? Number(first.duplicate_total) : 0,
    closedTotal: first ? Number(first.closed_total) : 0,
    byType: (first?.by_type ?? []).map((t) => ({ ...t, debit: new Prisma.Decimal(t.debit) })),
    rows: rows.map((r) => ({
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      label: r.label ?? r.reference_id,
      fiscalYearId: r.fiscal_year_id,
      fiscalYearName: r.fiscal_year_name,
      yearClosed: r.is_closed,
      date: r.date,
      rows: r.n_rows,
      debit: new Prisma.Decimal(r.debit),
      credit: new Prisma.Decimal(r.credit),
      linkedJournal: r.linked_journal,
      mirroredRows: r.mirrored_rows,
      duplicate: r.duplicate,
      possibleDuplicate: r.possible_duplicate,
    })),
  };
}
