/**
 * Integration test: receivable and customer deposit, ledger vs subledger (E4-R3, PR-3.9).
 *
 * Fixture year 2194 (unique to this file). Journals post to the mapped AR / CUSTOMER_DEPOSIT
 * accounts against a fixture contra account, with their ledger rows. Every assertion is limited to
 * the fixture parties (partyIds) or to the fixture year, so data elsewhere in the database does not
 * matter. Everything runs in a rollback transaction; route handlers through the route harness.
 * - A 3 jt AR journal without an invoice, and a 1 jt deposit journal without a deposit, show up
 *   as differences; a real flow (invoice, part payment, deposit, apply) shows none.
 * - Opening outstanding counts for a Customer; for a party typed Both it is left out and reported.
 * - GET /health-check lists the two new checks.
 * - Close checklist: both checks block; a captured baseline stops the same difference from
 *   blocking, and a smaller one of the same sign; a larger difference, a flipped sign, or a new
 *   Customer's blocks again. The bucket without a party counts only the closed year's rows
 *   (half-open WIB range) and is keyed per year, so a capture over two years baselines both.
 * - A Customer whose invoice or deposit in the year has no live ledger row is still checked.
 * - A Customer imported with an opening receivable has no difference (opening outstanding is set).
 * - The health check detail carries the ignored-opening column on every row once one row has it.
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

import '../../services/closeCheckPlugins';
import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { captureCloseBaseline, runCloseChecklist, type CloseChecklist, type CloseCheckResult } from '../../services/fiscalYearClose';
import { findArSubledgerDiffs, findCustomerDepositDiffs } from '../../services/ledger/arSubledgerCheck';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { businessDayOf } from '../../utils/businessDate';
import customerDepositsRouter from '../../routes/customerDeposits';
import healthCheckRouter from '../../routes/healthCheck';
import importPartiesRouter from '../../routes/import/parties';
import { detailRows } from '../../routes/health/arChecks';
import { Prisma } from '@prisma/client';

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

const Y = 2194;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books {
  fy: FiscalYear;
  arId: string;
  depositId: string;
  contraId: string;
}

async function books(tx: Tx): Promise<Books> {
  const contra = await tx.account.create({
    data: { name: 'IT-E4 Lawan', accountNumber: `IT-E4-${tag()}`, accountType: 'EQUITY', rootType: 'EQUITY' },
  });
  return {
    fy: await createFiscalYear(tx, { year: Y }),
    arId: (await systemAccounts.getAccount('AR')).id,
    depositId: (await systemAccounts.getAccount('CUSTOMER_DEPOSIT')).id,
    contraId: contra.id,
  };
}

async function party(tx: Tx, partyType: 'Customer' | 'Both' = 'Customer', openingOutstanding = 0): Promise<string> {
  const p = await tx.party.create({ data: { name: `IT-E4 ${partyType} ${tag()}`, partyType, openingOutstanding } });
  return p.id;
}

/**
 * A submitted journal of `amount`: debit `debitId`, credit `creditId`, with its ledger rows; the
 * line on `partyAccountId` carries `partyId`. `date` is an instant (ISO).
 */
