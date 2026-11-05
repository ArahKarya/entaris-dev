/**
 * Integration test: the year-close (CLOSE) journal as posted by POST /fiscal-years/:id/close
 * (E2-R3, PR-4.5a). Pins what the close journal looks like, so moving its writer onto the shared
 * posting function cannot change it unnoticed:
 * - profit 100 jt: one Submitted journal CLOSE-<name> dated on the year's last day, tagged FY_CLOSE
 *   with sourceKey FY_CLOSE:<year id>, DR current profit / CR retained earnings; two ledger rows
 *   (reference JournalEntry, the year's id, no party) and the running balances of both accounts;
 *   after a reopen the next close is CLOSE-<name>-R2 with the same key;
 * - the close still posts while the period lock covers the year's last month (the close journal
 *   skips the lock date; the reopen requires the lock to move back first);
 * - a mapped account that can no longer be posted to (inactive) refuses the close with its code and
 *   leaves the year open.
 * The 0,30 - 0,10 - 0,20 case (no CLOSE journal) stays in fiscalYearReopen.integration.test.ts.
 *
 * Route handlers run through the route harness, whose `$transaction` is a savepoint; everything
 * runs in a rollback transaction in fiscal years of its own (2188, 2189). The close checklist gate is
 * stubbed to pass (covered by fiscalYearCloseChecklist.integration.test.ts), and systemAccounts is
 * stubbed to map CURRENT_PROFIT / RETAINED_EARNINGS to fixture accounts.
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
vi.mock('../../services/fiscalYearClose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/fiscalYearClose')>()),
  assertCloseChecklistPasses: vi.fn(async () => undefined),
}));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { setPeriodLockInTx } from '../../services/periodLock';
import { updateAccountBalance } from '../../utils/accountBalance';
import fiscalYearsRouter from '../../routes/fiscalYears';

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

const Y = 2188;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type RootType = 'ASSET' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function account(tx: Tx, rootType: RootType, name: string): Promise<string> {
  const a = await tx.account.create({
    data: { name: `IT-CJP ${name}`, accountNumber: `IT-CJP-${tag()}`, accountType: rootType, rootType },
  });
  return a.id;
}

interface Books {
  fy: FiscalYear;
  cashId: string;
  revenueId: string;
  expenseId: string;
  currentProfitId: string;
  retainedId: string;
}

async function books(tx: Tx): Promise<Books> {
  const b: Books = {
    fy: await createFiscalYear(tx, { year: Y }),
    cashId: await account(tx, 'ASSET', 'Kas'),
    revenueId: await account(tx, 'REVENUE', 'Pendapatan'),
    expenseId: await account(tx, 'EXPENSE', 'Beban'),
    currentProfitId: await account(tx, 'EQUITY', 'Laba tahun berjalan'),
    retainedId: await account(tx, 'EQUITY', 'Laba ditahan'),
  };
  // A later open year, so the reopen's later-year check has something to share-lock.
  await createFiscalYear(tx, { year: Y + 1 });
  const original = systemAccounts.getAccounts.bind(systemAccounts);
  const fake = (id: string) => [{ id, accountNumber: id, name: id }];
  vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) => {
    if (role === 'CURRENT_PROFIT') return fake(b.currentProfitId);
    if (role === 'RETAINED_EARNINGS') return fake(b.retainedId);
    return original(role);
  });
  return b;
}

/** A submitted two-line journal in `fy` with its ledger rows and running balances. */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-CJP-${tag()}`,
      date: new Date(date),
      narration: 'IT-CJP fixture',
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

async function trade(tx: Tx, b: Books, rev: number, exp: number) {
  await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, rev);
  await post(tx, b.fy, `${Y}-04-15`, b.expenseId, b.cashId, exp);
}

async function balance(tx: Tx, id: string): Promise<number> {
  const a = await tx.account.findUniqueOrThrow({ where: { id }, select: { balance: true } });
  return Number(a.balance);
}

function close(fyId: string): Promise<RouteResult> {
  return callRoute(fiscalYearsRouter, 'post', '/:id/close', { params: { id: fyId }, userId: actor.userId, role: actor.role });
}

function reopen(fyId: string, reason: string): Promise<RouteResult> {
  return callRoute(fiscalYearsRouter, 'post', '/:id/reopen', { params: { id: fyId }, body: { reason }, userId: actor.userId, role: actor.role });
}

async function closeJournals(tx: Tx, fy: FiscalYear) {
  return tx.journalEntry.findMany({
    where: { fiscalYearId: fy.id, entryNumber: { startsWith: `CLOSE-${fy.name}` } },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });
}

const amounts = (rows: { accountId: string; debit: unknown; credit: unknown }[]) =>
  rows.map((r) => [r.accountId, Number(r.debit), Number(r.credit)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

d('year-close journal (POST /fiscal-years/:id/close)', () => {
  it('posts CLOSE-<name> on the last day with key FY_CLOSE:<id>, ledger rows and balances; re-close after a reopen is -R2', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 300 * JT, 200 * JT);

      const c1 = await close(b.fy.id);
      expect(c1.status, JSON.stringify(c1.body)).toBe(200);
      const [j] = await closeJournals(tx, b.fy);
      expect(j).toMatchObject({
        entryNumber: `CLOSE-${b.fy.name}`,
        status: 'Submitted',
        sourceType: 'FY_CLOSE',
        sourceKey: `FY_CLOSE:${b.fy.id}`,
        fiscalYearId: b.fy.id,
        narration: `Tutup Buku Tahun ${b.fy.name}`,
        createdBy: actor.userId,
      });
      expect(j!.date).toEqual(b.fy.endDate);
      expect(j!.submittedAt).not.toBeNull();
      const expected = amounts([
        { accountId: b.currentProfitId, debit: 100 * JT, credit: 0 },
        { accountId: b.retainedId, debit: 0, credit: 100 * JT },
      ]);
      expect(amounts(j!.items)).toEqual(expected);
      expect(j!.items.every((i) => i.partyId === null)).toBe(true);

      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: j!.id } });
      expect(amounts(ale)).toEqual(expected);
      for (const row of ale) {
        expect(row).toMatchObject({ referenceType: 'JournalEntry', fiscalYearId: b.fy.id, partyId: null, isCancelled: false });
        expect(row.date).toEqual(b.fy.endDate);
      }

      // Profit: DR current profit / CR retained earnings (both credit-normal).
      expect(await balance(tx, b.retainedId)).toBe(100 * JT);
      expect(await balance(tx, b.currentProfitId)).toBe(-100 * JT);

      expect((await reopen(b.fy.id, 'koreksi persediaan akhir tahun')).status).toBe(200);
      expect(await balance(tx, b.retainedId)).toBe(0);
      expect(await balance(tx, b.currentProfitId)).toBe(0);

      const c2 = await close(b.fy.id);
      expect(c2.status, JSON.stringify(c2.body)).toBe(200);
      const all = await closeJournals(tx, b.fy);
      expect(all.map((x) => [x.entryNumber, x.status, x.sourceKey])).toEqual([
        [`CLOSE-${b.fy.name}`, 'Cancelled', `FY_CLOSE:${b.fy.id}`],
        [`CLOSE-${b.fy.name}-R2`, 'Submitted', `FY_CLOSE:${b.fy.id}`],
      ]);
      expect(await balance(tx, b.retainedId)).toBe(100 * JT);
      expect(await balance(tx, b.currentProfitId)).toBe(-100 * JT);
    });
  });

  it('posts while the period lock covers the last month of the year', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await trade(tx, b, 50 * JT, 20 * JT);
      // Kept to the end of this test: the lock row is global (held FOR UPDATE until the rollback).
      await setPeriodLockInTx(tx, { lockDate: `${Y}-12-31`, reason: 'Uji tutup buku terkunci', userId: actor.userId, today: `${Y + 1}-02-01` });

      const r = await close(b.fy.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ id: b.fy.id, isClosed: true });
      const [j] = await closeJournals(tx, b.fy);
      expect(j).toMatchObject({ entryNumber: `CLOSE-${b.fy.name}`, status: 'Submitted', sourceKey: `FY_CLOSE:${b.fy.id}` });
      expect(await balance(tx, b.retainedId)).toBe(30 * JT);
    });
  });
});
