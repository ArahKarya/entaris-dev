/**
 * Integration test: sales invoice status follows the outstanding amount (E4-R1, PR-3.10).
 *
 * Fixture year 2184 (unique to this file; e4SalesInvoiceAuditScript.integration.test.ts reuses its
 * own 2184 fixtures). Service invoices without tax, so every figure is the line total. Everything
 * runs in a rollback transaction; route handlers through the route harness.
 * - Part return then payment, return cancel then payment again.
 * - Full return leaves the invoice Paid, and a later payment makes no Rp 0 allocation.
 * - A legacy Submitted invoice with nothing outstanding is skipped by the payment.
 * - Payment cancel after a return gives PartiallyPaid, not Submitted.
 * - Deposit apply, apply cancel and offset.
 * - A refund linked to its source payment.
 * - The helper refuses a change outside [0, grand total] and a cancelled invoice.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { cancelSalesReturnInTx } from '../../services/salesReturnCancel';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { INVOICE_OUTSTANDING_RANGE, setSalesInvoiceOutstandingInTx } from '../../services/salesInvoiceStatus';
import { BusinessError } from '../../utils/errors';
import { businessDayOf } from '../../utils/businessDate';
import paymentsRouter from '../../routes/payments';
import customerDepositsRouter from '../../routes/customerDeposits';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let cashAccountId: string;
let actor: { userId: string; role: string };

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
        await createFiscalYear(tx, { year: Y });
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
  return (await tx.party.create({ data: { name: `IT-E4S Customer ${tag()}`, partyType: 'Customer' } })).id;
}

/** A service invoice of `qty` × `rate`, no tax. */
async function invoice(tx: Tx, partyId: string, qty: number, rate: number, date = `${Y}-03-01`) {
  return submitSalesInvoiceInTx(
    tx,
    { date, partyId, items: [{ itemName: 'IT-E4S jasa', itemType: 'service', quantity: qty, rate }] } as any,
    actor.userId,
  );
}

async function returnQty(tx: Tx, invoiceId: string, quantity: number, date = `${Y}-03-10`) {
  const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoiceId } });
  const ret = await submitSalesReturnInTx(
    tx,
    { salesInvoiceId: invoiceId, date, items: [{ salesInvoiceItemId: line.id, quantity, restock: false }] } as any,
    actor.userId,
  );
  if (!ret) throw new Error('Return not created.');
  return ret;
}

const receive = (tx: Tx, partyId: string, amount: number, date = `${Y}-04-01`) =>
  submitPaymentInTx(tx, { date, partyId, paymentType: 'Receive', accountId: cashAccountId, amount }, actor.userId);

async function inv(tx: Tx, id: string) {
  const row = await tx.salesInvoice.findUniqueOrThrow({ where: { id } });
  return { status: row.status, outstanding: Number(row.outstanding) };
}

const allocationsTo = (tx: Tx, invoiceId: string) =>
  tx.paymentAllocation.findMany({ where: { invoiceType: 'SalesInvoice', invoiceId } });

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

/** A year open for today, which the deposit apply route posts into. */
async function ensureOpenToday(tx: Tx) {
  const today = new Date();
  const open = await tx.fiscalYear.findFirst({ where: { startDate: { lte: today }, endDate: { gte: today }, isClosed: false } });
  if (!open) await createFiscalYear(tx, { year: Number(businessDayOf(today).slice(0, 4)) });
}

