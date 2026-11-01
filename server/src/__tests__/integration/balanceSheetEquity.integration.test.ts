/**
 * Integration test: the balance-sheet equity split (E2-R16, G-1).
 *
 * Fixture: two consecutive half-year fiscal years inside Y (the file's only year, plan §5.2), H1 =
 * Jan-Jun and H2 = Jul-Dec, cash, revenue and expense accounts, and two equity accounts that stand in
 * for the CURRENT_PROFIT and RETAINED_EARNINGS mappings (systemAccounts is stubbed). H1 makes 500 jt
 * profit (700 revenue, 200 expense), H2 up to 30 September makes 100 jt.
 * - As of Y-09-30, before the close, after closing H1 and after reopening it: current-year profit is
 *   100 jt (= P/L 1 Jul..30 Sep), retained earnings went up 500 jt, total equity 600 jt. Before the
 *   close the 500 jt is unclosed profit; after it, it sits in the 3.2 part and nothing is unclosed.
 * - As of Y-06-30 after the close: the pre-closing view (current-year profit = H1's 500 jt, and the
 *   parts leave H1's own close out).
 * - A day without a fiscal year (only H1 exists) counts from 1 January of its year and says so in meta.
 * - Without the two mappings the report still answers 200 and lists them in meta.
 * - Total equity stays all equity ledger rows plus all-time profit, and every header equals its rows.
 *
 * The seed has P/L of its own, so retained earnings are checked against a baseline taken in the same
 * transaction (to the cent: the baseline is a large float); current-year profit, in far-future
 * years, is checked absolutely. Everything runs in a rollback transaction. The year-close
 * checklist is stubbed to pass (see fiscalYearReopen).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../services/fiscalYearClose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/fiscalYearClose')>()),
  assertCloseChecklistPasses: vi.fn(async () => undefined),
}));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { updateAccountBalance } from '../../utils/accountBalance';
import fiscalYearsRouter from '../../routes/fiscalYears';
import reportsRouter from '../../routes/reports';
import type { BalanceSheetResult, BsNode } from '../../services/reports/balanceSheet';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let actor: { userId: string; role: string };

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

afterEach(() => {
  vi.restoreAllMocks();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        actor = await createCapUser(tx, ['doc.cancel']);
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2191;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type RootType = 'ASSET' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function account(tx: Tx, rootType: RootType, name: string): Promise<string> {
  const a = await tx.account.create({
    data: { name: `IT-BSE ${name}`, accountNumber: `IT-BSE-${tag()}`, accountType: rootType, rootType },
  });
  return a.id;
}

interface Books {
  /** Y-01-01..Y-06-30, the year that is closed. */
  fy: FiscalYear;
  /** Y-07-01..Y-12-31. */
  next: FiscalYear;
  cashId: string;
  revenueId: string;
  expenseId: string;
  currentProfitId: string;
  retainedId: string;
}

function stubMapping(b: Pick<Books, 'currentProfitId' | 'retainedId'>, missing: string[] = []) {
  const original = systemAccounts.getAccounts.bind(systemAccounts);
  const fake = (id: string) => [{ id, accountNumber: id, name: id }];
  vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) => {
    if (missing.includes(role)) return [];
    if (role === 'CURRENT_PROFIT') return fake(b.currentProfitId);
    if (role === 'RETAINED_EARNINGS') return fake(b.retainedId);
    return original(role);
  });
}

/** A fiscal year over one half of Y, bounds stored like routes/fiscalYears.ts (UTC midnight). */
function halfYear(tx: Tx, half: 1 | 2): Promise<FiscalYear> {
  const [start, end] = half === 1 ? ['01-01', '06-30'] : ['07-01', '12-31'];
  return tx.fiscalYear.create({
    data: { name: `IT-BSE-${Y}H${half}-${tag()}`, startDate: new Date(`${Y}-${start}`), endDate: new Date(`${Y}-${end}`) },
  });
}

async function books(tx: Tx, withNext = true): Promise<Books> {
  const fy = await halfYear(tx, 1);
  const b: Books = {
    fy,
    next: withNext ? await halfYear(tx, 2) : fy,
    cashId: await account(tx, 'ASSET', 'Kas'),
    revenueId: await account(tx, 'REVENUE', 'Pendapatan'),
    expenseId: await account(tx, 'EXPENSE', 'Beban'),
    currentProfitId: await account(tx, 'EQUITY', 'Laba tahun berjalan'),
    retainedId: await account(tx, 'EQUITY', 'Laba ditahan'),
  };
  stubMapping(b);
  return b;
}

