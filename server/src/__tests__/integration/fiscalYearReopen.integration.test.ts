/**
 * Integration test: year close and controlled reopen (E1-R8, PR-8a).
 *
 * Fixture: two fiscal years of their own (Y, Y+1), revenue and expense accounts, and two equity
 * accounts that stand in for the CURRENT_PROFIT and RETAINED_EARNINGS mappings (systemAccounts is
 * stubbed to return them, so the shared mapping and its balances are never touched). Journals are
 * written with their ledger rows and running balances, the way a posting would.
 * - Profit 100 jt: close posts CLOSE-<name>; reopen with a reason cancels it (kept, with its ledger
 *   rows cancelled and the reason stored), retained earnings go down 100 jt once, and both steps
 *   write a fiscal_year_events row. Closing again numbers CLOSE-<name>-R2; a second reopen voids
 *   only R2. A loss closes the other way round.
 * - Rejections leave the year closed: reopen without a reason (400), while Y+1 is closed
 *   (FY_LATER_CLOSED), with the lock date on the year end (PERIOD_LOCKED), without doc.cancel (403).
 * - Close with CURRENT_PROFIT unmapped: 400 ACCOUNT_MAPPING_MISSING. Decimal profit 0,3-0,1-0,2
 *   posts no CLOSE.
 * - DEP numbering after a reopen stays unique; bulk depreciation for December of a reopened year
 *   posts.
 *
 * Route handlers run through the route harness, whose `$transaction` is a savepoint; everything
 * runs in a rollback transaction in far-future years with fixtures made here.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { setPeriodLockInTx } from '../../services/periodLock';
import { updateAccountBalance } from '../../utils/accountBalance';
import { PERIOD_LOCKED } from '../../utils/periodGuard';
import fiscalYearsRouter, { ACCOUNT_MAPPING_MISSING, FY_LATER_CLOSED } from '../../routes/fiscalYears';
import fixedAssetsRouter from '../../routes/fixedAssets';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
/** The acting user (doc.cancel) of the current test. */
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

// Far from the years other integration tests commit for a moment (periodGuard row-lock tests), so
// the later-year check of a reopen never sees one of them.
const Y = 2186;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type RootType = 'ASSET' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function account(tx: Tx, rootType: RootType, name: string): Promise<string> {
  const a = await tx.account.create({
    data: { name: `IT-FYR ${name}`, accountNumber: `IT-FYR-${tag()}`, accountType: rootType, rootType },
  });
  return a.id;
}

interface Books {
  fy: FiscalYear;
  next: FiscalYear;
  cashId: string;
  revenueId: string;
  expenseId: string;
  currentProfitId: string;
  retainedId: string;
}

/** Maps CURRENT_PROFIT / RETAINED_EARNINGS to the fixture accounts; other roles keep their mapping. */
function stubMapping(books: Pick<Books, 'currentProfitId' | 'retainedId'>, missing: string[] = []) {
  const original = systemAccounts.getAccounts.bind(systemAccounts);
  const fake = (id: string) => [{ id, accountNumber: id, name: id }];
  vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) => {
    if (missing.includes(role)) return [];
    if (role === 'CURRENT_PROFIT') return fake(books.currentProfitId);
    if (role === 'RETAINED_EARNINGS') return fake(books.retainedId);
    return original(role);
  });
}

async function books(tx: Tx): Promise<Books> {
  const b: Books = {
    fy: await createFiscalYear(tx, { year: Y }),
    next: await createFiscalYear(tx, { year: Y + 1 }),
    cashId: await account(tx, 'ASSET', 'Kas'),
    revenueId: await account(tx, 'REVENUE', 'Pendapatan'),
    expenseId: await account(tx, 'EXPENSE', 'Beban'),
    currentProfitId: await account(tx, 'EQUITY', 'Laba tahun berjalan'),
    retainedId: await account(tx, 'EQUITY', 'Laba ditahan'),
  };
  stubMapping(b);
  return b;
}

