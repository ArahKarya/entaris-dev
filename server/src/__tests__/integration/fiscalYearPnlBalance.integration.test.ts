/**
 * Integration test: closing and reopening a fiscal year keep the stored balances of revenue and
 * expense accounts (E2-R15, PR-5.5).
 *
 * Fixture: fiscal years 2147 and 2148 (this file's years, plan §6.3), a cash, a revenue and an
 * expense account, and two equity accounts that stand in for the CURRENT_PROFIT and
 * RETAINED_EARNINGS mappings (systemAccounts is stubbed). The close checklist gate is stubbed to
 * pass (fiscalYearCloseChecklist.integration.test.ts covers it). Everything runs in a rollback
 * transaction against the route handlers.
 * - Sales of 1 M in 2147 (closed) and 200 jt in 2148: the revenue account's stored balance is
 *   1.2 M, the COA Saldo column shows 200 jt for 2148, and nothing drifts from the ledger.
 * - Reopening and closing 2147 again (CLOSE-<name>-R2) leaves revenue and expense as they are;
 *   current profit and retained earnings follow the CLOSE journal; closeJournalPredicate finds
 *   both CLOSE journals of the year.
 * - PATCH /coa/:id/balance refuses a revenue or expense account (ACCOUNT_ROOT_TYPE) and posts
 *   nothing: its stored balance spans both years, so `new - stored` would hit the open year.
 * - A reopen without an active CLOSE although the last close recorded a profit logs a warning
 *   and still reopens.
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
import { closeJournalPredicate } from '../../services/ledger/closeJournals';
import { findAccountBalanceDrift } from '../../services/ledger/storedBalances';
import { updateAccountBalance } from '../../utils/accountBalance';
import { logger } from '../../lib/logger';
import fiscalYearsRouter from '../../routes/fiscalYears';
import coaRouter from '../../routes/coa';

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
  vi.useRealTimers();
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

const Y = 2147;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const numberUnder = (prefix: string) => `${prefix}.947${Date.now() % 100000}${++seq}`;

type RootType = 'ASSET' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function account(tx: Tx, rootType: RootType, prefix: string): Promise<string> {
  const a = await tx.account.create({
    data: { name: `IT-FYP ${tag()}`, accountNumber: numberUnder(prefix), accountType: rootType, rootType },
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

async function books(tx: Tx): Promise<Books> {
  const b: Books = {
    fy: await createFiscalYear(tx, { year: Y }),
    next: await createFiscalYear(tx, { year: Y + 1 }),
    cashId: await account(tx, 'ASSET', '1'),
    revenueId: await account(tx, 'REVENUE', '4'),
    expenseId: await account(tx, 'EXPENSE', '6'),
    currentProfitId: await account(tx, 'EQUITY', '3'),
    retainedId: await account(tx, 'EQUITY', '3'),
  };
  const original = systemAccounts.getAccounts.bind(systemAccounts);
  const fake = (id: string) => [{ id, accountNumber: id, name: id }];
  vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) => {
    if (role === 'CURRENT_PROFIT') return fake(b.currentProfitId);
    if (role === 'RETAINED_EARNINGS') return fake(b.retainedId);
    return original(role);
  });
  return b;
}

/** A submitted two-line journal in `fy` with its ledger rows and running balances, as a posting writes it. */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-FYP-${tag()}`,
      date: new Date(date),
      narration: 'IT-FYP fixture',
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

async function balance(tx: Tx, id: string): Promise<number> {
  return Number((await tx.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance);
}

const asActor = () => ({ userId: actor.userId, role: actor.role });
const close = (fyId: string): Promise<RouteResult> =>
  callRoute(fiscalYearsRouter, 'post', '/:id/close', { params: { id: fyId }, ...asActor() });
const reopen = (fyId: string, reason: string): Promise<RouteResult> =>
  callRoute(fiscalYearsRouter, 'post', '/:id/reopen', { params: { id: fyId }, body: { reason }, ...asActor() });

/** Accounts of the GET /coa tree, flattened. */
function flatten(nodes: Array<{ id: string; children?: unknown[] }>): Array<Record<string, unknown> & { id: string }> {
  return nodes.flatMap((n) => [n, ...flatten((n.children ?? []) as Array<{ id: string; children?: unknown[] }>)]);
}

d('fiscal year close and reopen keep revenue and expense balances (PR-5.5)', () => {
  it('2147 closed, 2148 open: revenue 1.2 M stored, 200 jt in the COA column, no drift; reopen and re-close change nothing', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const ids = [b.cashId, b.revenueId, b.expenseId, b.currentProfitId, b.retainedId];
      await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, 1000 * JT);
      await post(tx, b.fy, `${Y}-04-15`, b.expenseId, b.cashId, 100 * JT);
      await post(tx, b.next, `${Y + 1}-02-10`, b.cashId, b.revenueId, 200 * JT);

      const c1 = await close(b.fy.id);
      expect(c1.status, JSON.stringify(c1.body)).toBe(200);
      expect(await balance(tx, b.revenueId)).toBe(1200 * JT);
      expect(await balance(tx, b.expenseId)).toBe(100 * JT);
      // The CLOSE journal moves the 900 jt profit: DR current profit / CR retained earnings.
      expect(await balance(tx, b.currentProfitId)).toBe(-900 * JT);
      expect(await balance(tx, b.retainedId)).toBe(900 * JT);
      expect((await findAccountBalanceDrift(tx, { accountIds: ids })).total).toBe(0);

      // The COA page in 2148: the Saldo column is the open year's 200 jt, balance stays 1.2 M.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${Y + 1}-06-01T05:00:00Z`));
      const tree = await callRoute(coaRouter, 'get', '/', asActor());
      vi.useRealTimers();
      expect(tree.status).toBe(200);
      const revenueRow = flatten(tree.body).find((a) => a.id === b.revenueId)!;
      expect(revenueRow).toMatchObject({ periodBalance: String(200 * JT), periodYearName: b.next.name });
      expect(Number(revenueRow.balance)).toBe(1200 * JT);
      expect(flatten(tree.body).find((a) => a.id === b.currentProfitId)).toMatchObject({ periodBalance: String(200 * JT) });

      const r1 = await reopen(b.fy.id, 'koreksi persediaan akhir tahun');
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(await balance(tx, b.revenueId)).toBe(1200 * JT);
      expect(await balance(tx, b.expenseId)).toBe(100 * JT);
      expect(await balance(tx, b.currentProfitId)).toBe(0);
      expect(await balance(tx, b.retainedId)).toBe(0);

      const c2 = await close(b.fy.id);
      expect(c2.status, JSON.stringify(c2.body)).toBe(200);
      expect(await balance(tx, b.revenueId)).toBe(1200 * JT);
      expect(await balance(tx, b.expenseId)).toBe(100 * JT);
      expect(await balance(tx, b.currentProfitId)).toBe(-900 * JT);
      expect(await balance(tx, b.retainedId)).toBe(900 * JT);
      expect((await findAccountBalanceDrift(tx, { accountIds: ids })).total).toBe(0);

      const closes = await tx.journalEntry.findMany({ where: closeJournalPredicate(b.fy), orderBy: { createdAt: 'asc' } });
      expect(closes.map((j) => [j.entryNumber, j.status])).toEqual([
        [`CLOSE-${b.fy.name}`, 'Cancelled'],
        [`CLOSE-${b.fy.name}-R2`, 'Submitted'],
      ]);
      expect(await tx.journalEntry.count({ where: closeJournalPredicate(b.next) })).toBe(0);
    });
  });

  it('refuses an opening balance on revenue or expense once a closed year is in the stored balance', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, 1000 * JT);
      await post(tx, b.next, `${Y + 1}-02-10`, b.cashId, b.revenueId, 200 * JT);
      await post(tx, b.next, `${Y + 1}-02-11`, b.expenseId, b.cashId, 10 * JT);
      expect((await close(b.fy.id)).status).toBe(200);
      const journalsBefore = await tx.journalEntry.count();

      for (const id of [b.revenueId, b.expenseId]) {
        // 250 jt meant as this year's figure would have posted 250 jt - 1.2 M against revenue.
        const res = await callRoute(coaRouter, 'patch', '/:id/balance', { params: { id }, body: { balance: 250 * JT }, ...asActor() });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.code).toBe('ACCOUNT_ROOT_TYPE');
      }
      expect(await balance(tx, b.revenueId)).toBe(1200 * JT);
      expect(await balance(tx, b.expenseId)).toBe(10 * JT);
      expect(await tx.journalEntry.count()).toBe(journalsBefore);
    });
  });

  it('warns when a reopen finds no active CLOSE although the last close recorded a profit', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // Closed before reopen kept the CLOSE journal: the event has the profit, the journal is gone.
      await tx.fiscalYear.update({ where: { id: b.next.id }, data: { isClosed: true, closedAt: new Date(), closedBy: actor.userId } });
      await tx.fiscalYearEvent.create({ data: { fiscalYearId: b.next.id, action: 'close', userId: actor.userId, profit: 5 * JT } });
      const warn = vi.spyOn(logger, 'warn');

      const r = await reopen(b.next.id, 'jurnal tutup buku lama hilang');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ id: b.next.id, isClosed: false });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ fiscalYearId: b.next.id, profit: (5 * JT).toString() }),
        expect.stringContaining('no active CLOSE journal'),
      );
    });
  });

  it('does not warn on a reopen of a year closed at zero profit', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const c = await close(b.next.id);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const warn = vi.spyOn(logger, 'warn');
      const r = await reopen(b.next.id, 'buka lagi tanpa laba');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no active CLOSE journal'));
    });
  });
});
