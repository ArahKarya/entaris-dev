// Built-in year-close checks (E1-R8), registered by services/fiscalYearClose.ts in this order.
// Each looks at one fiscal year; documents count when their date falls inside the year's business
// days (half-open WIB range, see fiscalYearRange).
import { Prisma } from '@prisma/client';
import { businessDayOf } from '../utils/businessDate';
import { systemAccounts } from './systemAccounts';
import { findAleJournalMismatches } from './ledger/aleSyncCheck';
import { SYSTEM_ACCOUNT_ROLES } from '../types/systemAccounts';
import { CLOSE_CHECK_ITEM_LIMIT, type CloseCheck, type CloseCheckItem, type CloseCheckOutcome, type CloseCheckYear } from './fiscalYearCloseTypes';

const LIMIT = CLOSE_CHECK_ITEM_LIMIT;
const money = (v: Prisma.Decimal | string | number): string => new Prisma.Decimal(v).toFixed(2);
const day = (d: Date): string => businessDayOf(d);
const inYear = (fy: CloseCheckYear) => ({ gte: fy.gte, lt: fy.lt });

/** Adds lists of (count, first items) from several sources into one outcome. */
function merge(parts: Array<[number, CloseCheckItem[]]>): CloseCheckOutcome {
  return {
    count: parts.reduce((s, [n]) => s + n, 0),
    items: parts.flatMap(([, items]) => items).slice(0, LIMIT),
  };
}

/** Every earlier fiscal year must be closed first. */
const prevYearOpen: CloseCheck = {
  id: 'prev-year-open',
  severity: 'block',
  async run(tx, fy) {
    const rows = await tx.fiscalYear.findMany({
      where: { endDate: { lt: fy.startDate }, isClosed: false },
      orderBy: { startDate: 'asc' },
      select: { id: true, name: true, endDate: true },
    });
    return { count: rows.length, items: rows.map((r) => ({ key: r.id, kind: 'FiscalYear', label: r.name, date: day(r.endDate) })) };
  },
};

/** Draft journals, invoices and payments dated in the year: post or delete them before closing. */
const draftsLedger: CloseCheck = {
  id: 'drafts-ledger',
  severity: 'block',
  async run(tx, fy) {
    const where = { status: 'Draft' as const, date: inYear(fy) };
    const take = LIMIT;
    const orderBy = { date: 'asc' as const };
    const [journals, nJournals, sales, nSales, purchases, nPurchases, payments, nPayments] = await Promise.all([
      tx.journalEntry.findMany({ where, orderBy, take, select: { id: true, entryNumber: true, date: true } }),
      tx.journalEntry.count({ where }),
      tx.salesInvoice.findMany({ where, orderBy, take, select: { id: true, invoiceNumber: true, date: true, grandTotal: true } }),
      tx.salesInvoice.count({ where }),
      tx.purchaseInvoice.findMany({ where, orderBy, take, select: { id: true, invoiceNumber: true, date: true, grandTotal: true } }),
      tx.purchaseInvoice.count({ where }),
      tx.payment.findMany({ where, orderBy, take, select: { id: true, paymentNumber: true, date: true, amount: true } }),
      tx.payment.count({ where }),
    ]);
    return merge([
      [nJournals, journals.map((r) => ({ key: `JournalEntry:${r.id}`, kind: 'JournalEntry', label: r.entryNumber, date: day(r.date) }))],
      [nSales, sales.map((r) => ({ key: `SalesInvoice:${r.id}`, kind: 'SalesInvoice', label: r.invoiceNumber, date: day(r.date), amount: money(r.grandTotal) }))],
      [nPurchases, purchases.map((r) => ({ key: `PurchaseInvoice:${r.id}`, kind: 'PurchaseInvoice', label: r.invoiceNumber, date: day(r.date), amount: money(r.grandTotal) }))],
      [nPayments, payments.map((r) => ({ key: `Payment:${r.id}`, kind: 'Payment', label: r.paymentNumber, date: day(r.date), amount: money(r.amount) }))],
    ]);
  },
};