/** A submitted two-line journal with its ledger rows and running balances. */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-BSE-${tag()}`,
      date: new Date(date),
      narration: 'IT-BSE fixture',
      status: 'Submitted',
      fiscalYearId: fy.id,
      createdBy: actor.userId,
      submittedAt: new Date(),
      items: { create: [{ accountId: debitId, debit: amount, credit: 0 }, { accountId: creditId, debit: 0, credit: amount }] },
    },
  });
  const row = { date: new Date(date), referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id };
  await tx.accountingLedgerEntry.createMany({
    data: [
      { ...row, accountId: debitId, debit: amount, credit: 0 },
      { ...row, accountId: creditId, debit: 0, credit: amount },
    ],
  });
  await updateAccountBalance(tx, debitId, amount, 0);
  await updateAccountBalance(tx, creditId, 0, amount);
}

/** H1: revenue 700 jt, expense 200 jt. H2: revenue 100 jt in August. */
async function trade(tx: Tx, b: Books) {
  await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, 700 * JT);
  await post(tx, b.fy, `${Y}-04-15`, b.expenseId, b.cashId, 200 * JT);
  await post(tx, b.next, `${Y}-08-15`, b.cashId, b.revenueId, 100 * JT);
}

async function sheet(date: string): Promise<BalanceSheetResult> {
  const r = await callRoute(reportsRouter, 'get', '/balance-sheet', { query: { date } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as BalanceSheetResult;
}

async function netProfit(startDate: string, endDate: string): Promise<number> {
  const r = await callRoute(reportsRouter, 'get', '/profit-loss', { query: { startDate, endDate } });
  expect(r.status).toBe(200);
  return r.body.netProfit;
}

function find(nodes: BsNode[], id: string): BsNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

const node = (s: BalanceSheetResult, id: string): BsNode => {
  const n = find(s.equity, id);
  if (!n) throw new Error(`no ${id} row`);
  return n;
};

/** Retained-earnings parts by name; absent parts are 0. */
function parts(s: BalanceSheetResult): Record<string, number> {
  const out: Record<string, number> = { retainedAccount: 0, otherCurrentProfit: 0, unclosedProfit: 0 };
  for (const c of node(s, 'retained-earnings').children) if (c.detail) out[c.detail] = c.balance;
  return out;
}

/** Every header equals the sum of its rows, in all three sections. */
function expectHeadersSum(nodes: BsNode[]) {
  for (const n of nodes) {
    if (n.children.length === 0) continue;
    expect(n.balance, n.name).toBeCloseTo(n.children.reduce((s, c) => s + c.balance, 0), 2);
    expectHeadersSum(n.children);
  }
}

/** The old total: every equity ledger row (credit - debit) plus all-time revenue minus expense, up to `date`. */
async function oldTotalEquity(tx: Tx, date: string): Promise<number> {
  const lt = new Date(new Date(`${date}T00:00:00+07:00`).getTime() + 86_400_000);
  const sumOf = async (roots: RootType[] | ['EQUITY']) => {
    const a = await tx.accountingLedgerEntry.aggregate({
      where: { isCancelled: false, date: { lt }, account: { rootType: { in: roots } } },
      _sum: { debit: true, credit: true },
    });
    return Number(a._sum.credit ?? 0) - Number(a._sum.debit ?? 0);
  };
  return (await sumOf(['EQUITY'])) + (await sumOf(['REVENUE', 'EXPENSE']));
}

const close = (fyId: string) => callRoute(fiscalYearsRouter, 'post', '/:id/close', { params: { id: fyId }, ...actor });
const reopen = (fyId: string, reason: string) =>
  callRoute(fiscalYearsRouter, 'post', '/:id/reopen', { params: { id: fyId }, body: { reason }, ...actor });

const SEP30 = `${Y}-09-30`;
const JUN30 = `${Y}-06-30`;

d('GET /reports/balance-sheet equity split', () => {
  it('current-year profit from the fiscal-year start, earlier profit in retained earnings, before/after close and reopen', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const base = await sheet(SEP30);
      const baseRetained = node(base, 'retained-earnings').balance;
      const baseUnclosed = parts(base).unclosedProfit;
      await trade(tx, b);

      // 1. Before the first close.
      const before = await sheet(SEP30);
      expect(before.meta).toMatchObject({ asOf: SEP30, currentProfitFrom: `${Y}-07-01`, equityMappingMissing: [] });
      expect(before.meta.fiscalYear).toMatchObject({ id: b.next.id, isClosed: false });
      expect(node(before, 'current-profit').balance).toBe(100 * JT);
      expect(await netProfit(`${Y}-07-01`, SEP30)).toBe(100 * JT);
      expect(node(before, 'retained-earnings').balance - baseRetained).toBeCloseTo(500 * JT, 2);
      expect(before.totalEquity - base.totalEquity).toBeCloseTo(600 * JT, 2);
      expect(before.totalAssets - base.totalAssets).toBeCloseTo(600 * JT, 2);
      expect(parts(before)).toMatchObject({ retainedAccount: 0, otherCurrentProfit: 0 });
      expect(parts(before).unclosedProfit - baseUnclosed).toBeCloseTo(500 * JT, 2);

      // 2. After closing H1: same figures; the closed profit moves from the unclosed part to 3.2.
      const c = await close(b.fy.id);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const after = await sheet(SEP30);
      expect(node(after, 'current-profit').balance).toBe(100 * JT);
      expect(node(after, 'retained-earnings').balance - baseRetained).toBeCloseTo(500 * JT, 2);
      expect(after.totalEquity).toBe(before.totalEquity);
      expect(parts(after)).toMatchObject({ retainedAccount: 500 * JT, otherCurrentProfit: 0 });
      expect(parts(after).unclosedProfit - baseUnclosed).toBeCloseTo(0, 2);
      expectHeadersSum(after.equity);

      // 4. At the closed year's last day: the pre-closing view, the year's own close left out of the parts.
      const yearEnd = await sheet(JUN30);
      expect(yearEnd.meta.fiscalYear).toMatchObject({ id: b.fy.id, isClosed: true });
      expect(yearEnd.meta.currentProfitFrom).toBe(`${Y}-01-01`);
      expect(node(yearEnd, 'current-profit').balance).toBe(500 * JT);
      expect(node(yearEnd, 'retained-earnings').balance - baseRetained).toBeCloseTo(0, 2);
      expect(parts(yearEnd)).toMatchObject({ retainedAccount: 0, otherCurrentProfit: 0 });
      expect(parts(yearEnd).unclosedProfit - baseUnclosed).toBeCloseTo(0, 2);
      expectHeadersSum(yearEnd.equity);

      // 3. After reopening H1: the CLOSE journal is cancelled and the figures are unchanged.
      const r = await reopen(b.fy.id, 'koreksi uji neraca');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const closeJe = await tx.journalEntry.findFirstOrThrow({ where: { fiscalYearId: b.fy.id, sourceType: 'FY_CLOSE' } });
      expect(closeJe.status).toBe('Cancelled');
      const reopened = await sheet(SEP30);
      expect(node(reopened, 'current-profit').balance).toBe(100 * JT);
      expect(node(reopened, 'retained-earnings').balance - baseRetained).toBeCloseTo(500 * JT, 2);
      expect(reopened.totalEquity).toBe(before.totalEquity);
      expect(parts(reopened)).toMatchObject({ retainedAccount: 0, otherCurrentProfit: 0 });
      expect(parts(reopened).unclosedProfit - baseUnclosed).toBeCloseTo(500 * JT, 2);
    });
  });

  it('a day without a fiscal year counts from 1 January of its year', async () => {
    await inRollback(async (tx) => {
      // Only H1 has a fiscal year; 30 September has none.
      const b = await books(tx, false);
      const base = await sheet(SEP30);
      expect(base.meta.fiscalYear).toBeNull();
      expect(base.meta.currentProfitFrom).toBe(`${Y}-01-01`);
      expect(node(base, 'current-profit').balance).toBe(0);

      // Ledger rows need a year id; the date is what counts here. Both count from 1 January.
      await post(tx, b.fy, `${Y}-02-10`, b.cashId, b.revenueId, 3 * JT);
      await post(tx, b.fy, `${Y}-08-10`, b.cashId, b.revenueId, 7 * JT);
      const s = await sheet(SEP30);
      expect(node(s, 'current-profit').balance).toBe(10 * JT);
      expect(node(s, 'retained-earnings').balance - node(base, 'retained-earnings').balance).toBeCloseTo(0, 2);
    });
  });

  it('answers 200 without the equity mappings and lists them in meta', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b);
      vi.restoreAllMocks();
      stubMapping(b, ['CURRENT_PROFIT', 'RETAINED_EARNINGS']);
      const s = await sheet(SEP30);
      expect(s.meta.equityMappingMissing).toEqual(['CURRENT_PROFIT', 'RETAINED_EARNINGS']);
      const ids = s.equity.map((n) => n.id);
      expect(ids.slice(-2)).toEqual(['retained-earnings', 'current-profit']);
      expect(node(s, 'current-profit').balance).toBe(100 * JT);
    });
  });

  it('keeps the old total equity and every header equal to its rows', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b);
      expect((await close(b.fy.id)).status).toBe(200);
      for (const date of [JUN30, SEP30]) {
        const s = await sheet(date);
        expect(s.totalEquity).toBeCloseTo(await oldTotalEquity(tx, date), 2);
        expect(s.totalEquity).toBeCloseTo(s.equity.reduce((sum, n) => sum + n.balance, 0), 2);
        expectHeadersSum(s.assets);
        expectHeadersSum(s.liabilities);
        expectHeadersSum(s.equity);
      }
    });
  });
});
