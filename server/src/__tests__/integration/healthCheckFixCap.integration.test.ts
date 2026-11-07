/**
 * Integration test: POST /api/health-check/fix/account-balance-drift (E2-R14, PR-5.0; E2-R15, PR-5.5).
 *
 * Fixture year 2140 (unique to this file). Every case runs in a rollback transaction.
 * - Without the doc.cancel capability the fix answers 403 and changes nothing.
 * - With a closed fiscal year that holds revenue/expense ledger rows the preview lists the drifting
 *   account with its closed-year contribution and the fix runs (200): the stored balance becomes
 *   the all-time ledger sum, the ledger rows do not change (count and checksum), only drifting
 *   accounts are written, and the result names what changed.
 * - The health check reports the same drift for the fixture account, then none after the fix.
 * - A difference no close/reopen explains (owner decision #4) refuses the whole fix with
 *   STORED_BALANCE_REVIEW_REQUIRED: nothing is written, the closed-year account included.
 * - The success audit row (before/after per account) is written in the fix's transaction.
 * Each case first sets every stored balance to the ledger (inside the rollback), so drift already
 * in the database does not decide the outcome.
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
import { recalculateAccountBalances } from '../../services/ledger/storedBalances';
import { manualJournalRule } from '../../services/ledger/accountGuard';
import healthCheckRouter from '../../routes/healthCheck';
import { checkAccountBalanceDrift } from '../../routes/health/checks';

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

interface Books { fy: FiscalYear; revenueId: string; revenueNumber: string; expenseId: string; userId: string }

/** An open year with a balanced revenue/expense journal of 1 jt, posted through postJournal. */
async function books(tx: Tx): Promise<Books> {
  await recalculateAccountBalances(tx);
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
  return { fy, revenueId: revenue.id, revenueNumber: revenue.accountNumber, expenseId: expense.id, userId };
}

/** Count and checksum of every ledger row: the fix must not change any. */
async function ledgerFingerprint(tx: Tx) {
  const [row] = await tx.$queryRaw<{ n: bigint; sum: string }[]>`
    SELECT COUNT(*) AS n,
           md5(string_agg(id || ':' || debit::text || ':' || credit::text || ':' || is_cancelled::text, ',' ORDER BY id)) AS sum
      FROM accounting_ledger_entries`;
  return { n: Number(row.n), sum: row.sum };
}

const balanceOf = async (tx: Tx, id: string) => Number((await tx.account.findUniqueOrThrow({ where: { id } })).balance);

d('POST /fix/account-balance-drift (PR-5.0, PR-5.5)', () => {
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

  it('runs while a closed year holds revenue/expense rows; only the stored balance changes', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await tx.fiscalYear.update({ where: { id: b.fy.id }, data: { isClosed: true, closedAt: new Date() } });
      // What a close before the one stored-balance rule left: the year's revenue taken off.
      await tx.account.update({ where: { id: b.revenueId }, data: { balance: 0 } });
      const untouched = await tx.account.findUniqueOrThrow({ where: { id: b.expenseId } });
      const ledgerBefore = await ledgerFingerprint(tx);
      const { userId, role } = await createCapUser(tx, ['doc.cancel']);

      const preview = await callRoute(healthCheckRouter, 'get', '/preview/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(preview.status).toBe(200);
      expect(preview.body.data.count).toBeGreaterThanOrEqual(1);
      const listed = preview.body.data.details.find((r: { account_code: string }) => r.account_code === b.revenueNumber);
      expect(listed).toMatchObject({ stored_balance: 0, ledger_balance: 1_000_000, difference: -1_000_000, closed_year_contribution: 1_000_000 });

      const check = await checkAccountBalanceDrift({ accountIds: [b.revenueId, b.expenseId] });
      expect(check).toMatchObject({ status: 'warning', count: 1, fixable: true });

      const res = await callRoute(healthCheckRouter, 'post', '/fix/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.fixed).toBeGreaterThanOrEqual(1);
      expect(await balanceOf(tx, b.revenueId)).toBe(1_000_000);
      // An account that already agreed is not written.
      expect((await tx.account.findUniqueOrThrow({ where: { id: b.expenseId } })).updatedAt).toEqual(untouched.updatedAt);
      expect(await ledgerFingerprint(tx)).toEqual(ledgerBefore);
      expect(await checkAccountBalanceDrift({ accountIds: [b.revenueId, b.expenseId] })).toMatchObject({ status: 'ok', count: 0 });

      const audit = await tx.auditLog.findFirstOrThrow({ where: { userId, action: 'FIX_ACCOUNT_BALANCE_DRIFT' } });
      const values = audit.newValues as { fixed: number; snapshot: { changed: { account_code: string; before: string; after: string }[] } };
      expect(values.fixed).toBe(1);
      expect(values.snapshot.changed).toEqual([
        expect.objectContaining({ account_code: b.revenueNumber, before: '0.00', after: '1000000.00' }),
      ]);
    });
  });

  it('refuses the whole fix while a difference no close or reopen explains exists', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await tx.fiscalYear.update({ where: { id: b.fy.id }, data: { isClosed: true, closedAt: new Date() } });
      // Revenue: explained by the closed year. Expense: off by 7, which no close or reopen explains.
      await tx.account.update({ where: { id: b.revenueId }, data: { balance: 0 } });
      await tx.account.update({ where: { id: b.expenseId }, data: { balance: 1_000_007 } });
      const ledgerBefore = await ledgerFingerprint(tx);
      const { userId, role } = await createCapUser(tx, ['doc.cancel']);

      const preview = await callRoute(healthCheckRouter, 'get', '/preview/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(preview.status).toBe(200);
      expect(preview.body.data.count).toBe(2);
      expect(preview.body.data.description).toMatch(/ditolak: 1 dari 2 akun/);
      const classes = Object.fromEntries(preview.body.data.details.map((r: { account_code: string; class: string }) => [r.account_code, r.class]));
      expect(classes[b.revenueNumber]).toBe('closed-year');

      const res = await callRoute(healthCheckRouter, 'post', '/fix/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STORED_BALANCE_REVIEW_REQUIRED');
      expect(await balanceOf(tx, b.revenueId)).toBe(0);
      expect(await balanceOf(tx, b.expenseId)).toBe(1_000_007);
      expect(await ledgerFingerprint(tx)).toEqual(ledgerBefore);
      expect(await tx.auditLog.count({ where: { userId, action: 'FIX_ACCOUNT_BALANCE_DRIFT' } })).toBe(0);
    });
  });

  it('refuses a balance-sheet or profit-and-loss drift when no year is closed', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await tx.account.update({ where: { id: b.revenueId }, data: { balance: 7 } });
      const { userId, role } = await createCapUser(tx, ['doc.cancel']);
      const res = await callRoute(healthCheckRouter, 'post', '/fix/:check', { params: { check: 'account-balance-drift' }, userId, role });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STORED_BALANCE_REVIEW_REQUIRED');
      expect(await balanceOf(tx, b.revenueId)).toBe(7);
    });
  });
});
