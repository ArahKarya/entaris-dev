/**
 * Moving a profit and loss system account role never reclasses (E2-R8, PR-4.12, plan R1 K-1).
 *
 * COGS on a group expense account with ledger rows in a closed year (2165) and an open one (2166)
 * moves to a detail account under it without transferBalance and without a journal: the year-end
 * close does not zero expense ledger rows, so a reclass would pull 2165's cost into 2166. The
 * ledger of both years stays where it was (the profit and loss report of each year is unchanged),
 * and the COGS mapping now resolves to the new account. Postings that still prefer a hardcoded 5.1
 * (sales invoice, delivery order) only read the mapping from PR-4.13a, which tests them.
 *
 * Everything runs in a rollback transaction on fixtures made here, in fiscal years 2165/2166.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { closedThenOpenYears } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import router from '../../routes/systemAccounts';
import reportsRouter from '../../routes/reports';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  vi.useRealTimers();
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
      systemAccounts.invalidateCache();
      try {
        await fn(tx);
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
        vi.useRealTimers();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Net ledger (debit − credit) of an account in one fiscal year. */
async function netIn(tx: Tx, accountId: string, fy: FiscalYear): Promise<number> {
  const agg = await tx.accountingLedgerEntry.aggregate({
    where: { accountId, fiscalYearId: fy.id, isCancelled: false },
    _sum: { debit: true, credit: true },
  });
  return Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
}

async function costRow(tx: Tx, fy: FiscalYear, userId: string, day: string, cogsId: string, contraId: string, amount: number) {
  const date = new Date(`${day}T00:00:00+07:00`);
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-RMP-${tag()}`, date, status: 'Submitted', fiscalYearId: fy.id, createdBy: userId,
      items: { create: [{ accountId: cogsId, debit: amount }, { accountId: contraId, credit: amount }] },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: [
      { date, accountId: cogsId, debit: amount, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
      { date, accountId: contraId, debit: 0, credit: amount, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
    ],
  });
}

d('profit and loss role remap (PR-4.12)', () => {
  it('COGS from group 5 to a detail account: 200 without transferBalance, no journal, both years unchanged', async () => {
    await inRollback(async (tx) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2166-06-15T10:00:00+07:00'));
      const { closed, open } = await closedThenOpenYears(tx, 2165);
      const { userId } = await createCapUser(tx, []);
      const group = await tx.account.create({
        data: { name: 'IT-RMP Beban Pokok', accountNumber: `IT-RMP-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE', isGroup: true },
      });
      const detail = await tx.account.create({
        data: { name: 'IT-RMP HPP', accountNumber: `IT-RMP-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE', parentId: group.id },
      });
      const stock = await tx.account.create({
        data: { name: 'IT-RMP Persediaan', accountNumber: `IT-RMP-${tag()}`, accountType: 'ASSET', rootType: 'ASSET' },
      });
      await tx.systemAccountMapping.deleteMany({ where: { role: 'COGS' } });
      await tx.systemAccountMapping.create({ data: { role: 'COGS', accountId: group.id } });
      await costRow(tx, closed, userId, '2165-05-10', group.id, stock.id, 100 * JT);
      await costRow(tx, open, userId, '2166-02-10', group.id, stock.id, 40 * JT);
      const journalsBefore = await tx.journalEntry.count();
      const profitLoss = async (year: number) => {
        const res = await callRoute(reportsRouter, 'get', '/profit-loss', { query: { startDate: `${year}-01-01`, endDate: `${year}-12-31` }, userId, role: 'Admin' });
        expect(res.status).toBe(200);
        return res.body as { totalExpense: number; netProfit: number };
      };
      const before = { closed: await profitLoss(2165), open: await profitLoss(2166) };
      expect(before.closed.totalExpense).toBe(100 * JT);
      expect(before.open.totalExpense).toBe(40 * JT);

      const r = await callRoute(router, 'put', '/', { body: { mappings: [{ role: 'COGS', accountId: detail.id }] }, userId, role: 'Admin' });
      expect(r.status).toBe(200);
      expect(r.body.transfers).toEqual([]);
      expect(await tx.journalEntry.count()).toBe(journalsBefore);
      expect(await tx.journalEntry.count({ where: { sourceKey: { startsWith: `REMAP:COGS:${group.id}:` } } })).toBe(0);

      expect(await netIn(tx, group.id, closed)).toBe(100 * JT);
      expect(await netIn(tx, group.id, open)).toBe(40 * JT);
      expect(await netIn(tx, detail.id, closed)).toBe(0);
      expect(await netIn(tx, detail.id, open)).toBe(0);
      expect(await profitLoss(2165)).toEqual(before.closed);
      expect(await profitLoss(2166)).toEqual(before.open);

      systemAccounts.invalidateCache();
      expect((await systemAccounts.getAccount('COGS')).id).toBe(detail.id);
    });
  });
});
