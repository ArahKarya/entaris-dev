// Core of scripts/repair/e4-sales-invoice-audit.ts: legacy sales invoice data from before E4-R1
// (status follows outstanding) and E4-R2 (no cancel under an active return). Five sections:
//   status-mismatch        status differs from the one its outstanding derives; --apply fixes it
//   outstanding-mismatch   outstanding differs from grand total less live allocations, active
//                          returns' AR part and active deposit applications; reported only
//   cancelled-with-returns cancelled invoice that still has a return not cancelled; reported only,
//                          the accountant cancels the return from the menu
//   cancelled-with-settlements
//                          cancelled invoice that still has an allocation from a live payment or
//                          an active deposit application; reported only. Cancelling that payment or
//                          application is refused (INVOICE_OUTSTANDING_RANGE), so the accountant
//                          fixes it with a correcting journal
//   zero-allocations       a Rp 0 payment allocation to a sales invoice; reported only
// Only the status is ever written (no outstanding, no journal), and only with the name of the
// accountant who approved the run, recorded on one audit row per fixed invoice.

import Decimal from 'decimal.js';
import type { InvoiceStatus, Prisma } from '@prisma/client';
import type { prisma } from '../lib/prisma';
import { deriveSalesInvoiceStatus, resyncSalesInvoiceStatusInTx } from './salesInvoiceStatus';

type Db = Prisma.TransactionClient | typeof prisma;

const PAGE = 500;

export type SalesInvoiceAuditSection =
  | 'status-mismatch'
  | 'outstanding-mismatch'
  | 'cancelled-with-returns'
  | 'cancelled-with-settlements'
  | 'zero-allocations';

export interface SalesInvoiceAuditRow {
  section: SalesInvoiceAuditSection;
  invoiceId: string;
  invoiceNumber: string;
  date: Date;
  customer: string;
  status: InvoiceStatus;
  grandTotal: string;
  outstanding: string;
  /** status-mismatch: the derived status. outstanding-mismatch: the expected outstanding. Otherwise the related document numbers. */
  expected: string;
  /** User id of the invoice creator: the audit row of a status fix hangs off it (a script has no user). */
  createdBy: string;
}

interface InvoiceLite {
  id: string;
  invoiceNumber: string;
  date: Date;
  status: InvoiceStatus;
  grandTotal: Prisma.Decimal;
  outstanding: Prisma.Decimal;
  createdBy: string;
  customer: { name: string };
}

const INVOICE_SELECT = {
  id: true, invoiceNumber: true, date: true, status: true, grandTotal: true, outstanding: true, createdBy: true,
  customer: { select: { name: true } },
} as const;

function rowOf(section: SalesInvoiceAuditSection, inv: InvoiceLite, expected: string): SalesInvoiceAuditRow {
  return {
    section,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    date: inv.date,
    customer: inv.customer.name,
    status: inv.status,
    grandTotal: inv.grandTotal.toFixed(2),
    outstanding: inv.outstanding.toFixed(2),
    expected,
    createdBy: inv.createdBy,
  };
}

const sumBy = (rows: Array<{ key: string; amount: Prisma.Decimal | null }>) => {
  const out = new Map<string, Decimal>();
  for (const r of rows) out.set(r.key, (out.get(r.key) ?? new Decimal(0)).plus(r.amount?.toString() ?? 0));
  return out;
};

const byDate = (a: { date: Date; invoiceNumber: string }, b: { date: Date; invoiceNumber: string }) =>
  a.date.getTime() - b.date.getTime() || a.invoiceNumber.localeCompare(b.invoiceNumber);