async function post(tx: Tx, b: Books, date: string, debitId: string, creditId: string, amount: number, partyId: string | null, partyAccountId: string) {
  const at = new Date(date);
  const lines = [
    { accountId: debitId, debit: amount, credit: 0, partyId: debitId === partyAccountId ? partyId : null },
    { accountId: creditId, debit: 0, credit: amount, partyId: creditId === partyAccountId ? partyId : null },
  ];
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-E4-${tag()}`,
      date: at,
      narration: 'IT-E4 fixture',
      status: 'Submitted',
      fiscalYearId: b.fy.id,
      createdBy: actor.userId,
      submittedAt: new Date(),
      items: { create: lines },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: lines.map((l) => ({ ...l, date: at, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: b.fy.id })),
  });
}

/** DR AR (party) / CR contra. */
const arJournal = (tx: Tx, b: Books, partyId: string | null, amount: number, date = `${Y}-06-10T03:00:00Z`) =>
  post(tx, b, date, b.arId, b.contraId, amount, partyId, b.arId);

/** DR contra / CR AR (party). */
const arCredit = (tx: Tx, b: Books, partyId: string, amount: number) =>
  post(tx, b, `${Y}-06-12T03:00:00Z`, b.contraId, b.arId, amount, partyId, b.arId);

/** A year open for today, which the deposit apply route and the party import post into. */
async function ensureOpenToday(tx: Tx) {
  const today = new Date();
  const open = await tx.fiscalYear.findFirst({ where: { startDate: { lte: today }, endDate: { gte: today }, isClosed: false } });
  if (!open) await createFiscalYear(tx, { year: Number(businessDayOf(today).slice(0, 4)) });
}

/** DR contra / CR customer deposit (party). */
const depositJournal = (tx: Tx, b: Books, partyId: string, amount: number) =>
  post(tx, b, `${Y}-06-11T03:00:00Z`, b.contraId, b.depositId, amount, partyId, b.depositId);

async function checklist(tx: Tx, fy: FiscalYear): Promise<CloseChecklist> {
  return runCloseChecklist(tx, fy);
}

function check(list: CloseChecklist, id: string): CloseCheckResult {
  const found = list.checks.find((c) => c.id === id);
  if (!found) throw new Error(`check ${id} missing from ${JSON.stringify(list.checks.map((c) => c.id))}`);
  return found;
}

const failingBlocks = (list: CloseChecklist) => list.checks.filter((c) => c.severity === 'block' && c.status === 'fail').map((c) => c.id);

d('AR and customer deposit vs subledger (E4-R3)', () => {
  it('reports an AR journal without an invoice and a deposit journal without a deposit', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const c = await party(tx);
      await arJournal(tx, b, c, 3 * JT);
      await depositJournal(tx, b, c, 1 * JT);

      const ar = await findArSubledgerDiffs(tx, { partyIds: [c] });
      expect(ar).toHaveLength(1);
      expect(ar[0]).toMatchObject({ partyId: c, partyType: 'Customer' });
      expect(ar[0]!.gl.toFixed(2)).toBe('3000000.00');
      expect(ar[0]!.subledger.toFixed(2)).toBe('0.00');
      expect(ar[0]!.difference.toFixed(2)).toBe('3000000.00');

      const dep = await findCustomerDepositDiffs(tx, { partyIds: [c] });
      expect(dep).toHaveLength(1);
      expect(dep[0]!.difference.toFixed(2)).toBe('1000000.00');
    });
  });

  it('finds no difference after invoice, part payment, deposit and apply', async () => {
    await inRollback(async (tx) => {
      await books(tx); // the 2194 year the invoice and payments post into
      const c = await party(tx);
      const invoice = await submitSalesInvoiceInTx(
        tx,
        { date: `${Y}-03-01`, partyId: c, items: [{ itemName: 'IT-E4 jasa', itemType: 'service', quantity: 1, rate: 10 * JT }] } as any,
        actor.userId,
      );
      await submitPaymentInTx(tx, { date: `${Y}-03-05`, partyId: c, paymentType: 'Receive', accountId: cashAccountId, amount: 4 * JT }, actor.userId);
      const { payment: deposit } = await submitPaymentInTx(
        tx,
        { date: `${Y}-03-06`, partyId: c, paymentType: 'CustomerDeposit', accountId: cashAccountId, amount: 5 * JT },
        actor.userId,
      );
      // The apply route dates its journal today, so a year must be open for today.
      await ensureOpenToday(tx);
      const applied = await callRoute(customerDepositsRouter, 'post', '/apply', {
        body: { depositPaymentId: deposit.id, salesInvoiceId: invoice.id, amount: 2 * JT },
        ...actor,
      });
      expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);

      const inv = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(Number(inv.outstanding)).toBe(4 * JT);
      expect(await findArSubledgerDiffs(tx, { partyIds: [c] })).toEqual([]);
      expect(await findCustomerDepositDiffs(tx, { partyIds: [c] })).toEqual([]);
    });
  });

  it('counts opening outstanding for a Customer and leaves it out for a party typed Both', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx, 'Customer', 600_000);
      const both = await party(tx, 'Both', 400_000);
      await arJournal(tx, b, both, 250_000);

      const rows = await findArSubledgerDiffs(tx, { partyIds: [customer, both] });
      const byParty = new Map(rows.map((r) => [r.partyId, r]));
      expect(byParty.get(customer)!.difference.toFixed(2)).toBe('-600000.00');
      expect(byParty.get(customer)!.openingIgnored).toBeUndefined();
      expect(byParty.get(both)!.subledger.toFixed(2)).toBe('0.00');
      expect(byParty.get(both)!.difference.toFixed(2)).toBe('250000.00');
      expect(byParty.get(both)!.openingIgnored!.toFixed(2)).toBe('400000.00');

      // The Customer's opening journal brings its ledger in line.
      await arJournal(tx, b, customer, 600_000);
      expect((await findArSubledgerDiffs(tx, { partyIds: [customer] }))).toEqual([]);
    });
  });

  it('lists the two checks in GET /health-check', async () => {
    await inRollback(async () => {
      const r = await callRoute(healthCheckRouter, 'get', '/', actor);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const checks = r.body.data.checks as Array<{ name: string; status: string; fixable: boolean; details: unknown[] }>;
      for (const name of ['AR vs Subledger', 'Customer Deposit vs Subledger']) {
        const found = checks.find((c) => c.name === name);
        expect(found, name).toBeDefined();
        expect(found!.status).not.toBe('error');
        expect(found!.fixable).toBe(false);
        expect(found!.details.length).toBeLessThanOrEqual(20);
      }
    });
  });

  it('blocks the close; a baselined difference does not, a new one above the baseline does', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const c = await party(tx);
      await arJournal(tx, b, c, 3 * JT);
      await depositJournal(tx, b, c, 1 * JT);

      let list = await checklist(tx, b.fy);
      let ar = check(list, 'ar-subledger');
      expect(ar).toMatchObject({ severity: 'block', status: 'fail', count: 1, baselinedCount: 0 });
      expect(ar.items).toEqual([{ key: `Party:${c}`, kind: 'Party', label: expect.stringContaining('IT-E4'), amount: '3000000.00' }]);
      expect(check(list, 'customer-deposit-subledger')).toMatchObject({ severity: 'block', status: 'fail', count: 1 });
      expect(failingBlocks(list)).toEqual(expect.arrayContaining(['ar-subledger', 'customer-deposit-subledger']));

      // Captured at release: the same difference no longer blocks.
      const captured = await captureCloseBaseline(tx, b.fy, true, ['ar-subledger', 'customer-deposit-subledger']);
      expect(captured.map((x) => [x.checkId, x.item.key, x.item.amount, x.added])).toEqual([
        ['ar-subledger', `Party:${c}`, '3000000.00', true],
        ['customer-deposit-subledger', `Party:${c}`, '1000000.00', true],
      ]);
      list = await checklist(tx, b.fy);
      ar = check(list, 'ar-subledger');
      expect(ar).toMatchObject({ status: 'ok', count: 0, baselinedCount: 1 });
      expect(ar.items[0]).toMatchObject({ key: `Party:${c}`, baselined: true });
      expect(check(list, 'customer-deposit-subledger')).toMatchObject({ status: 'ok', count: 0, baselinedCount: 1 });
      expect(failingBlocks(list)).not.toContain('ar-subledger');
      expect(failingBlocks(list)).not.toContain('customer-deposit-subledger');

      // The difference grows past the baseline: it blocks again.
      await arJournal(tx, b, c, 500_000);
      list = await checklist(tx, b.fy);
      ar = check(list, 'ar-subledger');
      expect(ar).toMatchObject({ status: 'fail', count: 1, baselinedCount: 0 });
      expect(ar.items[0]).toMatchObject({ key: `Party:${c}`, amount: '3500000.00' });
      expect(ar.items[0]!.baselined).toBeUndefined();
      expect(failingBlocks(list)).toContain('ar-subledger');

      // A new Customer's difference blocks while the baselined deposit stays skipped.
      const other = await party(tx);
      await depositJournal(tx, b, other, 200_000);
      list = await checklist(tx, b.fy);
      const dep = check(list, 'customer-deposit-subledger');
      expect(dep).toMatchObject({ status: 'fail', count: 1, baselinedCount: 1 });
      expect(dep.items.map((i) => [i.key, i.amount, !!i.baselined])).toEqual([
        [`Party:${other}`, '200000.00', false],
        [`Party:${c}`, '1000000.00', true],
      ]);
    });
  });

  it('keeps a reduced difference covered by its baseline, and blocks a flipped sign', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const c = await party(tx);
      await arJournal(tx, b, c, 3 * JT);
      await captureCloseBaseline(tx, b.fy, true, ['ar-subledger']);

      // The accountant fixes part of it: 2 jt left, below the 3 jt baseline.
      await arCredit(tx, b, c, 1 * JT);
      let ar = check(await checklist(tx, b.fy), 'ar-subledger');
      expect(ar.items.find((i) => i.key === `Party:${c}`)).toMatchObject({ amount: '2000000.00', baselined: true });
      expect(ar).toMatchObject({ status: 'ok', count: 0 });

      // Over-corrected to -3 jt: same size as the baseline, other sign, so it blocks.
      await arCredit(tx, b, c, 5 * JT);
      ar = check(await checklist(tx, b.fy), 'ar-subledger');
      const item = ar.items.find((i) => i.key === `Party:${c}`)!;
      expect(item.amount).toBe('-3000000.00');
      expect(item.baselined).toBeUndefined();
      expect(ar).toMatchObject({ status: 'fail', count: 1 });
    });
  });

  it('baselines the bucket without a party for every year of a capture', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const next: Books = { ...b, fy: await createFiscalYear(tx, { year: Y + 1 }) };
      await arJournal(tx, b, null, 5 * JT);
      await arJournal(tx, next, null, 1_200_000, `${Y + 1}-06-10T03:00:00Z`);

      // The deploy step runs the capture year by year, oldest first.
      for (const fy of [b.fy, next.fy]) {
        const captured = await captureCloseBaseline(tx, fy, true, ['ar-subledger']);
        expect(captured.find((x) => x.item.key === `Party:none:${fy.id}`)).toMatchObject({ added: true });
      }
      for (const [fy, amount] of [[b.fy, '5000000.00'], [next.fy, '1200000.00']] as const) {
        const ar = check(await checklist(tx, fy), 'ar-subledger');
        expect(ar.items.filter((i) => i.key.startsWith('Party:none'))).toEqual([
          { key: `Party:none:${fy.id}`, kind: 'Party', label: '(tanpa Customer)', amount, baselined: true },
        ]);
      }
    });
  });

  it('checks a Customer whose invoice or deposit in the year has no live ledger row', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const c = await party(tx);
      const invoice = await submitSalesInvoiceInTx(
        tx,
        { date: `${Y}-04-01`, partyId: c, items: [{ itemName: 'IT-E4 jasa', itemType: 'service', quantity: 1, rate: 10 * JT }] } as any,
        actor.userId,
      );
      await submitPaymentInTx(
        tx,
        { date: `${Y}-04-02`, partyId: c, paymentType: 'CustomerDeposit', accountId: cashAccountId, amount: 3 * JT },
        actor.userId,
      );
      // A lost posting: the Customer's AR and deposit ledger rows are gone from the books.
      await tx.accountingLedgerEntry.updateMany({
        where: { partyId: c, accountId: { in: [b.arId, b.depositId] } },
        data: { isCancelled: true },
      });

      const list = await checklist(tx, b.fy);
      const outstanding = new Prisma.Decimal(invoice.outstanding).negated().toFixed(2);
      expect(check(list, 'ar-subledger').items.find((i) => i.key === `Party:${c}`)).toMatchObject({ amount: outstanding });
      expect(check(list, 'customer-deposit-subledger').items.find((i) => i.key === `Party:${c}`)).toMatchObject({ amount: '-3000000.00' });
      expect(failingBlocks(list)).toEqual(expect.arrayContaining(['ar-subledger', 'customer-deposit-subledger']));
    });
  });

  it('finds no difference for a Customer imported with an opening receivable', async () => {
    await inRollback(async (tx) => {
      await ensureOpenToday(tx);
      const name = `IT-E4 Import ${tag()}`;
      type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } };
      const layer = (importPartiesRouter.stack as Layer[]).find((l) => l.route?.path === '/parties' && l.route.methods.post)!;
      // The last handler, after multer: the file is handed over as multer would.
      const handler = layer.route!.stack.at(-1)!.handle;
      const result: { status: number; body: any } = { status: 200, body: undefined };
      const res = { status(code: number) { result.status = code; return res; }, json(body: unknown) { result.body = body; return res; } };
      const csv = `name,partyType,openingBalance\n${name},Customer,10000000\n`;
      await handler(
        { file: { buffer: Buffer.from(csv), originalname: 'parties.csv' }, query: {}, body: {}, headers: {}, user: { userId: actor.userId, role: 'Admin' } },
        res,
        () => undefined,
      );
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);

      const imported = await tx.party.findFirstOrThrow({ where: { name } });
      expect(Number(imported.openingOutstanding)).toBe(10 * JT);
      expect(await findArSubledgerDiffs(tx, { partyIds: [imported.id] })).toEqual([]);
    });
  });

  it('counts only the closed year in the bucket without a party', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // 31 Dec 23:59 WIB is in the year; 1 Jan 00:00 WIB of the next year is not.
      await arJournal(tx, b, null, 700_000, `${Y}-12-31T16:59:00Z`);
      await arJournal(tx, b, null, 900_000, `${Y}-12-31T17:00:00Z`);
      await arJournal(tx, b, null, 50_000, `${Y + 1}-02-01T03:00:00Z`);

      const ar = check(await checklist(tx, b.fy), 'ar-subledger');
      const none = ar.items.filter((i) => i.key.startsWith('Party:none'));
      expect(none).toEqual([{ key: `Party:none:${b.fy.id}`, kind: 'Party', label: '(tanpa Customer)', amount: '700000.00' }]);
    });
  });

  it('puts the ignored-opening column on every detail row once one row has it', () => {
    const row = (partyName: string, difference: number, openingIgnored?: number) => ({
      partyId: partyName,
      partyName,
      partyType: openingIgnored === undefined ? 'Customer' : 'Both',
      gl: new Prisma.Decimal(difference),
      subledger: new Prisma.Decimal(0),
      difference: new Prisma.Decimal(difference),
      ...(openingIgnored === undefined ? {} : { openingIgnored: new Prisma.Decimal(openingIgnored) }),
    });
    const rows = detailRows([row('A', 10 * JT), row('B', 250_000, 400_000)]);
    expect(rows[0]).toHaveProperty('opening_outstanding_ignored', null);
    expect(rows[1]).toHaveProperty('opening_outstanding_ignored', 400_000);
    expect(detailRows([row('A', 10 * JT)])[0]).not.toHaveProperty('opening_outstanding_ignored');
  });
});
