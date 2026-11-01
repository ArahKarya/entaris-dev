/**
 * Integration test: the legacy sales invoice report and its status repair
 * (scripts/repair/e4-sales-invoice-audit.ts, core in services/salesInvoiceAudit.ts; PR-3.10).
 *
 * Fixture year 2184, created inside each rollback transaction (shared with
 * e4SalesInvoiceStatus.integration.test.ts; integration files run one at a time). Legacy states
 * are made by writing the rows directly, as pre-E4 code left them. Every assertion is limited to
 * the fixture invoices (invoiceIds).
 * - Each section finds its fixture: status-mismatch, outstanding-mismatch, cancelled-with-returns,
 *   zero-allocations.
 * - The repair without an approver is refused; with one it changes only the status, writes one
 *   audit row naming the approver, and leaves the ledger and the outstanding as they were.
 * - An invoice changed after the report is skipped.
 * - cancelled-with-settlements: a cancelled invoice still allocated from a live payment, or with an
 *   active deposit application, is reported; a cancelled payment or application is not.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import {
  SALES_INVOICE_STATUS_AUDIT_ACTION,
  applySalesInvoiceStatusFixes,
  auditSalesInvoices,
} from '../../services/salesInvoiceAudit';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let cashAccountId: string;
let actor: { userId: string; role: string };
let fy: FiscalYear;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const cash = await prisma.account.findFirst({ where: { accountNumber: { startsWith: '1.1.' }, isGroup: false } });
  if (!cash) throw new Error('No cash account (1.1.x) configured.');
  cashAccountId = cash.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      systemAccounts.invalidateCache();
      try {
        actor = await createCapUser(tx, ['doc.cancel']);
        fy = await createFiscalYear(tx, { year: Y });
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2184;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function customer(tx: Tx): Promise<string> {
  return (await tx.party.create({ data: { name: `IT-E4A Customer ${tag()}`, partyType: 'Customer' } })).id;
}

const invoice = (tx: Tx, partyId: string, amount: number, date = `${Y}-07-01`) =>
  submitSalesInvoiceInTx(
    tx,
    { date, partyId, items: [{ itemName: 'IT-E4A jasa', itemType: 'service', quantity: 1, rate: amount }] } as any,
    actor.userId,
  );

async function ledger(tx: Tx): Promise<Array<[string, string]>> {
  const rows = await tx.accountingLedgerEntry.groupBy({
    by: ['accountId'],
    where: { fiscalYearId: fy.id, isCancelled: false },
    _sum: { debit: true, credit: true },
    orderBy: { accountId: 'asc' },
  });
  return rows.map((r) => [r.accountId, (Number(r._sum.debit ?? 0) - Number(r._sum.credit ?? 0)).toFixed(2)]);
}

const sections = (rows: Awaited<ReturnType<typeof auditSalesInvoices>>) => rows.map((r) => [r.section, r.invoiceId, r.expected]);

d('legacy sales invoice report and status repair (E4)', () => {
  it('finds each section and repairs only the status, with an approver', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      // Legacy full return: Submitted with nothing outstanding (status-mismatch).
      const returned = await invoice(tx, c, 3 * JT);
      await tx.salesInvoice.update({ where: { id: returned.id }, data: { outstanding: 0 } });
      // Outstanding not matching its documents: 1 jt paid outside any allocation.
      const drifted = await invoice(tx, c, 5 * JT, `${Y}-07-02`);
      await tx.salesInvoice.update({ where: { id: drifted.id }, data: { outstanding: 4 * JT, status: 'PartiallyPaid' } });
      // Cancelled while its return stayed active.
      const cancelled = await invoice(tx, c, 2 * JT, `${Y}-07-03`);
      const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: cancelled.id } });
      const ret = await submitSalesReturnInTx(
        tx,
        { salesInvoiceId: cancelled.id, date: `${Y}-07-10`, items: [{ salesInvoiceItemId: line.id, quantity: 1, restock: false }] } as any,
        actor.userId,
      );
      const retNumber = (await tx.salesReturn.findUniqueOrThrow({ where: { id: ret!.id } })).returnNumber;
      await tx.salesInvoice.update({ where: { id: cancelled.id }, data: { status: 'Cancelled', outstanding: 0 } });
      // Consistent: not reported.
      const clean = await invoice(tx, c, 1 * JT, `${Y}-07-04`);
      // A Rp 0 allocation left by the old auto-allocation (the payment itself is another
      // customer's, unallocated, so the fixtures above keep their figures).
      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-07-20`, partyId: await customer(tx), paymentType: 'Receive', accountId: cashAccountId, amount: 1 * JT },
        actor.userId,
      );
      await tx.paymentAllocation.create({ data: { paymentId: payment.id, invoiceType: 'SalesInvoice', invoiceId: returned.id, allocatedAmount: 0 } });

      const ids = [returned.id, drifted.id, cancelled.id, clean.id];
      const rows = await auditSalesInvoices(tx, { invoiceIds: ids });
      expect(sections(rows)).toEqual([
        ['status-mismatch', returned.id, 'Paid'],
        ['outstanding-mismatch', returned.id, '3000000.00'],
        ['outstanding-mismatch', drifted.id, '5000000.00'],
        ['cancelled-with-returns', cancelled.id, retNumber],
        ['zero-allocations', returned.id, payment.paymentNumber],
      ]);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: clean.id } })).status).toBe('Submitted');

      // No approver: refused before anything is written.
      await expect(applySalesInvoiceStatusFixes(tx, rows, '  ')).rejects.toThrow(/--approved-by/);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: returned.id } })).status).toBe('Submitted');

      const before = await ledger(tx);
      const result = await applySalesInvoiceStatusFixes(tx, rows, 'Ibu Akuntan');
      expect(result).toEqual({ approvedBy: 'Ibu Akuntan', applied: [returned.id], skipped: [] });

      const fixed = await tx.salesInvoice.findUniqueOrThrow({ where: { id: returned.id } });
      expect([fixed.status, Number(fixed.outstanding)]).toEqual(['Paid', 0]);
      const untouched = await tx.salesInvoice.findUniqueOrThrow({ where: { id: drifted.id } });
      expect([untouched.status, Number(untouched.outstanding)]).toEqual(['PartiallyPaid', 4 * JT]);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe('Cancelled');
      expect((await tx.salesReturn.findUniqueOrThrow({ where: { id: ret!.id } })).status).toBe('Submitted');
      expect(await ledger(tx)).toEqual(before);

      const audit = await tx.auditLog.findMany({ where: { entityType: 'SalesInvoice', entityId: returned.id, action: SALES_INVOICE_STATUS_AUDIT_ACTION } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        via: 'repair',
        oldValues: { status: 'Submitted', outstanding: '0.00' },
        newValues: { status: 'Paid', approvedBy: 'Ibu Akuntan' },
        viaMeta: { script: SALES_INVOICE_STATUS_AUDIT_ACTION, approvedBy: 'Ibu Akuntan' },
      });

      // The report no longer lists the status fix.
      expect((await auditSalesInvoices(tx, { invoiceIds: ids })).filter((r) => r.section === 'status-mismatch')).toEqual([]);
    });
  });

  it('skips an invoice that changed after the report', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 3 * JT);
      await tx.salesInvoice.update({ where: { id: si.id }, data: { outstanding: 0 } });
      const rows = await auditSalesInvoices(tx, { invoiceIds: [si.id] });
      expect(rows.filter((r) => r.section === 'status-mismatch')).toHaveLength(1);

      // Touched in between (e.g. the accountant corrected it by hand).
      await tx.salesInvoice.update({ where: { id: si.id }, data: { outstanding: 3 * JT } });
      const result = await applySalesInvoiceStatusFixes(tx, rows, 'Ibu Akuntan');
      expect(result).toEqual({ approvedBy: 'Ibu Akuntan', applied: [], skipped: [si.id] });
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: si.id } })).status).toBe('Submitted');
      expect(await tx.auditLog.count({ where: { entityId: si.id, action: SALES_INVOICE_STATUS_AUDIT_ACTION } })).toBe(0);
    });
  });

  it('reports cancelled invoices still settled by a live payment or deposit application', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const paid = await invoice(tx, c, 2 * JT);
      const applied = await invoice(tx, c, 1 * JT, `${Y}-07-02`);
      const voided = await invoice(tx, c, 1 * JT, `${Y}-07-03`);
      // Documents of another customer, unallocated, then linked by hand as pre-guard code left them.
      const other = await customer(tx);
      const receive = (amount: number, paymentType: 'Receive' | 'CustomerDeposit' = 'Receive') =>
        submitPaymentInTx(tx, { date: `${Y}-07-20`, partyId: other, paymentType, accountId: cashAccountId, amount }, actor.userId);
      const { payment: live } = await receive(2 * JT);
      const { payment: dead } = await receive(1 * JT);
      const { payment: deposit } = await receive(1 * JT, 'CustomerDeposit');
      await tx.paymentAllocation.create({ data: { paymentId: live.id, invoiceType: 'SalesInvoice', invoiceId: paid.id, allocatedAmount: 2 * JT } });
      await tx.paymentAllocation.create({ data: { paymentId: dead.id, invoiceType: 'SalesInvoice', invoiceId: voided.id, allocatedAmount: 1 * JT } });
      await tx.payment.update({ where: { id: dead.id }, data: { status: 'Cancelled' } });
      await tx.customerDepositApplication.create({ data: { depositPaymentId: deposit.id, salesInvoiceId: applied.id, appliedAmount: 1 * JT, createdBy: actor.userId } });
      await tx.customerDepositApplication.create({
        data: { depositPaymentId: deposit.id, salesInvoiceId: voided.id, appliedAmount: 1 * JT, createdBy: actor.userId, isCancelled: true },
      });
      await tx.salesInvoice.updateMany({ where: { id: { in: [paid.id, applied.id, voided.id] } }, data: { status: 'Cancelled', outstanding: 0 } });

      const rows = await auditSalesInvoices(tx, { invoiceIds: [paid.id, applied.id, voided.id] });
      expect(sections(rows)).toEqual([
        ['cancelled-with-settlements', paid.id, live.paymentNumber],
        ['cancelled-with-settlements', applied.id, deposit.paymentNumber],
      ]);
      // Report only: the repair writes nothing for this section.
      expect(await applySalesInvoiceStatusFixes(tx, rows, 'Ibu Akuntan')).toEqual({ approvedBy: 'Ibu Akuntan', applied: [], skipped: [] });
    });
  });
});
