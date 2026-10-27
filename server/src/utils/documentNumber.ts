import { Prisma } from '@prisma/client';

/**
 * Generates a sequential document number using advisory locks to prevent
 * race conditions under concurrent requests.
 *
 * Format: {prefix}-YYYYMM-XXXX  e.g. SI-202603-0001
 *
 * Uses MAX(existing number) + 1 within the (prefix, yearMonth) series, not a row
 * count, so deleted or backdated documents cannot cause @unique (P2002) collisions.
 */
export async function generateDocumentNumber(
  tx: Prisma.TransactionClient,
  prefix: 'JV' | 'SI' | 'PI' | 'PAY' | 'SM' | 'PR' | 'OB' | 'SO' | 'QO' | 'INQ' | 'ST' | 'DO' | 'STT' | 'PO' | 'PSN' | 'RN' | 'UJ' | 'PP' | 'DPR' | 'DKB' | 'PRO',
  date: Date,
  fiscalYearId: string
): Promise<string> {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  const monthStr = String(month + 1).padStart(2, '0');
  const yearMonth = `${year}${monthStr}`;

  // Use a deterministic advisory lock key per (prefix, yearMonth)
  // FNV-1a-like hash to avoid collisions between different prefix+month combos
  const key = `${prefix}-${yearMonth}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // keep as unsigned 32-bit
  }
  const lockKey = hash % 2147483647; // ensure fits in PostgreSQL int4
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

  // Find the highest number already used in this (prefix, yearMonth) series.
  // The series prefix embeds year+month, so no date/fiscalYear filter is needed
  // (and deleted/backdated rows can never cause collisions).
  const seriesPrefix = `${prefix}-${yearMonth}-`;
  const { table, column } = SERIES_SOURCE[prefix];
  const documentMax = await maxNumericSuffix(tx, table, column, seriesPrefix);

  // Most documents name their journal `JV-<documentNumber>` (sales also `JV-COGS-<documentNumber>`),
  // so an orphan journal left by a deleted document would hit P2002 at submit. Continue after those too.
  const journals = SERIES_SOURCE.JV;
  const journalMax = OWN_JOURNAL_NAME.has(prefix)
    ? 0
    : Math.max(
        await maxNumericSuffix(tx, journals.table, journals.column, `JV-${seriesPrefix}`),
        await maxNumericSuffix(tx, journals.table, journals.column, `JV-COGS-${seriesPrefix}`),
      );

  return `${prefix}-${yearMonth}-${String(Math.max(documentMax, journalMax) + 1).padStart(4, '0')}`;
}

type DocumentPrefix = Parameters<typeof generateDocumentNumber>[1];

/** Prefixes whose journals are not named after the document number. */
const OWN_JOURNAL_NAME = new Set<DocumentPrefix>(['JV', 'OB', 'DPR', 'DKB', 'PRO']);

const source = (table: string, column: string) => ({
  table: Prisma.raw(`"${table}"`),
  column: Prisma.raw(`"${column}"`),
});

/** Table and column holding each series. Fixed identifiers only: they are spliced into raw SQL. */
const SERIES_SOURCE: Record<DocumentPrefix, { table: Prisma.Sql; column: Prisma.Sql }> = {
  SI: source('sales_invoices', 'invoice_number'),
  PI: source('purchase_invoices', 'invoice_number'),
  PAY: source('payments', 'payment_number'),
  SM: source('stock_movements', 'movement_number'),
  PR: source('production_runs', 'run_number'),
  SO: source('stock_opnames', 'opname_number'),
  QO: source('quotations', 'quotation_number'),
  PRO: source('proforma_invoices', 'proforma_number'),
  INQ: source('inquiries', 'inquiry_number'),
  ST: source('stock_transfers', 'transfer_number'),
  DO: source('delivery_orders', 'do_number'),
  STT: source('goods_receipts', 'stt_number'),
  PO: source('purchase_orders', 'po_number'),
  PSN: source('sales_orders', 'so_number'),
  RN: source('sales_returns', 'return_number'),
  UJ: source('project_guarantees', 'guarantee_number'),
  PP: source('payment_requests', 'number'),
  DPR: source('production_run_drafts', 'draft_number'),
  DKB: source('cash_book_drafts', 'draft_number'),
  JV: source('journal_entries', 'entry_number'),
  OB: source('journal_entries', 'entry_number'),
};

/**
 * Highest all-digit suffix after `series` in `table.column`, compared as a number: text order
 * puts `-9999` after `-10000`, which made every series stall at 9999. Suffixes that are not all
 * digits (`-REV`, `-CXL`, `-R2`, `-CORR`) are skipped. `table` and `column` must be fixed
 * identifiers built with Prisma.raw, never user input; `series` is sent as a parameter.
 *
 * @returns 0 when the series has no numbered rows yet
 */
export async function maxNumericSuffix(
  tx: Prisma.TransactionClient,
  table: Prisma.Sql,
  column: Prisma.Sql,
  series: string
): Promise<number> {
  const from = series.length + 1;
  // At most 15 digits so the value stays exact as a JS number and the cast cannot overflow.
  const rows = await tx.$queryRaw<Array<{ last: bigint | number | null }>>(Prisma.sql`
    SELECT COALESCE(MAX(substring(${column} FROM ${from}::int)::bigint), 0) AS last
    FROM ${table}
    WHERE starts_with(${column}, ${series}::text)
      AND substring(${column} FROM ${from}::int) ~ '^[0-9]{1,15}$'`);
  return Number(rows[0]?.last ?? 0);
}