/** Expected outstanding per invoice: grand total less live allocations, active returns' AR part and active deposit applications. */
async function expectedOutstanding(db: Db, invoices: readonly InvoiceLite[]): Promise<Map<string, Decimal>> {
  const ids = invoices.map((i) => i.id);
  const [allocs, returns, apps] = await Promise.all([
    db.paymentAllocation.groupBy({
      by: ['invoiceId'],
      where: { invoiceType: 'SalesInvoice', invoiceId: { in: ids }, payment: { status: { not: 'Cancelled' } } },
      _sum: { allocatedAmount: true },
    }),
    db.salesReturn.groupBy({
      by: ['salesInvoiceId'],
      where: { salesInvoiceId: { in: ids }, status: { not: 'Cancelled' } },
      _sum: { arReducedAmount: true },
    }),
    db.customerDepositApplication.groupBy({
      by: ['salesInvoiceId'],
      where: { salesInvoiceId: { in: ids }, isCancelled: false },
      _sum: { appliedAmount: true },
    }),
  ]);
  const a = sumBy(allocs.map((r) => ({ key: r.invoiceId, amount: r._sum.allocatedAmount })));
  const r = sumBy(returns.map((x) => ({ key: x.salesInvoiceId, amount: x._sum.arReducedAmount })));
  const d = sumBy(apps.map((x) => ({ key: x.salesInvoiceId, amount: x._sum.appliedAmount })));
  const zero = new Decimal(0);
  return new Map(
    invoices.map((inv) => [
      inv.id,
      new Decimal(inv.grandTotal.toString()).minus(a.get(inv.id) ?? zero).minus(r.get(inv.id) ?? zero).minus(d.get(inv.id) ?? zero),
    ]),
  );
}

