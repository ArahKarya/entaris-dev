// Built-in year-close checks (E1-R8), registered by services/fiscalYearClose.ts in this order.
// Each looks at one fiscal year; documents count when their date falls inside the year's business
// days (half-open WIB range, see fiscalYearRange).
import { Prisma } from '@prisma/client';
import { businessDayOf } from '../utils/businessDate';
import { systemAccounts } from './systemAccounts';
import { findAleJournalMismatches } from './ledger/aleSyncCheck';
import { findNonJournalAle } from './ledger/nonJournalAle';
import { planSttCancelLegacy } from './ledger/sttCancelLegacy';
import { findUnbalancedAleGroups } from './ledger/ledgerAudit/sections/aleGroups';
import { SYSTEM_ACCOUNT_ROLES } from '../types/systemAccounts';
import { DOCUMENT_RULE, postableAccountProblem } from './ledger/accountGuard';
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

/**
 * The year's active ledger rows balance: debit = credit for every source document (and so for the
 * year). Items are the unbalanced documents, keyed `<type>:<id>@<fiscal year id>`; baseline-aware.
 * The definition is the ledger audit's (findUnbalancedAleGroups); a balanced group split over
 * several years is the audit's and the trigger's concern, not this check's.
 */
const ledgerBalanced: CloseCheck = {
  id: 'ledger-balanced',
  severity: 'block',
  baselineAware: true,
  async run(tx, fy) {
    const rows = await findUnbalancedAleGroups(tx, { fiscalYearId: fy.id, includeFySplit: false });
    return {
      count: rows.length,
      items: rows.map((r) => ({
        key: `${r.referenceType}:${r.referenceId}@${fy.id}`,
        kind: r.referenceType,
        label: r.label,
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

/**
 * Documents of the year booked twice: ledger rows of the document itself (reference_type other than
 * JournalEntry, left from old generators) next to its own journal in the same year (JV-<number> or
 * the payment's journal). Rows that only look like an unrelated journal's (twin rows) are reported by
 * the health check and the ledger audit but do not block: a later posting with the same amount could
 * otherwise add an item after the baseline was captured, with no way to baseline it. The close
 * profit adds every reference type, and ale-vs-journal and ledger-balanced do not see the double (it
 * is balanced and not a journal's), so without this check Retained Earnings would take the double
 * and lock it.
 * Items are keyed `<type>:<id>@<fiscal year id>`, amount = the document rows' debit; baseline-aware,
 * so an old double the accountant accepted does not block.
 */
const nonJournalAleDuplicate: CloseCheck = {
  id: 'non-journal-ale-duplicate',
  severity: 'block',
  baselineAware: true,
  async run(tx, fy) {
    const { rows } = await findNonJournalAle(tx, { fiscalYearId: fy.id, duplicatesOnly: true });
    return {
      count: rows.length,
      items: rows.map((r) => ({
        key: `${r.referenceType}:${r.referenceId}@${fy.id}`,
        kind: r.referenceType,
        label: r.label,
        date: day(r.date),
        amount: money(r.debit),
      })),
    };
  },
};

/**
 * STTs cancelled the old way (original Cancelled next to a JV-<stt>-CXL, not yet paired) with a
 * journal booked to this year: class A, B, C and REVIEW of services/ledger/sttCancelLegacy.ts. Class
 * B is invisible to every ledger check (both journals look consistent) while Inventory and the
 * uninvoiced payable are off by its amount. A warning until scripts/repair/e1-stt-cancel-model.ts has
 * run in production (owner decision #5c); items keyed GoodsReceipt:<id>, label "<stt> (<class>)".
 */
const legacySttCancel: CloseCheck = {
  id: 'legacy-stt-cancel',
  severity: 'warn',
  async run(tx, fy) {
    const rows = (await planSttCancelLegacy(tx, { fiscalYearId: fy.id })).filter((r) => r.cls !== 'PAIRED');
    return {
      count: rows.length,
      items: rows.slice(0, LIMIT).map((r) => ({
        key: `GoodsReceipt:${r.sttId}`,
        kind: 'GoodsReceipt',
        label: `${r.sttNumber} (${r.cls})`,
        date: r.original?.day ?? r.cxl.day,
        amount: money(r.amount),
      })),
    };
  },
};

const CLOSE_ROLES = ['CURRENT_PROFIT', 'RETAINED_EARNINGS'] as const;

/**
 * The close posts to CURRENT_PROFIT and RETAINED_EARNINGS through postJournal (DOCUMENT_RULE): both
 * must be mapped to an account that rule accepts (it exists, is a detail account and is active).
 */
const systemAccountsMapped: CloseCheck = {
  id: 'system-accounts',
  severity: 'block',
  async run(tx) {
    const missing: CloseCheckItem[] = [];
    for (const role of CLOSE_ROLES) {
      const [mapped] = await systemAccounts.getAccounts(role);
      const account = mapped
        ? await tx.account.findUnique({
          where: { id: mapped.id },
          select: { id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true },
        })
        : null;
      if (!mapped || postableAccountProblem(account, DOCUMENT_RULE, null)) {
        missing.push({ key: role, kind: 'SystemAccountRole', label: SYSTEM_ACCOUNT_ROLES[role].label });
      }
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
  nonJournalAleDuplicate,
  legacySttCancel,
  systemAccountsMapped,
  deliveryOrdersUninvoiced,
];
