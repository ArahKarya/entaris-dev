/**
 * Integration test: cancel and revise paths respect a closed fiscal year (E1-R1).
 *
 * Each case posts its documents while year Y is open, closes Y, then tries the cancel. The cancel
 * must fail with 400 / BusinessError PERIOD_CLOSED and leave the document, its journals, ledger
 * entries and account balances exactly as they were. Route handlers and services both run through
 * the route harness, whose `$transaction` is a savepoint, so a rejected cancel rolls back its own
 * partial writes the way production does. Everything runs in a rollback transaction in far-future
 * years.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { BusinessError } from '../../utils/errors';
import { PERIOD_CLOSED } from '../../utils/periodGuard';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { cancelSalesInvoiceInTx, cancelPurchaseInvoiceInTx } from '../../services/invoiceCancellation';
import { cancelSalesReturnInTx } from '../../services/salesReturnCancel';
import { revisePurchaseInvoiceInTx } from '../../services/purchaseInvoiceRevise';
import { cancelJournalInTx } from '../../services/gaFinance';
import paymentsRouter from '../../routes/payments';
import customerDepositsRouter from '../../routes/customerDeposits';
import vendorDepositsRouter from '../../routes/vendorDeposits';
import projectGuaranteesRouter from '../../routes/projectGuarantees';
import journalsRouter from '../../routes/journals';
import fixedAssetsRouter from '../../routes/fixedAssets';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;
let cashAccountId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
  const cash = await prisma.account.findFirst({ where: { accountNumber: { startsWith: '1.1.' }, isGroup: false } });
  if (!cash) throw new Error('No cash account (1.1.x) configured.');
  cashAccountId = cash.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

afterEach(() => {
  vi.useRealTimers();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        await fn(tx);
      } finally {
        state.tx = null;
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** The year whose documents are posted and then closed, and the open year after it. */
const Y = 2092;

async function years(tx: Tx): Promise<{ old: FiscalYear; next: FiscalYear }> {
  return { old: await createFiscalYear(tx, { year: Y }), next: await createFiscalYear(tx, { year: Y + 1 }) };
}

function close(tx: Tx, fy: FiscalYear) {
  return tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
}

/** Only the Date clock moves; timers stay real so the transaction timeout keeps working. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

/** A service call in its own savepoint, like the route transaction that wraps it in production. */
function inRouteTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appPrisma.$transaction(fn as (tx: unknown) => Promise<T>) as Promise<T>;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

function expectPeriodClosed(r: RouteResult) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(PERIOD_CLOSED);
  expect(r.body.error).toMatch(/sudah ditutup/);
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function party(tx: Tx, partyType: 'Customer' | 'Supplier') {
  return tx.party.create({ data: { name: `IT-E1-${partyType}-${tag()}`, partyType, isActive: true } });
}

/** Journals, ledger entries and balances of every account they touch, for a before/after compare. */
async function ledgerState(tx: Tx, journalIds: string[]) {
  const journals = await tx.journalEntry.findMany({
    where: { id: { in: journalIds } },
    select: { id: true, status: true, cancelledAt: true },
    orderBy: { id: 'asc' },
  });
  const ale = await tx.accountingLedgerEntry.findMany({
    where: { referenceId: { in: journalIds } },
    select: { id: true, isCancelled: true },
    orderBy: { id: 'asc' },
  });
  const items = await tx.journalItem.findMany({ where: { journalEntryId: { in: journalIds } }, select: { accountId: true } });
  const balances = await tx.account.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.accountId))] } },
    select: { id: true, balance: true },
    orderBy: { id: 'asc' },
  });
  return { journals, ale, balances: balances.map((b) => ({ id: b.id, balance: b.balance.toString() })) };
}