/** Other open drafts dated in the year (cash book, production, stock transfer, stock opname): a warning. */
const draftsOther: CloseCheck = {
  id: 'drafts-other',
  severity: 'warn',
  async run(tx, fy) {
    const range = inYear(fy);
    const take = LIMIT;
    const cashWhere = { status: { in: ['Draft', 'PartiallyPosted'] }, entryDate: range };
    const prodWhere = { status: { in: ['Draft', 'PendingApproval'] }, date: range };
    const transferWhere = { status: 'Draft' as const, date: range };
    const opnameWhere = { status: 'Draft' as const, date: range };
    const [cash, nCash, prod, nProd, transfers, nTransfers, opnames, nOpnames] = await Promise.all([
      tx.cashBookDraft.findMany({ where: cashWhere, orderBy: { entryDate: 'asc' }, take, select: { id: true, draftNumber: true, entryDate: true } }),
      tx.cashBookDraft.count({ where: cashWhere }),
      tx.productionRunDraft.findMany({ where: prodWhere, orderBy: { date: 'asc' }, take, select: { id: true, draftNumber: true, date: true } }),
      tx.productionRunDraft.count({ where: prodWhere }),
      tx.stockTransfer.findMany({ where: transferWhere, orderBy: { date: 'asc' }, take, select: { id: true, transferNumber: true, date: true } }),
      tx.stockTransfer.count({ where: transferWhere }),
      tx.stockOpname.findMany({ where: opnameWhere, orderBy: { date: 'asc' }, take, select: { id: true, opnameNumber: true, date: true } }),
      tx.stockOpname.count({ where: opnameWhere }),
    ]);
    return merge([
      [nCash, cash.map((r) => ({ key: `CashBookDraft:${r.id}`, kind: 'CashBookDraft', label: r.draftNumber, date: day(r.entryDate) }))],
      [nProd, prod.map((r) => ({ key: `ProductionRunDraft:${r.id}`, kind: 'ProductionRunDraft', label: r.draftNumber, date: day(r.date) }))],
      [nTransfers, transfers.map((r) => ({ key: `StockTransfer:${r.id}`, kind: 'StockTransfer', label: r.transferNumber, date: day(r.date) }))],
      [nOpnames, opnames.map((r) => ({ key: `StockOpname:${r.id}`, kind: 'StockOpname', label: r.opnameNumber, date: day(r.date) }))],
    ]);
  },
};

/**
 * Scheduled depreciation of active assets for months of this year that is not posted yet. Only the
 * year's own months: an earlier year is closed first (prev-year-open), and its schedule was checked
 * when it closed.
 */
const depreciationUnposted: CloseCheck = {
  id: 'depreciation-unposted',
  severity: 'block',
  async run(tx, fy) {
    const where = { isPosted: false, periodDate: inYear(fy), fixedAsset: { status: 'Active' } };
    const [rows, count] = await Promise.all([
      tx.depreciationEntry.findMany({
        where,
        orderBy: [{ periodDate: 'asc' }, { fixedAsset: { assetNumber: 'asc' } }],
        take: LIMIT,
        select: { id: true, periodDate: true, amount: true, fixedAsset: { select: { assetNumber: true, name: true } } },
      }),
      tx.depreciationEntry.count({ where }),
    ]);
    return {
      count,
      items: rows.map((r) => ({
        key: r.id,
        kind: 'DepreciationEntry',
        label: `${r.fixedAsset.assetNumber} ${r.fixedAsset.name}`,
        date: day(r.periodDate),
        amount: money(r.amount),
      })),
    };
  },
};

interface UnbalancedRow {
  reference_type: string;
  reference_id: string;
  label: string | null;
  date: Date | null;
  difference: string;
}

/**
 * The year's active ledger rows balance: debit = credit for every source document (and so for the
 * year). Items are the unbalanced documents, keyed `<type>:<id>@<fiscal year id>`; baseline-aware.
 */
