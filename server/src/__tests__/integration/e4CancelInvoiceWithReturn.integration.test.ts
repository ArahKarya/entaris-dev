/**
 * Integration test: a sales invoice with an active return cannot be cancelled (E4-R2, PR-3.10).
 *
 * Fixture year 2183 (unique to this file). A stock item delivered, then invoiced:
 * 1,000 kg × 10,000 + PPN 11% = 11.1 jt, cost 8 jt. Everything runs in a rollback transaction;
 * the cancel goes through the route (its own savepoint), so a refused cancel leaves no writes.
 * - Fully returned (so Paid): cancel is refused with INVOICE_HAS_ACTIVE_RETURNS, not "sudah
 *   lunas", and no ledger row of the year moves.
 * - Return cancelled first: the invoice cancels, the customer's AR is 0 in the ledger and the
 *   subledger agrees (findArSubledgerDiffs []).
 * - In a closed year the answer stays PERIOD_CLOSED.
 * - A paid invoice without a return still gets "sudah lunas".
 * - Lock order: return submit, invoice cancel and payment submit all lock the AR account row
 *   before the invoice row, so no two of them can deadlock.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { cancelSalesReturnInTx } from '../../services/salesReturnCancel';
import { cancelSalesInvoiceInTx } from '../../services/invoiceCancellation';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { INVOICE_HAS_ACTIVE_RETURNS } from '../../services/invoiceCancellation';
import { findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import { translateMessage } from '../../i18n/translateMessage';
import salesRouter from '../../routes/sales';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let warehouseId: string;
let cashAccountId: string;
let actor: { userId: string; role: string };

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const wh = await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!wh) throw new Error('No active warehouse.');
  warehouseId = wh.id;
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

let fy: FiscalYear;

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

const Y = 2183;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Sale { customerId: string; invoiceId: string; invoiceNumber: string; lineId: string }

/** 1,000 kg × 10,000 + PPN 11% from a fresh stock item costing 8,000/kg. */
async function sale(tx: Tx): Promise<Sale> {
  const item = await tx.inventoryItem.create({
    data: { code: `IT-E4C-${tag()}`, name: `IT-E4C barang ${tag()}`, unit: 'kg', currentStock: 1_000, averageCost: 8_000, isActive: true },
  });
  await tx.inventoryStock.create({ data: { itemId: item.id, warehouseId, currentStock: 1_000 } });
  const customer = await tx.party.create({ data: { name: `IT-E4C Customer ${tag()}`, partyType: 'Customer' } });
  // Stock leaves through the delivery order; the invoice bills its line.
  const deliveryOrder = await submitDeliveryOrderInTx(
    tx,
    { date: `${Y}-05-01`, partyId: customer.id, items: [{ inventoryItemId: item.id, warehouseId, itemName: item.name, quantity: 1_000, unit: 'kg' }] },
    actor.userId,
  );
  const invoice = await submitSalesInvoiceInTx(
    tx,
    {
      date: `${Y}-05-02`,
      partyId: customer.id,
      items: [{ itemName: item.name, inventoryItemId: item.id, deliveryOrderItemId: deliveryOrder.items[0]!.id, quantity: 1_000, unit: 'kg', rate: 10_000, taxPct: 11 }],
    } as any,
    actor.userId,
  );
  const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
  return { customerId: customer.id, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, lineId: line.id };
}

async function fullReturn(tx: Tx, s: Sale) {
  const ret = await submitSalesReturnInTx(
    tx,
    { salesInvoiceId: s.invoiceId, date: `${Y}-05-10`, items: [{ salesInvoiceItemId: s.lineId, quantity: 1_000, restock: true, warehouseId }] } as any,
    actor.userId,
  );
  if (!ret) throw new Error('Return not created.');
  return tx.salesReturn.findUniqueOrThrow({ where: { id: ret.id } });
}

const cancelInvoice = (invoiceId: string) =>
  callRoute(salesRouter, 'post', '/:id/cancel', { params: { id: invoiceId }, body: {}, ...actor });

/** Σ debit − credit of the year's live ledger rows, per account. */
async function ledgerByAccount(tx: Tx): Promise<Record<string, string>> {
  const rows = await tx.accountingLedgerEntry.groupBy({
    by: ['accountId'],
    where: { fiscalYearId: fy.id, isCancelled: false },
    _sum: { debit: true, credit: true },
  });
  return Object.fromEntries(rows.map((r) => [r.accountId, (Number(r._sum.debit ?? 0) - Number(r._sum.credit ?? 0)).toFixed(2)]));
}

async function arOf(tx: Tx, partyId: string): Promise<number> {
  const arIds = await systemAccounts.getAccountIds('AR');
  const agg = await tx.accountingLedgerEntry.aggregate({
    where: { partyId, accountId: { in: arIds }, isCancelled: false },
    _sum: { debit: true, credit: true },
  });
  return Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
}