/** A submitted two-line journal in `fy` with its ledger rows and running balances. */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-FYR-${tag()}`,
      date: new Date(date),
      narration: 'IT-FYR fixture',
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

/** Revenue `rev` and expense `exp` in year Y, both against cash. */
async function trade(tx: Tx, b: Books, rev: number, exp: number) {
  if (rev) await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, rev);
  if (exp) await post(tx, b.fy, `${Y}-04-15`, b.expenseId, b.cashId, exp);
}

async function balance(tx: Tx, id: string): Promise<number> {
  const a = await tx.account.findUniqueOrThrow({ where: { id }, select: { balance: true } });
  return Number(a.balance);
}

const asActor = (who?: { userId: string; role: string }) => ({ userId: (who ?? actor).userId, role: (who ?? actor).role });

function close(fyId: string, who?: { userId: string; role: string }): Promise<RouteResult> {
  return callRoute(fiscalYearsRouter, 'post', '/:id/close', { params: { id: fyId }, ...asActor(who) });
}

function reopen(fyId: string, body: unknown, who?: { userId: string; role: string }): Promise<RouteResult> {
  return callRoute(fiscalYearsRouter, 'post', '/:id/reopen', { params: { id: fyId }, body, ...asActor(who) });
}

async function closeJournals(tx: Tx, fy: FiscalYear) {
  return tx.journalEntry.findMany({
    where: { fiscalYearId: fy.id, entryNumber: { startsWith: `CLOSE-${fy.name}` } },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function events(tx: Tx, fy: FiscalYear) {
  return tx.fiscalYearEvent.findMany({ where: { fiscalYearId: fy.id }, orderBy: { createdAt: 'asc' } });
}

async function isClosed(tx: Tx, fy: FiscalYear): Promise<boolean> {
  return (await tx.fiscalYear.findUniqueOrThrow({ where: { id: fy.id } })).isClosed;
}

d('POST /fiscal-years/:id/close and /:id/reopen', () => {
  it('reopen cancels the CLOSE journal instead of deleting it; retained earnings drop once; re-close is -R2', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 300 * JT, 200 * JT);

      const c1 = await close(b.fy.id);
      expect(c1.status, JSON.stringify(c1.body)).toBe(200);
      expect(c1.body).toMatchObject({ id: b.fy.id, isClosed: true, closedBy: actor.userId });
      const [first] = await closeJournals(tx, b.fy);
      expect(first).toMatchObject({ entryNumber: `CLOSE-${b.fy.name}`, status: 'Submitted', sourceType: 'FY_CLOSE', sourceKey: `FY_CLOSE:${b.fy.id}` });
      // Profit: DR current profit / CR retained earnings (both credit-normal).
      expect(await balance(tx, b.retainedId)).toBe(100 * JT);
      expect(await balance(tx, b.currentProfitId)).toBe(-100 * JT);
      // The (untouched) revenue/expense loop takes this year's contribution off the running balances.
      expect(await balance(tx, b.revenueId)).toBe(0);
      expect(await balance(tx, b.expenseId)).toBe(0);

      const r1 = await reopen(b.fy.id, { reason: '  koreksi persediaan akhir tahun  ' });
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(r1.body).toMatchObject({ id: b.fy.id, isClosed: false, closedAt: null, closedBy: null });

      const voided = await tx.journalEntry.findUniqueOrThrow({ where: { id: first!.id } });
      expect(voided).toMatchObject({
        status: 'Cancelled',
        cancelledById: actor.userId,
        cancelReason: 'koreksi persediaan akhir tahun',
      });
      expect(voided.cancelledAt).not.toBeNull();
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: first!.id } });
      expect(ale).toHaveLength(2);
      expect(ale.every((r) => r.isCancelled)).toBe(true);
      expect(await balance(tx, b.retainedId)).toBe(0);
      expect(await balance(tx, b.currentProfitId)).toBe(0);
      expect(await balance(tx, b.revenueId)).toBe(300 * JT);
      expect(await balance(tx, b.expenseId)).toBe(200 * JT);

      // Close again: a new journal numbered -R2; the cancelled one is not counted as active.
      const c2 = await close(b.fy.id);
      expect(c2.status, JSON.stringify(c2.body)).toBe(200);
      const afterReclose = await closeJournals(tx, b.fy);
      expect(afterReclose.map((j) => [j.entryNumber, j.status])).toEqual([
        [`CLOSE-${b.fy.name}`, 'Cancelled'],
        [`CLOSE-${b.fy.name}-R2`, 'Submitted'],
      ]);
      expect(await balance(tx, b.retainedId)).toBe(100 * JT);

      // A second reopen voids only R2 and leaves the first cancel as it was.
      const r2 = await reopen(b.fy.id, { reason: 'buka lagi untuk koreksi' });
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      const afterSecond = await closeJournals(tx, b.fy);
      expect(afterSecond.map((j) => j.status)).toEqual(['Cancelled', 'Cancelled']);
      expect(afterSecond[0]!.cancelReason).toBe('koreksi persediaan akhir tahun');
      expect(afterSecond[0]!.cancelledAt).toEqual(voided.cancelledAt);
      expect(afterSecond[1]!.cancelReason).toBe('buka lagi untuk koreksi');
      expect(await balance(tx, b.retainedId)).toBe(0);

      const ev = await events(tx, b.fy);
      expect(ev.map((e) => [e.action, e.closeJournalId, e.profit === null ? null : Number(e.profit), e.reason])).toEqual([
        ['close', first!.id, 100 * JT, null],
        ['reopen', first!.id, null, 'koreksi persediaan akhir tahun'],
        ['close', afterReclose[1]!.id, 100 * JT, null],
        ['reopen', afterReclose[1]!.id, null, 'buka lagi untuk koreksi'],
      ]);
      expect(ev.every((e) => e.userId === actor.userId)).toBe(true);
    });
  });

  it('a loss closes DR retained earnings / CR current profit, and the reopen puts it back', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 20 * JT, 70 * JT);

      expect((await close(b.fy.id)).status).toBe(200);
      const [j] = await closeJournals(tx, b.fy);
      const line = (id: string) => j!.items.find((i) => i.accountId === id)!;
      expect([Number(line(b.retainedId).debit), Number(line(b.retainedId).credit)]).toEqual([50 * JT, 0]);
      expect([Number(line(b.currentProfitId).debit), Number(line(b.currentProfitId).credit)]).toEqual([0, 50 * JT]);
      expect(await balance(tx, b.retainedId)).toBe(-50 * JT);
      expect(Number((await events(tx, b.fy))[0]!.profit)).toBe(-50 * JT);

      expect((await reopen(b.fy.id, { reason: 'rugi salah hitung' })).status).toBe(200);
      expect(await balance(tx, b.retainedId)).toBe(0);
      expect(await balance(tx, b.currentProfitId)).toBe(0);
    });
  });

  it('reopen without a reason (or a too short one) is 400 and the year stays closed', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 10 * JT, 0);
      expect((await close(b.fy.id)).status).toBe(200);

      for (const body of [{}, { reason: '   ' }, { reason: 'abc' }, { reason: 'x'.repeat(501) }]) {
        const r = await reopen(b.fy.id, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.error).toBeTruthy();
      }
      expect(await isClosed(tx, b.fy)).toBe(true);
      expect((await closeJournals(tx, b.fy)).map((j) => j.status)).toEqual(['Submitted']);
      expect(await balance(tx, b.retainedId)).toBe(10 * JT);
    });
  });

  it('reopen of Y while Y+1 is closed: 400 FY_LATER_CLOSED, nothing changes; after Y+1 reopens it works', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 10 * JT, 0);
      expect((await close(b.fy.id)).status).toBe(200);
      expect((await close(b.next.id)).status).toBe(200);

      const r = await reopen(b.fy.id, { reason: 'koreksi tahun lalu' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(FY_LATER_CLOSED);
      expect(r.body.error).toContain(b.next.name);
      expect(await isClosed(tx, b.fy)).toBe(true);
      expect((await closeJournals(tx, b.fy)).map((j) => j.status)).toEqual(['Submitted']);
      expect((await events(tx, b.fy)).map((e) => e.action)).toEqual(['close']);

      expect((await reopen(b.next.id, { reason: 'buka tahun berikutnya' })).status).toBe(200);
      expect((await reopen(b.fy.id, { reason: 'koreksi tahun lalu' })).status).toBe(200);
    });
  });

  it('reopen with the lock date on the year end: 400 PERIOD_LOCKED, the year stays closed', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 10 * JT, 0);
      expect((await close(b.fy.id)).status).toBe(200);
      // Kept to the end of this test: the lock row is global (held FOR UPDATE until the rollback).
      await setPeriodLockInTx(tx, { lockDate: `${Y}-12-31`, reason: 'Uji buka kembali tahun', userId: actor.userId, today: `${Y + 1}-02-01` });

      const r = await reopen(b.fy.id, { reason: 'koreksi tahun lalu' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(PERIOD_LOCKED);
      expect(await isClosed(tx, b.fy)).toBe(true);
      expect((await closeJournals(tx, b.fy)).map((j) => j.status)).toEqual(['Submitted']);

      // A lock inside the year leaves the year end open: the reopen goes through.
      await setPeriodLockInTx(tx, { lockDate: `${Y}-12-30`, reason: 'Uji buka kembali tahun', userId: actor.userId, today: `${Y + 1}-02-01` });
      expect((await reopen(b.fy.id, { reason: 'koreksi tahun lalu' })).status).toBe(200);
    });
  });

  it('reopen and close without doc.cancel: 403', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const noCap = await createCapUser(tx, []);
      expect((await close(b.fy.id, noCap)).status).toBe(403);
      expect((await close(b.fy.id)).status).toBe(200);
      expect((await reopen(b.fy.id, { reason: 'koreksi tahun lalu' }, noCap)).status).toBe(403);
      expect(await isClosed(tx, b.fy)).toBe(true);
    });
  });

  it('close with CURRENT_PROFIT unmapped: 400 ACCOUNT_MAPPING_MISSING, the year stays open', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 10 * JT, 0);
      vi.restoreAllMocks();
      stubMapping(b, ['CURRENT_PROFIT']);

      const r = await close(b.fy.id);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(ACCOUNT_MAPPING_MISSING);
      expect(r.body.error).toContain('Laba Tahun Berjalan');
      expect(await isClosed(tx, b.fy)).toBe(false);
      expect(await closeJournals(tx, b.fy)).toEqual([]);
    });
  });

  it('a profit of exactly zero in decimals (0,30 - 0,10 - 0,20) posts no CLOSE journal', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, 0.3);
      await post(tx, b.fy, `${Y}-04-15`, b.expenseId, b.cashId, 0.1);
      await post(tx, b.fy, `${Y}-05-15`, b.expenseId, b.cashId, 0.2);

      expect((await close(b.fy.id)).status).toBe(200);
      expect(await closeJournals(tx, b.fy)).toEqual([]);
      const [ev] = await events(tx, b.fy);
      expect(ev).toMatchObject({ action: 'close', closeJournalId: null });
      expect(Number(ev!.profit)).toBe(0);

      expect((await reopen(b.fy.id, { reason: 'tanpa jurnal penutup' })).status).toBe(200);
      expect((await events(tx, b.fy)).map((e) => [e.action, e.closeJournalId])).toEqual([['close', null], ['reopen', null]]);
    });
  });
});

d('depreciation around a reopened year', () => {
  const MONTHLY = JT;

  /** A 12 jt asset in `fy` (12 months from Jan) with its schedule; nothing posted. */
  async function asset(tx: Tx, fy: FiscalYear, year: number) {
    const a = await tx.fixedAsset.create({
      data: {
        assetNumber: `IT-FYR-${tag()}`,
        name: `IT-FYR Mesin ${tag()}`,
        category: 'IT-FYR',
        acquisitionDate: new Date(`${year}-01-01`),
        acquisitionCost: 12 * MONTHLY,
        usefulLifeMonths: 12,
        bookValue: 12 * MONTHLY,
        assetAccountId: await account(tx, 'ASSET', 'Aset'),
        depreciationAccountId: await account(tx, 'EXPENSE', 'Beban penyusutan'),
        accumulatedDepAccountId: await account(tx, 'ASSET', 'Akumulasi penyusutan'),
        fiscalYearId: fy.id,
        createdBy: actor.userId,
      },
    });
    const entryIds: string[] = [];
    for (let m = 1; m <= 12; m++) {
      const e = await tx.depreciationEntry.create({
        data: { fixedAssetId: a.id, periodDate: new Date(`${year}-${String(m).padStart(2, '0')}-01`), amount: MONTHLY },
      });
      entryIds.push(e.id);
    }
    return { id: a.id, entryIds };
  }

  async function depreciate(assetId: string, entryId: string): Promise<string> {
    const r = await callRoute(fixedAssetsRouter, 'post', '/:id/depreciate', {
      params: { id: assetId },
      body: { entryId },
      ...asActor(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const entry = await state.tx!.depreciationEntry.findUniqueOrThrow({ where: { id: entryId }, include: { journalEntry: true } });
    return entry.journalEntry!.entryNumber;
  }

  it('a DEP posting after a reopen gets a new number (the CLOSE journal is no longer deleted)', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 10 * JT, 0);
      const fa = await asset(tx, b.next, Y + 1);

      expect((await close(b.fy.id)).status).toBe(200);
      const first = await depreciate(fa.id, fa.entryIds[0]!);
      // Before PR-8a the reopen deleted CLOSE, the journal count dropped by one and the next DEP
      // number repeated `first` (unique violation).
      expect((await reopen(b.fy.id, { reason: 'koreksi tahun lalu' })).status).toBe(200);
      const second = await depreciate(fa.id, fa.entryIds[1]!);
      expect(second).not.toBe(first);
    });
  });

  it('bulk depreciation for December of a reopened year posts', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const fa = await asset(tx, b.fy, Y);
      await trade(tx, b, 10 * JT, 0);
      expect((await close(b.fy.id)).status).toBe(200);
      expect((await reopen(b.fy.id, { reason: 'penyusutan Desember tertinggal' })).status).toBe(200);

      const r = await callRoute(fixedAssetsRouter, 'post', '/depreciate-bulk', { body: { month: `${Y}-12` }, ...asActor() });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ posted: 1, skipped: 0 });
      const dec = await tx.depreciationEntry.findUniqueOrThrow({ where: { id: fa.entryIds[11]! } });
      expect(dec.isPosted).toBe(true);
    });
  });
});
