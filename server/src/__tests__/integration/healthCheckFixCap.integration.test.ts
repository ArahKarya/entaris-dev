/**
 * Integration test: POST /api/health-check/fix/account-balance-drift (E2-R14, PR-5.0).
 *
 * Fixture year 2140 (unique to this file). Every case runs in a rollback transaction.
 * - Without the doc.cancel capability the fix answers 403 and changes nothing.
 * - With a closed fiscal year that holds revenue/expense ledger rows the fix and its preview answer
 *   400 FIX_DRIFT_CLOSED_YEARS and accounts.balance stays as it was (interim guard until the single
 *   stored-balance rule).
 * - With no closed year holding such rows the fix runs (200) and rewrites the balance from the ledger.
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

import { postJournal } from '../../services/ledger/postJournal';
import { manualJournalRule } from '../../services/ledger/accountGuard';
import healthCheckRouter from '../../routes/healthCheck';

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

const Y = 2140;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books { fy: FiscalYear; revenueId: string; expenseId: string; userId: string }

/** An open year with a balanced revenue/expense journal of 1 jt, posted through postJournal. */
async function books(tx: Tx): Promise<Books> {
  const fy = await createFiscalYear(tx, { year: Y });
  const revenue = await tx.account.create({
    data: { name: 'IT-HCF Pendapatan', accountNumber: `IT-HCF-R-${tag()}`, accountType: 'REVENUE', rootType: 'REVENUE' },
  });
  const expense = await tx.account.create({
    data: { name: 'IT-HCF Beban', accountNumber: `IT-HCF-E-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE' },
  });
  const { userId } = await createCapUser(tx, []);
  await postJournal(tx, {
    date: new Date(`${Y}-05-20T00:00:00+07:00`), narration: 'IT-HCF', createdBy: userId, sourceType: 'MANUAL',
    accountRule: manualJournalRule(true), partyRule: 'strict', partyEffect: 'recalc',
    lines: [{ accountId: expense.id, debit: 1_000_000 }, { accountId: revenue.id, credit: 1_000_000 }],
  });
  return { fy, revenueId: revenue.id, expenseId: expense.id, userId };
}

const balanceOf = async (tx: Tx, id: string) => Number((await tx.account.findUniqueOrThrow({ where: { id } })).balance);

d('POST /fix/account-balance-drift (PR-5.0)', () => {
  it('answers 403 without doc.cancel and leaves the balance alone', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await tx.account.update({ where: { id: b.revenueId }, data: { balance: 7 } });
      const { userId, role } = await createCapUser(tx, []);
      const res = await callRoute(healthCheckRouter, 'post', '/fix/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(res.status).toBe(403);
      expect(await balanceOf(tx, b.revenueId)).toBe(7);
    });
  });

  it('refuses with FIX_DRIFT_CLOSED_YEARS while a closed year holds revenue/expense rows', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await tx.fiscalYear.update({ where: { id: b.fy.id }, data: { isClosed: true, closedAt: new Date() } });
      await tx.account.update({ where: { id: b.revenueId }, data: { balance: 7 } });
      const { userId, role } = await createCapUser(tx, ['doc.cancel']);
      const res = await callRoute(healthCheckRouter, 'post', '/fix/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FIX_DRIFT_CLOSED_YEARS');
      expect(await balanceOf(tx, b.revenueId)).toBe(7);

      const preview = await callRoute(healthCheckRouter, 'get', '/preview/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(preview.status).toBe(400);
      expect(preview.body.code).toBe('FIX_DRIFT_CLOSED_YEARS');
    });
  });

  it('runs and rewrites the balance from the ledger when no closed year holds such rows', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // Other closed years in a shared database would trip the guard; this transaction is rolled back.
      await tx.fiscalYear.updateMany({ where: { isClosed: true }, data: { isClosed: false } });
      await tx.account.update({ where: { id: b.revenueId }, data: { balance: 7 } });
      const { userId, role } = await createCapUser(tx, ['doc.cancel']);
      const res = await callRoute(healthCheckRouter, 'post', '/fix/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(res.status).toBe(200);
      expect(await balanceOf(tx, b.revenueId)).toBe(1_000_000);
      expect(await balanceOf(tx, b.expenseId)).toBe(1_000_000);
    });
  });
});