const ledgerBalanced: CloseCheck = {
  id: 'ledger-balanced',
  severity: 'block',
  baselineAware: true,
  async run(tx, fy) {
    const rows = await tx.$queryRaw<UnbalancedRow[]>`
      WITH groups AS (
        SELECT reference_type, reference_id, MIN(date) AS date, SUM(debit) - SUM(credit) AS diff
          FROM accounting_ledger_entries
         WHERE fiscal_year_id = ${fy.id} AND is_cancelled = false
         GROUP BY reference_type, reference_id
        HAVING SUM(debit) <> SUM(credit)
      )
      SELECT g.reference_type, g.reference_id, g.date, ABS(g.diff)::text AS difference,
             COALESCE(je.entry_number, si.invoice_number, pi.invoice_number, p.payment_number) AS label
        FROM groups g
        LEFT JOIN journal_entries je ON g.reference_type = 'JournalEntry' AND je.id = g.reference_id
        LEFT JOIN sales_invoices si ON g.reference_type = 'SalesInvoice' AND si.id = g.reference_id
        LEFT JOIN purchase_invoices pi ON g.reference_type = 'PurchaseInvoice' AND pi.id = g.reference_id
        LEFT JOIN payments p ON g.reference_type = 'Payment' AND p.id = g.reference_id
       ORDER BY ABS(g.diff) DESC, g.reference_id
    `;
    return {
      count: rows.length,
      items: rows.map((r) => ({
        key: `${r.reference_type}:${r.reference_id}@${fy.id}`,
        kind: r.reference_type,
        label: r.label ?? r.reference_id,
        ...(r.date ? { date: day(r.date) } : {}),
        amount: money(r.difference),
      })),
    };
  },
};

/**
 * Journal lines and ledger rows agree per journal and account (services/ledger/aleSyncCheck.ts).
 * Items are keyed `<journal id>@<fiscal year id>`; baseline-aware.
 */
const aleVsJournal: CloseCheck = {
  id: 'ale-vs-journal',
  severity: 'block',
  baselineAware: true,
  async run(tx, fy) {
    const rows = await findAleJournalMismatches(tx, fy.id);
    return {
      count: rows.length,
      items: rows.map((r) => ({
        key: `${r.journalId}@${fy.id}`,
        kind: 'JournalEntry',
        label: r.entryNumber ?? r.journalId,
        ...(r.date ? { date: day(r.date) } : {}),
        amount: money(r.difference),
      })),
    };
  },
};

const CLOSE_ROLES = ['CURRENT_PROFIT', 'RETAINED_EARNINGS'] as const;

/** The close posts to CURRENT_PROFIT and RETAINED_EARNINGS; both must be mapped. */
const systemAccountsMapped: CloseCheck = {
  id: 'system-accounts',
  severity: 'block',
  async run() {
    const missing: CloseCheckItem[] = [];
    for (const role of CLOSE_ROLES) {
      const [account] = await systemAccounts.getAccounts(role);
      if (!account) missing.push({ key: role, kind: 'SystemAccountRole', label: SYSTEM_ACCOUNT_ROLES[role].label });
    }
    return { count: missing.length, items: missing };
  },
};

/** Submitted delivery notes up to the year end that no invoice bills yet: a warning (revenue may be missing). */
const deliveryOrdersUninvoiced: CloseCheck = {
  id: 'do-uninvoiced',
  severity: 'warn',
  async run(tx, fy) {
    const where = { status: 'Submitted' as const, invoiceId: null, date: { lt: fy.lt } };
    const [rows, count] = await Promise.all([
      tx.deliveryOrder.findMany({ where, orderBy: { date: 'asc' }, take: LIMIT, select: { id: true, doNumber: true, date: true } }),
      tx.deliveryOrder.count({ where }),
    ]);
    return { count, items: rows.map((r) => ({ key: r.id, kind: 'DeliveryOrder', label: r.doNumber, date: day(r.date) })) };
  },
};

export const BUILT_IN_CLOSE_CHECKS: readonly CloseCheck[] = [
  prevYearOpen,
  draftsLedger,
  draftsOther,
  depreciationUnposted,
  ledgerBalanced,
  aleVsJournal,
  systemAccountsMapped,
  deliveryOrdersUninvoiced,
];
