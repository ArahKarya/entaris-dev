// The one finder of differences between inventory value and the General Ledger (E3-R15, plan step 6
// §2.6). Per inventory account it compares the journal ledger rows with the value book (Σ item
// stock_value, i.e. Σ active value_delta) and shows the reconciliation items beside it: delivery
// notes not yet invoiced (their Out left the book, COGS reaches the ledger with the invoice) and the
// document-typed ledger rows step 5 detects (services/ledger/nonJournalAle.ts), which are a column of
// their own so they are not reported twice. Used by the health check (routes/health/inventoryChecks.ts),
// the read-only audit (scripts/repair/e3-inventory-gl-audit.ts) and, later, the year-close check.
import { Prisma, type PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { INVENTORY_ITEM, loadControlAccountMap } from '../ledger/accountGuard';
import { findNonJournalAle } from '../ledger/nonJournalAle';
import { missingMappingError } from '../systemAccounts';
import { assertLedgerInvariant, type LedgerDrift } from './inventoryLedger';
import { inventoryAccountFor } from './itemMasterGuard';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

/** A difference above this on any account is an error (plan §4 PR-6.13a). */
export const INVENTORY_GL_TOLERANCE = new Decimal('0.01');

/** Why an account is in the set: the INVENTORY role (current or former), an item's own account, or a detail sibling. */
export type InventoryAccountKind = 'role' | 'item' | 'sibling';

export interface InventoryAccount {
  id: string;
  accountNumber: string;
  name: string;
  kinds: InventoryAccountKind[];
}

/**
 * The accounts inventory value can sit on: the INVENTORY role account (and former ones), every
 * item's own account, and every detail account under the same group as one of those. The siblings
 * hold no item, but a journal can still have put stock value there; leaving them out would hide it.
 * Sorted by account number.
 */
export async function inventoryAccountSet(db: Db): Promise<InventoryAccount[]> {
  const [control, itemAccounts] = await Promise.all([
    loadControlAccountMap(db as Tx),
    db.inventoryItem.findMany({ where: { accountId: { not: null } }, select: { accountId: true }, distinct: ['accountId'] }),
  ]);
  const kinds = new Map<string, Set<InventoryAccountKind>>();
  const add = (id: string, kind: InventoryAccountKind) => kinds.set(id, (kinds.get(id) ?? new Set()).add(kind));
  for (const [id, roles] of control) {
    if (roles.includes('INVENTORY')) add(id, 'role');
    if (roles.includes(INVENTORY_ITEM)) add(id, 'item');
  }
  for (const { accountId } of itemAccounts) if (accountId) add(accountId, 'item');

  const core = await db.account.findMany({ where: { id: { in: [...kinds.keys()] } }, select: { parentId: true } });
  const parents = [...new Set(core.map((a) => a.parentId).filter((p): p is string => p !== null))];
  const siblings = parents.length === 0
    ? []
    : await db.account.findMany({ where: { parentId: { in: parents }, isGroup: false }, select: { id: true } });
  for (const { id } of siblings) if (!kinds.has(id)) add(id, 'sibling');

  const accounts = await db.account.findMany({
    where: { id: { in: [...kinds.keys()] } },
    select: { id: true, accountNumber: true, name: true },
    orderBy: { accountNumber: 'asc' },
  });
  return accounts.map((a) => ({ ...a, kinds: [...kinds.get(a.id)!].sort() }));
}

export interface InventoryGlDiff {
  /** null on the total row. */
  accountId: string | null;
  accountNumber: string;
  name: string;
  /** Σ debit − credit of the account's active ledger rows of journals (reference_type JournalEntry). */
  gl: Decimal;
  /** Σ stock_value of the items posting to the account (Σ value_delta before `asOf` when given). */
  bookValue: Decimal;
  /** Σ current stock x average; null with `asOf` (a today-only measure). */
  qtyTimesAvg: Decimal | null;
  /** Value of the Out rows of delivery notes not invoiced (yet, or at `asOf`) and without a journal of their own. */
  doUninvoiced: Decimal;
  /** Σ document-typed ledger rows the step-5 check marks as counted twice (nonJournalAle `duplicate`). */
  docTypedDuplicate: Decimal;
  /** Σ the other document-typed ledger rows (outside a journal, not known to be twice). */
  nonJournalOther: Decimal;
  /** Σ (item stock − Σ its warehouses) x average: value no warehouse holds (owner decision #18); null with `asOf`. */
  phantomQtyValue: Decimal | null;
  /** gl − bookValue − doUninvoiced. */
  difference: Decimal;
}

export interface InventoryGlResult {
  accounts: InventoryGlDiff[];
  total: InventoryGlDiff;
}

export interface InventoryGlScope {
  /** Exclusive instant bound (e.g. a fiscal year's end): ledger rows and movements dated before it. */
  asOf?: Date;
  /** Only these accounts of the set. */
  accountIds?: readonly string[];
}

interface AmountRow { account_id: string; amount: string }
interface BookRow { account_id: string; book: string; qty_avg: string; phantom: string }

const ZERO = new Decimal(0);

function sumByAccount(rows: readonly AmountRow[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const r of rows) out.set(r.account_id, (out.get(r.account_id) ?? ZERO).plus(r.amount));
  return out;
}

/**
 * The INVENTORY role account, or ACCOUNT_MAPPING_MISSING when the role is unmapped while an item
 * without an account of its own holds stock or value (its value would have no account to compare with).
 */
async function roleAccountOrMissing(db: Db): Promise<string | null> {
  const role = await inventoryAccountFor(db as Tx, { accountId: null });
  if (role) return role;
  const orphan = await db.inventoryItem.findFirst({
    where: { accountId: null, OR: [{ currentStock: { not: 0 } }, { stockValue: { not: 0 } }] },
    select: { id: true },
  });
  if (orphan) throw missingMappingError('INVENTORY');
  return null;
}

async function journalGl(db: Db, ids: readonly string[], asOf?: Date): Promise<AmountRow[]> {
  const before = asOf ? Prisma.sql`AND ale.date < ${asOf}` : Prisma.empty;
  return db.$queryRaw<AmountRow[]>`
    SELECT ale.account_id, SUM(ale.debit - ale.credit)::text AS amount
      FROM accounting_ledger_entries ale
     WHERE ale.is_cancelled = false AND ale.reference_type = 'JournalEntry'
       AND ale.account_id IN (${Prisma.join([...ids])}) ${before}
     GROUP BY ale.account_id`;
}

/** Document-typed rows per account, split by the nonJournalAle duplicate flag (one classifier). */
async function nonJournalGl(db: Db, ids: readonly string[], asOf?: Date): Promise<{ duplicate: AmountRow[]; other: AmountRow[] }> {
  const before = asOf ? Prisma.sql`AND ale.date < ${asOf}` : Prisma.empty;
  const rows = await db.$queryRaw<Array<AmountRow & { reference_type: string; reference_id: string; fiscal_year_id: string }>>`
    SELECT ale.account_id, ale.reference_type, ale.reference_id, ale.fiscal_year_id, SUM(ale.debit - ale.credit)::text AS amount
      FROM accounting_ledger_entries ale
     WHERE ale.is_cancelled = false AND ale.reference_type <> 'JournalEntry'
       AND ale.account_id IN (${Prisma.join([...ids])}) ${before}
     GROUP BY ale.account_id, ale.reference_type, ale.reference_id, ale.fiscal_year_id`;
  if (rows.length === 0) return { duplicate: [], other: [] };
  const groups = await findNonJournalAle(db as Tx, { referenceIds: [...new Set(rows.map((r) => r.reference_id))], duplicatesOnly: true });
  const twice = new Set(groups.rows.map((g) => `${g.referenceType}|${g.referenceId}|${g.fiscalYearId}`));
  const key = (r: (typeof rows)[number]) => `${r.reference_type}|${r.reference_id}|${r.fiscal_year_id}`;
  return { duplicate: rows.filter((r) => twice.has(key(r))), other: rows.filter((r) => !twice.has(key(r))) };
}

/** Book value per item account (an item without its own account posts to the INVENTORY role account). */
async function bookByAccount(db: Db, role: string | null, asOf?: Date): Promise<BookRow[]> {
  if (asOf) {
    return db.$queryRaw<BookRow[]>`
      SELECT COALESCE(i.account_id, ${role}) AS account_id, SUM(m.value_delta)::text AS book, '0' AS qty_avg, '0' AS phantom
        FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
       WHERE m.is_cancelled = false AND m.date < ${asOf} AND COALESCE(i.account_id, ${role}) IS NOT NULL
       GROUP BY 1`;
  }
  return db.$queryRaw<BookRow[]>`
    WITH wh AS (SELECT item_id, SUM(current_stock) AS qty FROM inventory_stocks GROUP BY item_id)
    SELECT COALESCE(i.account_id, ${role}) AS account_id, SUM(i.stock_value)::text AS book,
           ROUND(SUM(i.current_stock * i.average_cost), 2)::text AS qty_avg,
           ROUND(SUM((i.current_stock - COALESCE(wh.qty, 0)) * i.average_cost), 2)::text AS phantom
      FROM inventory_items i LEFT JOIN wh ON wh.item_id = i.id
     WHERE COALESCE(i.account_id, ${role}) IS NOT NULL
     GROUP BY 1`;
}

/**
 * Σ value of the Out rows of submitted delivery notes not invoiced (at `asOf`: not invoiced before
 * it), whose movement carries no journal. A delivery note that posts its own journal later (JV-DO)
 * moves the value to a clearing account and is then no reconciliation item here.
 */
async function deliveredNotInvoiced(db: Db, role: string | null, asOf?: Date): Promise<AmountRow[]> {
  const open = asOf
    ? Prisma.sql`AND m.date < ${asOf} AND (dn.invoice_id IS NULL OR si.date >= ${asOf})`
    : Prisma.sql`AND dn.invoice_id IS NULL`;
  return db.$queryRaw<AmountRow[]>`
    SELECT COALESCE(i.account_id, ${role}) AS account_id, (-SUM(m.value_delta))::text AS amount
      FROM stock_movements m
      JOIN delivery_orders dn ON m.reference_type = 'DeliveryOrder' AND dn.id = m.reference_id
      JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN sales_invoices si ON si.id = dn.invoice_id
     WHERE m.is_cancelled = false AND m.journal_entry_id IS NULL AND dn.status = 'Submitted'
       AND COALESCE(i.account_id, ${role}) IS NOT NULL ${open}
     GROUP BY 1`;
}

function diffRow(account: { id: string | null; accountNumber: string; name: string }, parts: Omit<InventoryGlDiff, 'accountId' | 'accountNumber' | 'name' | 'difference'>): InventoryGlDiff {
  return {
    accountId: account.id, accountNumber: account.accountNumber, name: account.name, ...parts,
    difference: parts.gl.minus(parts.bookValue).minus(parts.doUninvoiced),
  };
}

function totalOf(rows: readonly InventoryGlDiff[], today: boolean): InventoryGlDiff {
  const sum = (pick: (r: InventoryGlDiff) => Decimal | null) => rows.reduce((s, r) => s.plus(pick(r) ?? 0), ZERO);
  return diffRow({ id: null, accountNumber: 'TOTAL', name: 'Total' }, {
    gl: sum((r) => r.gl), bookValue: sum((r) => r.bookValue), qtyTimesAvg: today ? sum((r) => r.qtyTimesAvg) : null,
    doUninvoiced: sum((r) => r.doUninvoiced), docTypedDuplicate: sum((r) => r.docTypedDuplicate),
    nonJournalOther: sum((r) => r.nonJournalOther), phantomQtyValue: today ? sum((r) => r.phantomQtyValue) : null,
  });
}

/**
 * Per inventory account (inventoryAccountSet, narrowed by `accountIds`), and a total row. Book
 * value is keyed on each item's account today: after an INVENTORY remap or an item account change
 * dated after `asOf`, only the total is exact. Throws ACCOUNT_MAPPING_MISSING (see roleAccountOrMissing).
 */
export async function findInventoryGlDiffs(db: Db, scope: InventoryGlScope = {}): Promise<InventoryGlResult> {
  const role = await roleAccountOrMissing(db);
  const wanted = scope.accountIds ? new Set(scope.accountIds) : null;
  const accounts = (await inventoryAccountSet(db)).filter((a) => !wanted || wanted.has(a.id));
  const today = !scope.asOf;
  if (accounts.length === 0) return { accounts: [], total: totalOf([], today) };
  const ids = accounts.map((a) => a.id);

  const [gl, nonJournal, book, delivered] = await Promise.all([
    journalGl(db, ids, scope.asOf),
    nonJournalGl(db, ids, scope.asOf),
    bookByAccount(db, role, scope.asOf),
    deliveredNotInvoiced(db, role, scope.asOf),
  ]);
  const glBy = sumByAccount(gl);
  const dupBy = sumByAccount(nonJournal.duplicate);
  const otherBy = sumByAccount(nonJournal.other);
  const deliveredBy = sumByAccount(delivered);
  const bookBy = new Map(book.map((b) => [b.account_id, b]));

  const rows = accounts.map((a) => {
    const b = bookBy.get(a.id);
    return diffRow({ id: a.id, accountNumber: a.accountNumber, name: a.name }, {
      gl: glBy.get(a.id) ?? ZERO,
      bookValue: b ? new Decimal(b.book) : ZERO,
      qtyTimesAvg: today ? new Decimal(b?.qty_avg ?? 0) : null,
      doUninvoiced: deliveredBy.get(a.id) ?? ZERO,
      docTypedDuplicate: dupBy.get(a.id) ?? ZERO,
      nonJournalOther: otherBy.get(a.id) ?? ZERO,
      phantomQtyValue: today ? new Decimal(b?.phantom ?? 0) : null,
    });
  });
  return { accounts: rows, total: totalOf(rows, today) };
}

/** An account's difference is over the tolerance, or value sits on stock no warehouse holds. */
export function isInventoryGlBreak(r: InventoryGlDiff): boolean {
  return r.difference.abs().gt(INVENTORY_GL_TOLERANCE) || !(r.phantomQtyValue ?? ZERO).isZero();
}

/** The account carries reconciliation items only (an uninvoiced delivery note, document-typed ledger rows). */
export function hasInventoryGlReconciliation(r: InventoryGlDiff): boolean {
  return !r.doUninvoiced.isZero() || !r.docTypedDuplicate.isZero() || !r.nonJournalOther.isZero();
}

export interface StockValueInvariantBreaks {
  /** Breaks before `limit`. */
  total: number;
  /** Largest |difference| first. */
  rows: LedgerDrift[];
}

/**
 * Items breaking value-ledger invariant (a) stock_value = Σ active value_delta or (b) stock x
 * average = stock_value (inventoryLedger.assertLedgerInvariant, the one rule). Invariant (c), item
 * total = Σ warehouses, is the warehouse drift check's and phantomQtyValue's, not repeated here.
 */
export async function findStockValueInvariantBreaks(db: Db, opts: { limit?: number } = {}): Promise<StockValueInvariantBreaks> {
  const breaks = (await assertLedgerInvariant(db)).filter((d) => !d.reportOnly);
  const sorted = [...breaks].sort((x, y) => y.difference.abs().comparedTo(x.difference.abs()) || x.code.localeCompare(y.code));
  return { total: sorted.length, rows: opts.limit === undefined ? sorted : sorted.slice(0, opts.limit) };
}