d('cancelling a sales invoice with returns (E4-R2)', () => {
  it('refuses while a return is active and moves nothing', async () => {
    await inRollback(async (tx) => {
      const s = await sale(tx);
      expect(Number((await tx.salesInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).grandTotal)).toBe(11_100_000);
      const ret = await fullReturn(tx, s);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe('Paid');
      const before = await ledgerByAccount(tx);

      const r = await cancelInvoice(s.invoiceId);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe(INVOICE_HAS_ACTIVE_RETURNS);
      expect(r.body.error).toBe('Invoice memiliki retur aktif (1). Batalkan retur terlebih dahulu.');
      expect(translateMessage(r.body.error, 'en')).toBe('The invoice has active returns (1). Cancel the returns first.');

      expect(await ledgerByAccount(tx)).toEqual(before);
      const after = await tx.salesInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect(after.status).toBe('Paid');
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${ret.returnNumber}` } })).status).toBe('Submitted');
      expect((await tx.salesReturn.findUniqueOrThrow({ where: { id: ret.id } })).status).toBe('Submitted');
    });
  });

  it('cancels once the return is cancelled; AR ledger and subledger agree at 0', async () => {
    await inRollback(async (tx) => {
      const s = await sale(tx);
      const ret = await fullReturn(tx, s);
      await cancelSalesReturnInTx(tx, ret.id);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe('Submitted');

      const r = await cancelInvoice(s.invoiceId);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe('Cancelled');
      expect(await arOf(tx, s.customerId)).toBe(0);
      expect(await findArSubledgerDiffs(tx, { partyIds: [s.customerId] })).toEqual([]);
    });
  });

  it('answers PERIOD_CLOSED in a closed year, before the return check', async () => {
    await inRollback(async (tx) => {
      const s = await sale(tx);
      await fullReturn(tx, s);
      await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });

      const r = await cancelInvoice(s.invoiceId);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe(PERIOD_CLOSED);
    });
  });

  it('still refuses a paid invoice without a return as already paid', async () => {
    await inRollback(async (tx) => {
      const s = await sale(tx);
      await submitPaymentInTx(
        tx,
        { date: `${Y}-05-20`, partyId: s.customerId, paymentType: 'Receive', accountId: cashAccountId, amount: 11_100_000 },
        actor.userId,
      );
      const r = await cancelInvoice(s.invoiceId);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBeUndefined();
      expect(r.body.error).toBe('Invoice sudah lunas, tidak bisa dibatalkan.');
    });
  });
});

type LockEvent = 'AR' | 'invoice';

/**
 * Wraps `tx` and records, in order, the first time it locks the AR account row and the invoice row
 * (by `invoiceId`, or by `partyId` for payment submit's lock of the customer's open invoices):
 * a raw FOR UPDATE or an update of that row.
 */
function lockRecorder(tx: Tx, rows: { arId: string; invoiceId: string; partyId?: string }) {
  const events: LockEvent[] = [];
  const note = (e: LockEvent) => { if (!events.includes(e)) events.push(e); };
  const invoiceKeys = [rows.invoiceId, rows.partyId].filter(Boolean);
  // Called as a tagged template or with a Prisma.sql object.
  const raw = (fn: (...a: unknown[]) => unknown) =>
    (query: TemplateStringsArray | { strings: readonly string[]; values: unknown[] }, ...rest: unknown[]) => {
      const [strings, values] = 'raw' in query ? [query as readonly string[], rest] : [query.strings, query.values];
      const sql = strings.join('?');
      if (/FOR UPDATE/.test(sql) && /FROM accounts\b/.test(sql) && values.includes(rows.arId)) note('AR');
      if (/FOR UPDATE/.test(sql) && /FROM sales_invoices\b/.test(sql) && values.some((v) => invoiceKeys.includes(v as string))) note('invoice');
      return fn(query, ...rest);
    };
  const delegate = (target: object, id: string, e: LockEvent) => new Proxy(target, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if ((k === 'update' || k === 'updateMany') && typeof v === 'function') {
        return (args: { where?: { id?: unknown } }) => {
          if (args?.where?.id === id) note(e);
          return v.call(t, args);
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const wrapped = new Proxy(tx, {
    get(t, k) {
      if (k === '$queryRaw' || k === '$executeRaw') return raw((Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t));
      if (k === 'account') return delegate(t.account, rows.arId, 'AR');
      if (k === 'salesInvoice') return delegate(t.salesInvoice, rows.invoiceId, 'invoice');
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Tx;
  return { tx: wrapped, events };
}

d('sales invoice writers: lock order (E4)', () => {
  it('a return locks the AR account row before the invoice row, as payment submit does', async () => {
    await inRollback(async (tx) => {
      const s = await sale(tx);
      const arId = (await systemAccounts.getAccount('AR')).id;

      const ret = lockRecorder(tx, { arId, invoiceId: s.invoiceId });
      await submitSalesReturnInTx(
        ret.tx,
        { salesInvoiceId: s.invoiceId, date: `${Y}-05-10`, items: [{ salesInvoiceItemId: s.lineId, quantity: 100, restock: true, warehouseId }] } as any,
        actor.userId,
      );
      expect(ret.events).toEqual(['AR', 'invoice']);

      const pay = lockRecorder(tx, { arId, invoiceId: s.invoiceId, partyId: s.customerId });
      await submitPaymentInTx(
        pay.tx,
        { date: `${Y}-05-20`, partyId: s.customerId, paymentType: 'Receive', accountId: cashAccountId, amount: 1_000_000 },
        actor.userId,
      );
      expect(pay.events).toEqual(['AR', 'invoice']);
    });
  });

  it('an invoice cancel locks the AR account row before the invoice row', async () => {
    await inRollback(async (tx) => {
      const s = await sale(tx);
      const arId = (await systemAccounts.getAccount('AR')).id;
      const cancel = lockRecorder(tx, { arId, invoiceId: s.invoiceId });
      await cancelSalesInvoiceInTx(cancel.tx, s.invoiceId);
      expect(cancel.events).toEqual(['AR', 'invoice']);
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe('Cancelled');
    });
  });
});
