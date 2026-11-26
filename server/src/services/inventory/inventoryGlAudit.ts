// Why inventory value and the General Ledger differ, per finding, for the accountant (E3-R15,
// PR-6.13a; run by scripts/repair/e3-inventory-gl-audit.ts). Read only. The account set, the
// totals and the invariant come from inventoryGlCheck.ts; this module only classifies:
//   A  document-typed ledger rows on an inventory account (step 5: counted twice or outside a journal);
//   B  journals vs movements per document: a valued movement without an inventory journal, an
//      inventory journal without a movement, both with different amounts, a legacy STT cancelled
//      with a -CXL journal (form B), and an STT whose purchase invoice price delta went into the
//      valuation baseline (cancelled or revised invoice);
//   C  value without a journal by design or a cost gap: the valuation baseline rows (WAC drift
//      frozen at release), invariant breaks, delivery notes without movements, active movements
//      valued 0;
//   R  reconciliation items: delivery notes not yet invoiced.
// `amount` is the finding's effect on GL − book value. `isDummy` marks demo-generator rows.
import { Prisma, type PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { legacyCxlPairSql } from '../ledger/legacyCxlPair';
import { purchaseRevisionPrefix } from '../ledger/journalSource';
import { findNonJournalAle } from '../ledger/nonJournalAle';
import { findStockValueInvariantBreaks, inventoryAccountSet } from './inventoryGlCheck';
import { inventoryAccountFor } from './itemMasterGuard';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

export type InventoryGlAuditClass = 'A' | 'B' | 'C' | 'R';

export type InventoryGlAuditKind =
  | 'doc-typed-duplicate'
  | 'non-journal-row'
  | 'movement-without-journal'
  | 'journal-without-movement'
  | 'document-amount-differs'
  | 'legacy-stt-cancel'
  | 'pi-delta-in-baseline'
  | 'valuation-baseline'
  | 'invariant-break'
  | 'do-without-movement'
  | 'zero-value-movement'
  | 'do-uninvoiced';

export const AUDIT_CLASS: Record<InventoryGlAuditKind, InventoryGlAuditClass> = {
  'doc-typed-duplicate': 'A',
  'non-journal-row': 'A',
  'movement-without-journal': 'B',
  'journal-without-movement': 'B',
  'document-amount-differs': 'B',
  'legacy-stt-cancel': 'B',
  'pi-delta-in-baseline': 'B',
  'valuation-baseline': 'C',
  'invariant-break': 'C',
  'do-without-movement': 'C',
  'zero-value-movement': 'C',
  'do-uninvoiced': 'R',
};

export interface InventoryGlAuditRow {
  class: InventoryGlAuditClass;
  kind: InventoryGlAuditKind;
  /** Document, journal or movement number. */
  reference: string;
  date: Date | null;
  accountNumber: string | null;
  itemCode: string | null;
  amount: Decimal;
  isDummy: boolean;
  note: string;
}

interface RawRow {
  kind: InventoryGlAuditKind;
  reference: string;
  date: Date | null;
  account_number: string | null;
  item_code: string | null;
  amount: string;
  is_dummy: boolean;
  note: string | null;
}

/** The prefix every purchase price revision journal's sourceKey starts with (before the invoice id). */
const REVISION_KEY_PREFIX = purchaseRevisionPrefix('x').slice(0, -'x:'.length);

/** A movement value at or below this is a rounding residue, not a finding. */
const AMOUNT_TOLERANCE = '0.005';

async function nonJournalRows(db: Db, ids: readonly string[]): Promise<RawRow[]> {
  const rows = await db.$queryRaw<Array<RawRow & { reference_type: string; reference_id: string; fiscal_year_id: string }>>`
    SELECT ale.reference_type, ale.reference_id, ale.fiscal_year_id,
           COALESCE(si.invoice_number, pi.invoice_number, ale.reference_type || ' ' || ale.reference_id) AS reference,
           MIN(ale.date) AS date, a."accountNumber" AS account_number, NULL::text AS item_code,
           SUM(ale.debit - ale.credit)::text AS amount,
           COALESCE(bool_or(si.is_dummy), bool_or(pi.is_dummy), false) AS is_dummy, NULL::text AS note,
           'non-journal-row' AS kind
      FROM accounting_ledger_entries ale
      JOIN accounts a ON a.id = ale.account_id
      LEFT JOIN sales_invoices si ON ale.reference_type = 'SalesInvoice' AND si.id = ale.reference_id
      LEFT JOIN purchase_invoices pi ON ale.reference_type = 'PurchaseInvoice' AND pi.id = ale.reference_id
     WHERE ale.is_cancelled = false AND ale.reference_type <> 'JournalEntry' AND ale.account_id IN (${Prisma.join([...ids])})
     GROUP BY ale.reference_type, ale.reference_id, ale.fiscal_year_id, si.invoice_number, pi.invoice_number, a."accountNumber"`;
  if (rows.length === 0) return [];
  const dup = await findNonJournalAle(db as Tx, { referenceIds: [...new Set(rows.map((r) => r.reference_id))], duplicatesOnly: true });
  const twice = new Map(dup.rows.map((g) => [`${g.referenceType}|${g.referenceId}|${g.fiscalYearId}`, g.linkedJournal]));
  return rows.map((r) => {
    const key = `${r.reference_type}|${r.reference_id}|${r.fiscal_year_id}`;
    return twice.has(key)
      ? { ...r, kind: 'doc-typed-duplicate', note: `also booked through ${twice.get(key) ?? 'its journal'}` }
      : r;
  });
}

/**
 * Journals vs movements per document. A movement belongs to the journal it links, else to the
 * document whose journal family carries its number (JV-<number>, JV-COGS-<number> and their -R2,
 * -CORR, -CXL satellites; a delivery note's Out to its invoice's COGS journal), else to the price
 * revisions of its purchase invoice. Valuation baseline rows and notes not yet invoiced are
 * classed elsewhere.
 */
async function documentRows(db: Db, ids: readonly string[], role: string | null): Promise<RawRow[]> {
  return db.$queryRaw<RawRow[]>`
    WITH linked AS (
      SELECT DISTINCT journal_entry_id AS id FROM stock_movements WHERE journal_entry_id IS NOT NULL AND is_cancelled = false
    ), jv AS (
      SELECT je.id, je.entry_number, je.date, je.is_dummy, ale.account_id,
             SUM(ale.debit - ale.credit) AS amount,
             CASE
               WHEN je.id IN (SELECT id FROM linked) THEN 'je:' || je.id
               WHEN starts_with(COALESCE(je.source_key, ''), ${REVISION_KEY_PREFIX}) THEN 'rev:' || split_part(je.source_key, ':', 2)
               ELSE 'num:' || regexp_replace(regexp_replace(je.entry_number, '^JV-(COGS-)?', ''), '(-(CXL|CORR|R[0-9]+))+$', '')
             END AS doc_key
        FROM journal_entries je
        JOIN accounting_ledger_entries ale ON ale.reference_type = 'JournalEntry' AND ale.reference_id = je.id AND ale.is_cancelled = false
       WHERE ale.account_id IN (${Prisma.join([...ids])})
       GROUP BY je.id, ale.account_id
    ), mv AS (
      SELECT m.id, m.movement_number, m.date, i.code, i.is_dummy, COALESCE(i.account_id, ${role}) AS account_id, m.value_delta,
             CASE
               WHEN m.journal_entry_id IS NOT NULL THEN 'je:' || m.journal_entry_id
               WHEN m.reference_type = 'PurchaseRevision' THEN 'rev:' || m.reference_id
               WHEN m.reference_type = 'DeliveryOrder' AND si.invoice_number IS NOT NULL THEN 'num:' || si.invoice_number
               WHEN m.reference_number IS NOT NULL THEN 'num:' || m.reference_number
               ELSE 'mv:' || m.id
             END AS doc_key
        FROM stock_movements m
        JOIN inventory_items i ON i.id = m.item_id
        LEFT JOIN delivery_orders dn ON m.reference_type = 'DeliveryOrder' AND dn.id = m.reference_id
        LEFT JOIN sales_invoices si ON si.id = dn.invoice_id
       WHERE m.is_cancelled = false AND m.value_delta <> 0
         AND m.reference_type IS DISTINCT FROM 'ValuationBaseline'
         AND NOT COALESCE(m.reference_type = 'DeliveryOrder' AND m.journal_entry_id IS NULL AND dn.status = 'Submitted' AND dn.invoice_id IS NULL, false)
    ), j_doc AS (
      SELECT doc_key, account_id, SUM(amount) AS amount, MIN(date) AS date, bool_or(is_dummy) AS is_dummy,
             string_agg(entry_number, ' ' ORDER BY entry_number) AS refs,
             bool_and(entry_number LIKE '%-CXL' AND EXISTS (
               SELECT 1 FROM journal_entries orig WHERE orig.entry_number = left(jv.entry_number, -4) AND ${legacyCxlPairSql('orig')}
             )) AS legacy_cxl
        FROM jv GROUP BY doc_key, account_id
    ), m_doc AS (
      SELECT doc_key, account_id, SUM(value_delta) AS amount, MIN(date) AS date, bool_or(is_dummy) AS is_dummy,
             string_agg(DISTINCT code, ' ') AS codes, string_agg(movement_number, ' ' ORDER BY movement_number) AS refs
        FROM mv WHERE account_id IN (${Prisma.join([...ids])}) GROUP BY doc_key, account_id
    )
    SELECT CASE
             WHEN m.doc_key IS NULL AND j.legacy_cxl THEN 'legacy-stt-cancel'
             WHEN m.doc_key IS NULL THEN 'journal-without-movement'
             WHEN j.doc_key IS NULL THEN 'movement-without-journal'
             ELSE 'document-amount-differs'
           END AS kind,
           COALESCE(j.refs, m.refs) AS reference, COALESCE(j.date, m.date) AS date, a."accountNumber" AS account_number,
           m.codes AS item_code,
           (COALESCE(j.amount, 0) - COALESCE(m.amount, 0))::text AS amount,
           COALESCE(j.is_dummy, false) OR COALESCE(m.is_dummy, false) AS is_dummy,
           CASE WHEN j.doc_key IS NOT NULL AND m.doc_key IS NOT NULL
                THEN 'journal ' || j.amount::text || ', movements ' || m.amount::text || ' (' || m.refs || ')' END AS note
      FROM j_doc j
      FULL JOIN m_doc m ON m.doc_key = j.doc_key AND m.account_id = j.account_id
      JOIN accounts a ON a.id = COALESCE(j.account_id, m.account_id)
     WHERE ABS(COALESCE(j.amount, 0) - COALESCE(m.amount, 0)) > ${AMOUNT_TOLERANCE}::numeric`;
}

/** Class C and R rows read straight from the stock tables. */
async function stockRows(db: Db, ids: readonly string[], role: string | null): Promise<RawRow[]> {
  return db.$queryRaw<RawRow[]>`
    WITH items AS (
      SELECT i.id, i.code, i.is_dummy, a."accountNumber" AS account_number
        FROM inventory_items i JOIN accounts a ON a.id = COALESCE(i.account_id, ${role})
       WHERE a.id IN (${Prisma.join([...ids])})
    )
    SELECT 'pi-delta-in-baseline' AS kind, m.movement_number AS reference, m.date, it.account_number, it.code AS item_code,
           '0' AS amount, it.is_dummy,
           'STT value ' || m.total_value::text || ' vs locked cost ' || ROUND(g.locked_unit_cost * m.quantity, 2)::text || '; the delta is in the baseline' AS note
      FROM goods_receipt_items g
      JOIN stock_movements m ON m.id = g.stock_movement_id AND m.is_cancelled = false
      JOIN items it ON it.id = m.item_id
     WHERE ABS(m.total_value - ROUND(g.locked_unit_cost * m.quantity, 2)) > ${AMOUNT_TOLERANCE}::numeric
       AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.adjusts_movement_id = m.id AND r.is_cancelled = false)
    UNION ALL
    SELECT 'valuation-baseline', m.movement_number, m.date, it.account_number, it.code, (-m.value_delta)::text, it.is_dummy,
           'value set at release without a journal'
      FROM stock_movements m JOIN items it ON it.id = m.item_id
     WHERE m.is_cancelled = false AND m.reference_type = 'ValuationBaseline' AND m.value_delta <> 0
    UNION ALL
    SELECT 'zero-value-movement', m.movement_number, m.date, it.account_number, it.code, '0', it.is_dummy,
           m.movement_type::text || ' ' || m.quantity::text || ' valued 0'
      FROM stock_movements m JOIN items it ON it.id = m.item_id
     WHERE m.is_cancelled = false AND m.value_delta = 0 AND m.quantity <> 0
       AND m.movement_type::text IN ('In', 'Out', 'AdjustmentIn', 'AdjustmentOut')
    UNION ALL
    SELECT 'do-uninvoiced', dn.do_number, dn.date, it.account_number, it.code, (-m.value_delta)::text, it.is_dummy,
           'delivered, not invoiced: COGS reaches the ledger with the invoice'
      FROM stock_movements m
      JOIN delivery_orders dn ON m.reference_type = 'DeliveryOrder' AND dn.id = m.reference_id
      JOIN items it ON it.id = m.item_id
     WHERE m.is_cancelled = false AND m.journal_entry_id IS NULL AND dn.status = 'Submitted' AND dn.invoice_id IS NULL
    UNION ALL
    SELECT 'do-without-movement', dn.do_number, dn.date, it.account_number, it.code, '0', it.is_dummy,
           'line ' || di.quantity::text || ' without a stock movement'
      FROM delivery_order_items di
      JOIN delivery_orders dn ON dn.id = di.delivery_order_id AND dn.status = 'Submitted'
      JOIN items it ON it.id = di.inventory_item_id
     WHERE di.stock_movement_id IS NULL`;
}

/** Every finding, by class and kind, then reference. */
export async function findInventoryGlAuditRows(db: Db): Promise<InventoryGlAuditRow[]> {
  const ids = (await inventoryAccountSet(db)).map((a) => a.id);
  if (ids.length === 0) return [];
  const role = await inventoryAccountFor(db as Tx, { accountId: null });
  const [nonJournal, documents, stock, invariant] = await Promise.all([
    nonJournalRows(db, ids),
    documentRows(db, ids, role),
    stockRows(db, ids, role),
    findStockValueInvariantBreaks(db),
  ]);
  const invariantRows: RawRow[] = invariant.rows.map((r) => ({
    kind: 'invariant-break', reference: r.code, date: null, account_number: null, item_code: r.code,
    amount: r.difference.negated().toString(), is_dummy: false, note: `${r.kind}: stock_value ${r.actual.toString()}, expected ${r.expected.toString()}`,
  }));
  return [...nonJournal, ...documents, ...stock, ...invariantRows]
    .map((r) => ({
      class: AUDIT_CLASS[r.kind], kind: r.kind, reference: r.reference, date: r.date, accountNumber: r.account_number,
      itemCode: r.item_code, amount: new Decimal(r.amount), isDummy: r.is_dummy, note: r.note ?? '',
    }))
    .sort((x, y) => x.class.localeCompare(y.class) || x.kind.localeCompare(y.kind) || x.reference.localeCompare(y.reference));
}