/** Cancelled invoices still settled by a live payment allocation or an active deposit application; `expected` lists those documents. */
async function cancelledWithSettlements(db: Db, invoiceIds?: string[]): Promise<SalesInvoiceAuditRow[]> {
  const found: Array<{ inv: InvoiceLite; docs: string[] }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.salesInvoice.findMany({
      where: { status: 'Cancelled', id: { ...(invoiceIds ? { in: invoiceIds } : {}), ...(cursor ? { gt: cursor } : {}) } },
      select: {
        ...INVOICE_SELECT,
        depositApplications: { where: { isCancelled: false }, select: { depositPayment: { select: { paymentNumber: true } } } },
      },
      orderBy: { id: 'asc' },
      take: PAGE,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    const allocs = await db.paymentAllocation.findMany({
      where: { invoiceType: 'SalesInvoice', invoiceId: { in: page.map((i) => i.id) }, payment: { status: { not: 'Cancelled' } } },
      select: { invoiceId: true, payment: { select: { paymentNumber: true } } },
    });
    for (const inv of page) {
      const docs = [
        ...allocs.filter((a) => a.invoiceId === inv.id).map((a) => a.payment.paymentNumber),
        ...inv.depositApplications.map((a) => a.depositPayment.paymentNumber),
      ];
      if (docs.length > 0) found.push({ inv, docs: [...new Set(docs)].sort() });
    }
  }
  found.sort((a, b) => byDate(a.inv, b.inv));
  return found.map(({ inv, docs }) => rowOf('cancelled-with-settlements', inv, docs.join(' ')));
}

/** Read-only. `invoiceIds` limits the scan (tests); omitted, every sales invoice is checked. */
export async function auditSalesInvoices(db: Db, opts: { invoiceIds?: string[] } = {}): Promise<SalesInvoiceAuditRow[]> {
  const scope = opts.invoiceIds ? { id: { in: opts.invoiceIds } } : {};
  const statusRows: SalesInvoiceAuditRow[] = [];
  const outstandingRows: SalesInvoiceAuditRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page: InvoiceLite[] = await db.salesInvoice.findMany({
      where: {
        status: { notIn: ['Draft', 'Cancelled'] },
        id: { ...(opts.invoiceIds ? { in: opts.invoiceIds } : {}), ...(cursor ? { gt: cursor } : {}) },
      },
      select: INVOICE_SELECT,
      orderBy: { id: 'asc' },
      take: PAGE,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    const expected = await expectedOutstanding(db, page);
    for (const inv of page) {
      const derived = deriveSalesInvoiceStatus(inv.outstanding.toString(), inv.grandTotal.toString());
      if (derived !== inv.status) statusRows.push(rowOf('status-mismatch', inv, derived));
      const exp = expected.get(inv.id)!;
      if (!exp.eq(inv.outstanding.toString())) outstandingRows.push(rowOf('outstanding-mismatch', inv, exp.toFixed(2)));
    }
  }

  // Pages run in id order; the report reads by date.
  statusRows.sort(byDate);
  outstandingRows.sort(byDate);

  const cancelled = await db.salesInvoice.findMany({
    where: { ...scope, status: 'Cancelled', returns: { some: { status: { not: 'Cancelled' } } } },
    select: { ...INVOICE_SELECT, returns: { where: { status: { not: 'Cancelled' } }, select: { returnNumber: true }, orderBy: { returnNumber: 'asc' } } },
    orderBy: { date: 'asc' },
  });
  const cancelledRows = cancelled.map((inv) => rowOf('cancelled-with-returns', inv, inv.returns.map((x) => x.returnNumber).join(' ')));
  const settledRows = await cancelledWithSettlements(db, opts.invoiceIds);

  const zeroAllocs = await db.paymentAllocation.findMany({
    where: { invoiceType: 'SalesInvoice', allocatedAmount: 0, ...(opts.invoiceIds ? { invoiceId: { in: opts.invoiceIds } } : {}) },
    select: { invoiceId: true, payment: { select: { paymentNumber: true } } },
  });
  const zeroInvoices = zeroAllocs.length === 0 ? [] : await db.salesInvoice.findMany({
    where: { id: { in: [...new Set(zeroAllocs.map((z) => z.invoiceId))] } },
    select: INVOICE_SELECT,
  });
  const byId = new Map(zeroInvoices.map((i) => [i.id, i]));
  const zeroRows = zeroAllocs.flatMap((z) => {
    const inv = byId.get(z.invoiceId);
    return inv ? [rowOf('zero-allocations', inv, z.payment.paymentNumber)] : [];
  });

  return [...statusRows, ...outstandingRows, ...cancelledRows, ...settledRows, ...zeroRows];
}

export const SALES_INVOICE_STATUS_AUDIT_ACTION = 'e4-sales-invoice-status';

export interface SalesInvoiceStatusFixResult {
  approvedBy: string;
  /** Invoices whose status was corrected. */
  applied: string[];
  /** Planned fixes skipped because the invoice changed since the report. */
  skipped: string[];
}

/**
 * Writes the status-mismatch rows of `rows`: only the status, and only while the invoice still
 * has the status and outstanding the report saw. `approvedBy` (the accountant who approved the
 * run) is required and is recorded on one audit row per corrected invoice. The audit row's user
 * is the invoice creator, since a script has no user of its own; `via: 'repair'` marks it.
 */
export async function applySalesInvoiceStatusFixes(
  db: Prisma.TransactionClient,
  rows: readonly SalesInvoiceAuditRow[],
  approvedBy: string,
): Promise<SalesInvoiceStatusFixResult> {
  const name = approvedBy.trim();
  if (!name) throw new Error('--apply needs --approved-by "<accountant name>"');
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    if (row.section !== 'status-mismatch') continue;
    const ok = await resyncSalesInvoiceStatusInTx(db, {
      id: row.invoiceId, status: row.status, outstanding: row.outstanding, grandTotal: row.grandTotal,
    });
    if (!ok) {
      skipped.push(row.invoiceId);
      continue;
    }
    await db.auditLog.create({
      data: {
        userId: row.createdBy,
        action: SALES_INVOICE_STATUS_AUDIT_ACTION,
        entityType: 'SalesInvoice',
        entityId: row.invoiceId,
        oldValues: { status: row.status, outstanding: row.outstanding },
        newValues: { status: row.expected, approvedBy: name },
        via: 'repair',
        viaMeta: { script: SALES_INVOICE_STATUS_AUDIT_ACTION, approvedBy: name },
      },
    });
    applied.push(row.invoiceId);
  }
  return { approvedBy: name, applied, skipped };
}