d('sales invoice status follows the outstanding (E4-R1)', () => {
  it('part return, payment, return cancel, payment again', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 5, 2 * JT);
      expect(await inv(tx, si.id)).toEqual({ status: 'Submitted', outstanding: 10 * JT });

      const ret = await returnQty(tx, si.id, 1);
      expect(await inv(tx, si.id)).toEqual({ status: 'PartiallyPaid', outstanding: 8 * JT });

      await receive(tx, c, 8 * JT);
      expect(await inv(tx, si.id)).toEqual({ status: 'Paid', outstanding: 0 });

      await cancelSalesReturnInTx(tx, ret.id);
      expect(await inv(tx, si.id)).toEqual({ status: 'PartiallyPaid', outstanding: 2 * JT });

      const { payment } = await receive(tx, c, 2 * JT, `${Y}-04-02`);
      const allocs = await tx.paymentAllocation.findMany({ where: { paymentId: payment.id } });
      expect(allocs.map((a) => [a.invoiceId, Number(a.allocatedAmount)])).toEqual([[si.id, 2 * JT]]);
      expect(await inv(tx, si.id)).toEqual({ status: 'Paid', outstanding: 0 });
    });
  });

  it('a full return leaves the invoice Paid, and a later payment makes no Rp 0 allocation', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 1, 3 * JT);
      await returnQty(tx, si.id, 1);
      expect(await inv(tx, si.id)).toEqual({ status: 'Paid', outstanding: 0 });

      const { unallocatedAmount } = await receive(tx, c, 1 * JT);
      expect(await allocationsTo(tx, si.id)).toEqual([]);
      expect(unallocatedAmount).toBe(1 * JT);
    });
  });

  it('skips a legacy Submitted invoice with nothing outstanding', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const legacy = await invoice(tx, c, 1, 3 * JT, `${Y}-02-01`);
      const open = await invoice(tx, c, 1, 2 * JT, `${Y}-02-05`);
      // Pre-E4 data: a full return left Submitted with outstanding 0.
      await tx.salesInvoice.update({ where: { id: legacy.id }, data: { outstanding: 0 } });

      const { payment } = await receive(tx, c, 1 * JT);
      expect(await allocationsTo(tx, legacy.id)).toEqual([]);
      const allocs = await tx.paymentAllocation.findMany({ where: { paymentId: payment.id } });
      expect(allocs.map((a) => [a.invoiceId, Number(a.allocatedAmount)])).toEqual([[open.id, 1 * JT]]);
      expect(await inv(tx, legacy.id)).toEqual({ status: 'Submitted', outstanding: 0 });
      expect(await inv(tx, open.id)).toEqual({ status: 'PartiallyPaid', outstanding: 1 * JT });
    });
  });

  it('payment cancel after a return gives PartiallyPaid', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 5, 2 * JT);
      await returnQty(tx, si.id, 1);
      const { payment } = await receive(tx, c, 8 * JT);
      expect((await inv(tx, si.id)).status).toBe('Paid');

      const r = await callRoute(paymentsRouter, 'post', '/:id/cancel', { params: { id: payment.id }, body: {}, ...actor });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await inv(tx, si.id)).toEqual({ status: 'PartiallyPaid', outstanding: 8 * JT });
    });
  });

  it('deposit apply, apply cancel and offset', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 1, 10 * JT);
      const { payment: deposit } = await submitPaymentInTx(
        tx,
        { date: `${Y}-03-06`, partyId: c, paymentType: 'CustomerDeposit', accountId: cashAccountId, amount: 10 * JT },
        actor.userId,
      );
      await ensureOpenToday(tx);

      const applied = await callRoute(customerDepositsRouter, 'post', '/apply', {
        body: { depositPaymentId: deposit.id, salesInvoiceId: si.id, amount: 4 * JT },
        ...actor,
      });
      expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
      expect(await inv(tx, si.id)).toEqual({ status: 'PartiallyPaid', outstanding: 6 * JT });

      const cancelled = await callRoute(customerDepositsRouter, 'post', '/apply/:id/cancel', {
        params: { id: applied.body.id }, body: {}, ...actor,
      });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(await inv(tx, si.id)).toEqual({ status: 'Submitted', outstanding: 10 * JT });

      const offset = await callRoute(customerDepositsRouter, 'post', '/:id/refund', {
        params: { id: deposit.id }, body: { date: `${Y}-05-01`, offsetAmount: 10 * JT, cashAmount: 0 }, ...actor,
      });
      expect(offset.status, JSON.stringify(offset.body)).toBeLessThan(300);
      expect(await inv(tx, si.id)).toEqual({ status: 'Paid', outstanding: 0 });
    });
  });

  it('a refund linked to its source payment reopens the invoice by the refunded amount', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 1, 10 * JT);
      const { payment } = await receive(tx, c, 10 * JT);
      expect((await inv(tx, si.id)).status).toBe('Paid');

      await submitPaymentInTx(
        tx,
        { date: `${Y}-04-05`, partyId: c, paymentType: 'CustomerRefund', accountId: cashAccountId, amount: 3 * JT, refundSourcePaymentId: payment.id } as any,
        actor.userId,
      );
      expect(await inv(tx, si.id)).toEqual({ status: 'PartiallyPaid', outstanding: 3 * JT });
      expect((await allocationsTo(tx, si.id)).map((a) => Number(a.allocatedAmount))).toEqual([7 * JT]);
    });
  });

  it('the helper refuses a change outside [0, grand total] and a cancelled invoice', async () => {
    await inRollback(async (tx) => {
      const c = await customer(tx);
      const si = await invoice(tx, c, 1, 1 * JT);
      expect(await codeOf(setSalesInvoiceOutstandingInTx(tx, si.id, { delta: 1 }))).toBe(INVOICE_OUTSTANDING_RANGE);
      expect(await codeOf(setSalesInvoiceOutstandingInTx(tx, si.id, { delta: -(JT + 1) }))).toBe(INVOICE_OUTSTANDING_RANGE);
      expect(await inv(tx, si.id)).toEqual({ status: 'Submitted', outstanding: 1 * JT });

      await tx.salesInvoice.update({ where: { id: si.id }, data: { status: 'Cancelled', outstanding: 0 } });
      expect(await codeOf(setSalesInvoiceOutstandingInTx(tx, si.id, { delta: 100 }))).toBe(INVOICE_OUTSTANDING_RANGE);
    });
  });
});