async function journalIdsOf(tx: Tx, documentNumber: string): Promise<string[]> {
  const rows = await tx.journalEntry.findMany({
    where: { OR: [{ entryNumber: { startsWith: `JV-${documentNumber}` } }, { entryNumber: { startsWith: `JV-COGS-${documentNumber}` } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

function serviceInvoice(tx: Tx, partyId: string, date: string, rate: number) {
  return submitSalesInvoiceInTx(
    tx,
    { date, partyId, items: [{ itemName: 'Jasa uji tutup buku', itemType: 'service', quantity: 1, rate }] } as any,
    userId,
  );
}

/** Two balanced lines on two detail accounts. */
async function manualJournal(tx: Tx, fiscalYearId: string, entryNumber: string, date: string, amount = 1_000_000) {
  const [a, b] = await tx.account.findMany({ where: { isGroup: false, isActive: true }, take: 2, orderBy: { accountNumber: 'asc' } });
  if (!a || !b) throw new Error('Need two detail accounts.');
  return tx.journalEntry.create({
    data: {
      entryNumber,
      date: new Date(date),
      status: 'Submitted',
      narration: 'Jurnal uji tutup buku',
      fiscalYearId,
      createdBy: userId,
      submittedAt: new Date(date),
      items: {
        create: [
          { accountId: a.id, debit: amount, credit: 0 },
          { accountId: b.id, debit: 0, credit: amount },
        ],
      },
    },
  });
}

d('closed fiscal year: sales and purchase invoices', () => {
  it('rejects cancelling an 11.1 jt invoice of 15 Dec; journal, ledger and balances unchanged', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const invoice = await serviceInvoice(tx, customer.id, `${Y}-12-15`, 11_100_000);
      await close(tx, old);
      const ids = await journalIdsOf(tx, invoice.invoiceNumber);
      expect(ids.length).toBeGreaterThan(0);
      const before = await ledgerState(tx, ids);

      expect(await codeOf(inRouteTx((t) => cancelSalesInvoiceInTx(t, invoice.id)))).toBe(PERIOD_CLOSED);

      const after = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe('Submitted');
      expect(Number(after.outstanding)).toBe(11_100_000);
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('rejects an open-year invoice whose satellite journal sits in a closed year', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const invoice = await serviceInvoice(tx, customer.id, `${Y + 1}-01-10`, 2_000_000);
      await manualJournal(tx, old.id, `JV-${invoice.invoiceNumber}-CORR`, `${Y}-12-31`);
      await close(tx, old);
      const ids = await journalIdsOf(tx, invoice.invoiceNumber);
      const before = await ledgerState(tx, ids);

      expect(await codeOf(inRouteTx((t) => cancelSalesInvoiceInTx(t, invoice.id)))).toBe(PERIOD_CLOSED);

      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('Submitted');
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('rejects cancelling a purchase invoice in a closed year', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const supplier = await party(tx, 'Supplier');
      const pi = await submitPurchaseInvoiceInTx(
        tx,
        { date: `${Y}-06-10`, partyId: supplier.id, items: [{ itemName: 'Jasa angkut', itemType: 'service', quantity: 1, rate: 3_000_000 }] } as any,
        userId,
      );
      await close(tx, old);
      const ids = await journalIdsOf(tx, pi.invoiceNumber);
      const before = await ledgerState(tx, ids);

      expect(await codeOf(inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id)))).toBe(PERIOD_CLOSED);

      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Submitted');
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('posts a price revision of a closed-year PI into the fiscal year of the revision date', async () => {
    await inRollback(async (tx) => {
      const { old, next } = await years(tx);
      const supplier = await party(tx, 'Supplier');
      const pi = await submitPurchaseInvoiceInTx(
        tx,
        { date: `${Y}-06-10`, partyId: supplier.id, items: [{ itemName: 'Jasa giling', itemType: 'service', quantity: 10, rate: 1_000_000 }] } as any,
        userId,
      );
      const line = await tx.purchaseInvoiceItem.findFirstOrThrow({ where: { purchaseInvoiceId: pi.id } });
      await close(tx, old);

      clockAt(`${Y + 1}-02-10T03:00:00.000Z`);
      await inRouteTx((t) =>
        revisePurchaseInvoiceInTx(t, { invoiceId: pi.id, lines: [{ itemId: line.id, newRate: 1_100_000 }], reason: 'Harga final dari supplier' }, userId),
      );

      const je = await tx.journalEntry.findFirstOrThrow({ where: { narration: { startsWith: `Revisi harga ${pi.invoiceNumber}` } } });
      expect(je.fiscalYearId).toBe(next.id);
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: je.id } });
      expect(ale.length).toBeGreaterThan(0);
      expect(ale.every((a) => a.fiscalYearId === next.id)).toBe(true);
    });
  });

  it('rejects a price revision dated in a closed year', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const supplier = await party(tx, 'Supplier');
      const pi = await submitPurchaseInvoiceInTx(
        tx,
        { date: `${Y}-06-10`, partyId: supplier.id, items: [{ itemName: 'Jasa giling', itemType: 'service', quantity: 10, rate: 1_000_000 }] } as any,
        userId,
      );
      const line = await tx.purchaseInvoiceItem.findFirstOrThrow({ where: { purchaseInvoiceId: pi.id } });
      await close(tx, old);

      clockAt(`${Y}-12-20T03:00:00.000Z`);
      const code = await codeOf(
        inRouteTx((t) =>
          revisePurchaseInvoiceInTx(t, { invoiceId: pi.id, lines: [{ itemId: line.id, newRate: 1_100_000 }], reason: 'Harga final dari supplier' }, userId),
        ),
      );
      expect(code).toBe(PERIOD_CLOSED);
      expect(Number((await tx.purchaseInvoiceItem.findUniqueOrThrow({ where: { id: line.id } })).rate)).toBe(1_000_000);
    });
  });
});

d('closed fiscal year: cash, deposits and returns', () => {
  it('rejects a payment cancel', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const invoice = await serviceInvoice(tx, customer.id, `${Y}-11-01`, 5_000_000);
      const { payment } = await submitPaymentInTx(
        tx,
        {
          date: `${Y}-11-20`, partyId: customer.id, amount: 5_000_000, paymentType: 'Receive', accountId: cashAccountId,
          allocations: [{ invoiceType: 'SalesInvoice', invoiceId: invoice.id, amount: 5_000_000 }],
        } as any,
        userId,
      );
      await close(tx, old);
      const ids = await journalIdsOf(tx, payment.paymentNumber);
      const before = await ledgerState(tx, ids);

      expectPeriodClosed(await callRoute(paymentsRouter, 'post', '/:id/cancel', { params: { id: payment.id }, userId }));

      expect((await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).not.toBe('Cancelled');
      expect((await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('Paid');
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('rejects a customer deposit cancel', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-10-01`, partyId: customer.id, amount: 10_000_000, paymentType: 'CustomerDeposit', accountId: cashAccountId } as any,
        userId,
      );
      await close(tx, old);
      const ids = payment.journalEntryId ? [payment.journalEntryId] : await journalIdsOf(tx, payment.paymentNumber);
      const before = await ledgerState(tx, ids);

      expectPeriodClosed(await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId }));

      expect((await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).not.toBe('Cancelled');
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: customer.id } })).customerDepositBalance)).toBe(10_000_000);
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('rejects a supplier deposit cancel', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const supplier = await party(tx, 'Supplier');
      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-10-01`, partyId: supplier.id, amount: 10_000_000, paymentType: 'VendorDeposit', accountId: cashAccountId } as any,
        userId,
      );
      await close(tx, old);
      const ids = payment.journalEntryId ? [payment.journalEntryId] : await journalIdsOf(tx, payment.paymentNumber);
      const before = await ledgerState(tx, ids);

      expectPeriodClosed(await callRoute(vendorDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId }));

      expect((await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).not.toBe('Cancelled');
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: supplier.id } })).depositBalance)).toBe(10_000_000);
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('rejects cancelling a deposit application whose journal sits in a closed year', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const invoice = await serviceInvoice(tx, customer.id, `${Y}-12-01`, 4_000_000);
      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-11-01`, partyId: customer.id, amount: 4_000_000, paymentType: 'CustomerDeposit', accountId: cashAccountId } as any,
        userId,
      );
      // The application journal is dated at apply time.
      clockAt(`${Y}-12-20T03:00:00.000Z`);
      const applied = await callRoute(customerDepositsRouter, 'post', '/apply', {
        body: { depositPaymentId: payment.id, salesInvoiceId: invoice.id, amount: 4_000_000 }, userId,
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      vi.useRealTimers();
      const application = await tx.customerDepositApplication.findFirstOrThrow({ where: { depositPaymentId: payment.id } });
      expect(application.journalEntryId).not.toBeNull();
      await close(tx, old);
      const before = await ledgerState(tx, [application.journalEntryId!]);

      expectPeriodClosed(await callRoute(customerDepositsRouter, 'post', '/apply/:id/cancel', { params: { id: application.id }, userId }));

      expect((await tx.customerDepositApplication.findUniqueOrThrow({ where: { id: application.id } })).isCancelled).toBe(false);
      expect(Number((await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).outstanding)).toBe(0);
      expect(await ledgerState(tx, [application.journalEntryId!])).toEqual(before);
    });
  });

  it('rejects a sales return cancel', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const invoice = await serviceInvoice(tx, customer.id, `${Y}-12-01`, 3_000_000);
      const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      const ret = await submitSalesReturnInTx(
        tx,
        { salesInvoiceId: invoice.id, date: `${Y}-12-20`, items: [{ salesInvoiceItemId: line.id, quantity: 1, restock: false }] } as any,
        userId,
      );
      if (!ret) throw new Error('Return not created.');
      await close(tx, old);
      const ids = await journalIdsOf(tx, ret.returnNumber);
      expect(ids.length).toBeGreaterThan(0);
      const before = await ledgerState(tx, ids);

      expect(await codeOf(inRouteTx((t) => cancelSalesReturnInTx(t, ret.id)))).toBe(PERIOD_CLOSED);

      expect((await tx.salesReturn.findUniqueOrThrow({ where: { id: ret.id } })).status).not.toBe('Cancelled');
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });
});

d('closed fiscal year: guarantees, GA, journal menu and depreciation', () => {
  async function guarantee(tx: Tx, customerId: string, amount: number) {
    const r = await callRoute(projectGuaranteesRouter, 'post', '/', {
      body: { date: `${Y}-03-01`, partyId: customerId, guaranteeType: 'Pelaksanaan', projectName: 'Proyek uji', amount, accountId: cashAccountId },
      userId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return tx.projectGuarantee.findFirstOrThrow({ where: { partyId: customerId }, orderBy: { createdAt: 'desc' } });
  }

  it('rejects cancelling a 100 jt guarantee settlement', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const g = await guarantee(tx, customer.id, 100_000_000);
      const settled = await callRoute(projectGuaranteesRouter, 'post', '/:id/settle', {
        params: { id: g.id }, body: { date: `${Y}-11-01`, returnAmount: 100_000_000, returnAccountId: cashAccountId }, userId,
      });
      expect(settled.status, JSON.stringify(settled.body)).toBe(201);
      const settlement = await tx.projectGuaranteeSettlement.findFirstOrThrow({ where: { guaranteeId: g.id } });
      await close(tx, old);
      const ids = [settlement.journalEntryId!, g.journalEntryId!];
      const before = await ledgerState(tx, ids);

      expectPeriodClosed(await callRoute(projectGuaranteesRouter, 'post', '/settlements/:id/cancel', { params: { id: settlement.id }, userId }));

      expect((await tx.projectGuaranteeSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).isCancelled).toBe(false);
      expect((await tx.projectGuarantee.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('Selesai');
      expect(await ledgerState(tx, ids)).toEqual(before);
    });
  });

  it('rejects cancelling a guarantee deposit', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const customer = await party(tx, 'Customer');
      const g = await guarantee(tx, customer.id, 25_000_000);
      await close(tx, old);
      const before = await ledgerState(tx, [g.journalEntryId!]);

      expectPeriodClosed(await callRoute(projectGuaranteesRouter, 'patch', '/:id/cancel', { params: { id: g.id }, userId }));

      expect((await tx.projectGuarantee.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('Disetor');
      expect(await ledgerState(tx, [g.journalEntryId!])).toEqual(before);
    });
  });

  it('rejects voiding a GA bill journal in a closed year', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const je = await manualJournal(tx, old.id, `JV-${Y}09-${tag()}`, `${Y}-09-15`);
      await close(tx, old);
      const before = await ledgerState(tx, [je.id]);

      expect(await codeOf(inRouteTx((t) => cancelJournalInTx(t, je.id)))).toBe(PERIOD_CLOSED);
      expect(await ledgerState(tx, [je.id])).toEqual(before);
    });
  });

  it('journal menu returns the PERIOD_CLOSED code and keeps the journal', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const je = await manualJournal(tx, old.id, `JV-${Y}03-${tag()}`, `${Y}-03-15`);
      await close(tx, old);
      const before = await ledgerState(tx, [je.id]);

      expectPeriodClosed(await callRoute(journalsRouter, 'patch', '/:id/cancel', { params: { id: je.id }, userId }));

      expect(await ledgerState(tx, [je.id])).toEqual(before);
    });
  });

  it('rejects posting December depreciation into a closed year, single and bulk, with 400', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const [assetAcc, expenseAcc, accumAcc] = await Promise.all([
        tx.account.findFirst({ where: { rootType: 'ASSET', isGroup: false, isActive: true } }),
        tx.account.findFirst({ where: { rootType: 'EXPENSE', isGroup: false, isActive: true } }),
        tx.account.findFirst({ where: { rootType: 'ASSET', isGroup: false, isActive: true }, skip: 1 }),
      ]);
      if (!assetAcc || !expenseAcc || !accumAcc) throw new Error('Need asset and expense detail accounts.');
      const asset = await tx.fixedAsset.create({
        data: {
          assetNumber: `IT-FA-${tag()}`,
          name: 'Mesin uji tutup buku',
          category: 'Mesin',
          acquisitionDate: new Date(`${Y}-01-01`),
          acquisitionCost: 1_200_000,
          usefulLifeMonths: 12,
          bookValue: 1_200_000,
          assetAccountId: assetAcc.id,
          depreciationAccountId: expenseAcc.id,
          accumulatedDepAccountId: accumAcc.id,
          fiscalYearId: old.id,
          createdBy: userId,
          depreciationEntries: { create: [{ periodDate: new Date(`${Y}-12-01T00:00:00.000Z`), amount: 100_000 }] },
        },
        include: { depreciationEntries: true },
      });
      await close(tx, old);
      const entry = asset.depreciationEntries[0]!;

      expectPeriodClosed(await callRoute(fixedAssetsRouter, 'post', '/:id/depreciate', { params: { id: asset.id }, body: { entryId: entry.id }, userId }));
      expectPeriodClosed(await callRoute(fixedAssetsRouter, 'post', '/depreciate-bulk', { body: { month: `${Y}-12` }, userId }));

      expect((await tx.depreciationEntry.findUniqueOrThrow({ where: { id: entry.id } })).isPosted).toBe(false);
      expect(Number((await tx.fixedAsset.findUniqueOrThrow({ where: { id: asset.id } })).accumulatedDepreciation)).toBe(0);
    });
  });
});
