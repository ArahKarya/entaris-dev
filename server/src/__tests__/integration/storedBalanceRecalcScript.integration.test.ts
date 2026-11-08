/**
 * Integration test: the one stored-balance rule (services/ledger/storedBalances) and the cores of
 * scripts/repair/e2-stored-balance-recalc.ts (dry run and --apply) and scripts/repair/e2-orphan-ale-repair.ts
 * (services/ledger/orphanAleRepair).
 *
 * Fixture: fiscal year 2146 (this file's only year, plan §6.3) as four quarters, closed or open per
 * case. The year close is replayed the way routes/fiscalYears.ts did it before PR-5.5 (subtract
 * the year's revenue/expense contribution, add it back on reopen): the state --apply repairs. Everything runs in a
 * rollback transaction and assertions only look at this file's accounts and references, except the
 * lock-order races, which need committed rows on two connections and delete them after.
 * - The dry run writes nothing; a difference equal to minus one closed year, to two closed years,
 *   or to a reopened year added back and another closed is `closed-year`, also when the reopened
 *   year got postings after the reopen or was closed again; any other is `unexplained`; an account
 *   that agrees but has closed-year rows is listed as `ok`.
 * - recalculateAccountBalances writes only the accounts that differ, to the all-time ledger sum.
 * - --apply: no approver, no run; only closed-year rows are written (unexplained ones only with
 *   includeUnexplained), one audit row per account names the accountant; a row whose difference
 *   moved after the plan is skipped; a second run finds nothing to write.
 * - Orphan groups: an open-year journal group is cancelled whole and its accounts rebalanced; a
 *   closed year, a locked month and a stock reference are left as they are; one audit row names the
 *   accountant; a stale plan is skipped; no approver, no run. Rows dated in a closed year or in no
 *   year are not cancelled whatever year they are tagged with; while a year is closed a revenue
 *   account only loses the cancelled amount.
 * - A posting that waits for the recalculation's locks, or that the recalculation waits for, is
 *   neither lost nor counted twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, type Account, type FiscalYear, type RootType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import {
  applyStoredBalanceRecalc,
  findAccountBalanceDrift,
  planStoredBalanceRecalc,
  recalculateAccountBalances,
  STORED_BALANCE_AUDIT_ACTION,
  type StoredBalancePlanRow,
} from '../../services/ledger/storedBalances';
import {
  applyOrphanAleRepair,
  ORPHAN_ALE_AUDIT_ACTION,
  orphanKey,
  planOrphanAleRepair,
} from '../../services/ledger/orphanAleRepair';
import { applyAccountImpacts, computeImpactDecimal, updateAccountBalance } from '../../utils/accountBalance';

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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2146;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const numberUnder = (prefix: string) => `${prefix}.946${Date.now() % 100000}${++seq}`;
const dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

const account = (db: Tx | PrismaClient, rootType: RootType) =>
  db.account.create({ data: { name: `IT-BAL ${tag()}`, accountNumber: numberUnder(rootType === 'ASSET' ? '1' : rootType === 'REVENUE' ? '4' : '6'), accountType: rootType, rootType } });

const QUARTERS = [['01-01', '03-31'], ['04-01', '06-30'], ['07-01', '09-30'], ['10-01', '12-31']] as const;

function quarter(db: Tx | PrismaClient, q: 1 | 2 | 3 | 4, isClosed = false): Promise<FiscalYear> {
  const [start, end] = QUARTERS[q - 1];
  return db.fiscalYear.create({
    data: {
      name: `IT-BAL-${Y}Q${q}-${tag()}`,
      startDate: new Date(`${Y}-${start}`),
      endDate: new Date(`${Y}-${end}`),
      isClosed,
      ...(isClosed ? { closedAt: new Date() } : {}),
    },
  });
}

/** Two balanced ledger rows plus the incremental balance the way posting does it. */
async function post(
  tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number,
  ref: { referenceType?: string; referenceId?: string; at?: Date } = {},
) {
  const row = {
    date: new Date(date), fiscalYearId: fy.id,
    referenceType: ref.referenceType ?? 'ItFixture', referenceId: ref.referenceId ?? `it-bal-${tag()}`,
    ...(ref.at ? { createdAt: ref.at } : {}),
  };
  await tx.accountingLedgerEntry.createMany({
    data: [
      { ...row, accountId: debitId, debit: amount, credit: 0 },
      { ...row, accountId: creditId, debit: 0, credit: amount },
    ],
  });
  await updateAccountBalance(tx, debitId, amount, 0);
  await updateAccountBalance(tx, creditId, 0, amount);
  return row.referenceId;
}

async function ensureAdmin(tx: Tx): Promise<string> {
  const existing = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (existing) return existing.id;
  return (await tx.user.create({
    data: { username: `adm_${tag()}`, fullName: 'Admin Uji', email: `adm_${tag()}@uji.local`, passwordHash: 'x', role: 'Admin' },
  })).id;
}

/** Revenue/expense contribution of one year per account, as the close loop sums it. */
async function yearImpacts(tx: Tx, fy: FiscalYear): Promise<{ accountId: string; impact: Prisma.Decimal }[]> {
  const sums = await tx.accountingLedgerEntry.groupBy({
    by: ['accountId'],
    where: { fiscalYearId: fy.id, isCancelled: false, account: { rootType: { in: ['REVENUE', 'EXPENSE'] } } },
    _sum: { debit: true, credit: true },
  });
  const accounts = await tx.account.findMany({ where: { id: { in: sums.map((s) => s.accountId) } }, select: { id: true, rootType: true } });
  const rootOf = new Map(accounts.map((a) => [a.id, a.rootType]));
  return sums.map((s) => ({ accountId: s.accountId, impact: computeImpactDecimal(rootOf.get(s.accountId)!, s._sum.debit ?? 0, s._sum.credit ?? 0) }));
}

/** The close of routes/fiscalYears.ts before PR-5.5: subtract the year's contribution. */
async function closeLikeRoute(tx: Tx, fy: FiscalYear, userId: string, at?: Date) {
  for (const { accountId, impact } of await yearImpacts(tx, fy)) {
    await tx.account.update({ where: { id: accountId }, data: { balance: { decrement: impact } } });
  }
  await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
  await tx.fiscalYearEvent.create({ data: { fiscalYearId: fy.id, action: 'close', userId, ...(at ? { createdAt: at } : {}) } });
}

/** The reopen before PR-5.5: add the year's contribution back. */
async function reopenLikeRoute(tx: Tx, fy: FiscalYear, userId: string, at?: Date) {
  for (const { accountId, impact } of await yearImpacts(tx, fy)) {
    await tx.account.update({ where: { id: accountId }, data: { balance: { increment: impact } } });
  }
  await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: false, closedAt: null } });
  await tx.fiscalYearEvent.create({ data: { fiscalYearId: fy.id, action: 'reopen', userId, reason: 'test', ...(at ? { createdAt: at } : {}) } });
}

/** Strictly increasing timestamps: one rollback transaction gives every default now() the same value. */
let clock = Date.now();
const tick = () => new Date((clock += 1000));

const rowOf = (rows: StoredBalancePlanRow[], a: Account) => rows.find((r) => r.accountId === a.id);
const balanceOf = async (tx: Tx, a: Account) => (await tx.account.findUniqueOrThrow({ where: { id: a.id } })).balance;

async function snapshot(tx: Tx, ids: string[]) {
  const accounts = await tx.account.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, balance: true, updatedAt: true } });
  const audits = await tx.auditLog.count();
  const active = await tx.accountingLedgerEntry.count({ where: { accountId: { in: ids }, isCancelled: false } });
  return { accounts: accounts.map((a) => ({ ...a, balance: a.balance.toString() })), audits, active };
}

d('stored balance rule and recalculation plan', () => {
  it('dry run writes nothing and explains minus one closed year', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const q2 = await quarter(tx, 2);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      await post(tx, q1, `${Y}-02-10`, cash.id, revenue.id, 1000 * JT);
      await post(tx, q2, `${Y}-05-10`, cash.id, revenue.id, 200 * JT);
      await closeLikeRoute(tx, q1, userId);
      expect((await balanceOf(tx, revenue)).toString()).toBe(String(200 * JT));

      const before = await snapshot(tx, [cash.id, revenue.id]);
      const { years, rows } = await planStoredBalanceRecalc(tx);
      const drift = await findAccountBalanceDrift(tx, { accountIds: [cash.id, revenue.id] });
      expect(await snapshot(tx, [cash.id, revenue.id])).toEqual(before);

      expect(years.find((y) => y.fiscalYearId === q1.id)).toMatchObject({ isClosed: true, reopened: false });
      const r = rowOf(rows, revenue)!;
      expect(r).toMatchObject({ class: 'closed-year', explanation: `-${q1.name}` });
      expect(r.stored.toString()).toBe(String(200 * JT));
      expect(r.fromLedger.toString()).toBe(String(1200 * JT));
      expect(r.difference.toString()).toBe(String(-1000 * JT));
      expect(r.closedYearContribution.toString()).toBe(String(1000 * JT));
      expect(r.contributions.map((c) => [c.year.fiscalYearId, c.contribution.toString()])).toEqual([[q1.id, String(1000 * JT)]]);
      expect(rowOf(rows, cash)).toBeUndefined();

      expect(drift.total).toBe(1);
      expect(drift.rows.map((x) => x.accountId)).toEqual([revenue.id]);
      expect(drift.rows[0].closedYearContribution.toString()).toBe(String(1000 * JT));
    });
  });

  it('explains two closed years together, and a reopened year counted twice next to a closed one', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const [q1, q2, q3] = [await quarter(tx, 1), await quarter(tx, 2), await quarter(tx, 3)];
      const cash = await account(tx, 'ASSET');
      const both = await account(tx, 'REVENUE');
      const mixed = await account(tx, 'EXPENSE');
      await post(tx, q1, `${Y}-02-01`, cash.id, both.id, 100 * JT);
      await post(tx, q2, `${Y}-05-01`, cash.id, both.id, 30 * JT);
      await post(tx, q3, `${Y}-08-01`, cash.id, both.id, 7 * JT);
      await post(tx, q1, `${Y}-02-02`, mixed.id, cash.id, 40 * JT);
      await post(tx, q2, `${Y}-05-02`, mixed.id, cash.id, 5 * JT);

      // Close Q1, recalculate the expense account (as a stock edit does), reopen Q1: its
      // contribution comes back on top of the restored history. Then close Q2 and Q3.
      await closeLikeRoute(tx, q1, userId);
      await recalculateAccountBalances(tx, [mixed.id]);
      await reopenLikeRoute(tx, q1, userId);
      await closeLikeRoute(tx, q2, userId);
      await closeLikeRoute(tx, q3, userId);

      const rows = (await planStoredBalanceRecalc(tx)).rows;
      // Revenue: Q1 subtracted and added back, Q2 and Q3 subtracted.
      expect(rowOf(rows, both)).toMatchObject({ class: 'closed-year', explanation: `-${q2.name} -${q3.name}` });
      expect(rowOf(rows, both)!.difference.toString()).toBe(String(-37 * JT));
      // Expense: Q1 counted twice (+), Q2 subtracted (-).
      expect(rowOf(rows, mixed)).toMatchObject({ class: 'closed-year', explanation: `+${q1.name} -${q2.name}` });
      expect(rowOf(rows, mixed)!.difference.toString()).toBe(String(35 * JT));
    });
  });

  it('explains a reopened year by the amount the reopen added back, after later postings and a second close', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      await post(tx, q1, `${Y}-02-10`, cash.id, revenue.id, 100 * JT, { at: tick() });
      await closeLikeRoute(tx, q1, userId, tick());
      await recalculateAccountBalances(tx, [revenue.id]);
      await reopenLikeRoute(tx, q1, userId, tick());
      // Posted into the reopened year: stored and ledger both rise, the year is now 120.
      await post(tx, q1, `${Y}-03-10`, cash.id, revenue.id, 20 * JT, { at: tick() });

      const open = rowOf((await planStoredBalanceRecalc(tx)).rows, revenue)!;
      expect(open.difference.toString()).toBe(String(100 * JT));
      expect(open.contributions.map((c) => c.contribution.toString())).toEqual([String(120 * JT)]);
      expect(open).toMatchObject({ class: 'closed-year', explanation: `+${q1.name}` });

      // Closed again: -120 on top of the +100 the reopen left.
      await closeLikeRoute(tx, q1, userId, tick());
      const again = rowOf((await planStoredBalanceRecalc(tx)).rows, revenue)!;
      expect(again.difference.toString()).toBe(String(-20 * JT));
      expect(again).toMatchObject({ class: 'closed-year', explanation: `+${q1.name} -${q1.name}` });
    });
  });

  it('marks any other difference unexplained and lists an agreeing closed-year account as ok', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      const agreeing = await account(tx, 'REVENUE');
      await post(tx, q1, `${Y}-03-01`, cash.id, revenue.id, 50 * JT);
      await post(tx, q1, `${Y}-03-02`, cash.id, agreeing.id, 9 * JT);
      await closeLikeRoute(tx, q1, userId);
      await recalculateAccountBalances(tx, [agreeing.id]);
      await tx.account.update({ where: { id: revenue.id }, data: { balance: { increment: '123.45' } } });
      await tx.account.update({ where: { id: cash.id }, data: { balance: { increment: '0.01' } } });

      const { rows } = await planStoredBalanceRecalc(tx);
      expect(rowOf(rows, revenue)).toMatchObject({ class: 'unexplained', explanation: null });
      expect(rowOf(rows, cash)).toMatchObject({ class: 'unexplained' });
      expect(rowOf(rows, cash)!.difference.toString()).toBe('0.01');
      expect(rowOf(rows, agreeing)).toMatchObject({ class: 'ok', explanation: null });
      expect(rowOf(rows, agreeing)!.contributions).toHaveLength(1);
    });
  });

  it('recalculates only the accounts that differ, to the all-time ledger sum, and is idempotent', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const q2 = await quarter(tx, 2);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      const expense = await account(tx, 'EXPENSE');
      await post(tx, q1, `${Y}-01-15`, cash.id, revenue.id, 10 * JT);
      await post(tx, q2, `${Y}-04-15`, cash.id, revenue.id, 2 * JT);
      await post(tx, q2, `${Y}-04-16`, expense.id, cash.id, 3 * JT);
      await closeLikeRoute(tx, q1, userId);
      await tx.account.update({ where: { id: expense.id }, data: { balance: 1 } });
      const cashBefore = await tx.account.findUniqueOrThrow({ where: { id: cash.id } });

      const first = await recalculateAccountBalances(tx, [cash.id, revenue.id, expense.id]);
      expect(first.changed.map((c) => c.accountId).sort()).toEqual([revenue.id, expense.id].sort());
      const rev = first.changed.find((c) => c.accountId === revenue.id)!;
      expect(rev.stored.toString()).toBe(String(2 * JT));
      expect(rev.fromLedger.toString()).toBe(String(12 * JT));
      expect((await balanceOf(tx, revenue)).toString()).toBe(String(12 * JT));
      expect((await balanceOf(tx, expense)).toString()).toBe(String(3 * JT));
      const cashAfter = await tx.account.findUniqueOrThrow({ where: { id: cash.id } });
      expect(cashAfter.updatedAt).toEqual(cashBefore.updatedAt);
      expect(cashAfter.balance.toString()).toBe(String(9 * JT));

      expect((await recalculateAccountBalances(tx, [cash.id, revenue.id, expense.id])).changed).toEqual([]);
      expect((await findAccountBalanceDrift(tx, { accountIds: [cash.id, revenue.id, expense.id] })).total).toBe(0);
    });
  });
});

d('stored balance recalculation --apply', () => {
  /** The plan rows of `accounts` only: the shared database may hold other drifting accounts. */
  const planOf = async (tx: Tx, accounts: Account[]) => {
    const ids = new Set(accounts.map((a) => a.id));
    return (await planStoredBalanceRecalc(tx)).rows.filter((r) => ids.has(r.accountId));
  };

  it('refuses without an approver and writes nothing', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      await post(tx, q1, `${Y}-02-10`, cash.id, revenue.id, 10 * JT);
      await closeLikeRoute(tx, q1, userId);
      const plan = await planOf(tx, [cash, revenue]);
      const before = await snapshot(tx, [cash.id, revenue.id]);
      await expect(applyStoredBalanceRecalc(tx, plan, { approvedBy: '  ' })).rejects.toThrow('--approved-by');
      expect(await snapshot(tx, [cash.id, revenue.id])).toEqual(before);
    });
  });

  it('writes only closed-year rows with one audit row each; unexplained only when asked; a second run writes nothing', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const q2 = await quarter(tx, 2);
      const cash = await account(tx, 'ASSET');
      const closedYear = await account(tx, 'REVENUE');
      const odd = await account(tx, 'EXPENSE');
      await post(tx, q1, `${Y}-02-10`, cash.id, closedYear.id, 1000 * JT);
      await post(tx, q2, `${Y}-05-10`, cash.id, closedYear.id, 200 * JT);
      await post(tx, q2, `${Y}-05-11`, odd.id, cash.id, 3 * JT);
      await closeLikeRoute(tx, q1, userId);
      await tx.account.update({ where: { id: odd.id }, data: { balance: { increment: '12.34' } } });

      const plan = await planOf(tx, [cash, closedYear, odd]);
      expect(plan.map((r) => [r.accountId, r.class]).sort()).toEqual([[closedYear.id, 'closed-year'], [odd.id, 'unexplained']].sort());

      const first = await applyStoredBalanceRecalc(tx, plan, { approvedBy: ' Bu Akuntan ' });
      expect(first.approvedBy).toBe('Bu Akuntan');
      expect(first.applied.map((c) => c.accountId)).toEqual([closedYear.id]);
      expect(first.skipped).toEqual([{ accountNumber: odd.accountNumber, reason: 'unexplained' }]);
      expect((await balanceOf(tx, closedYear)).toString()).toBe(String(1200 * JT));
      expect((await balanceOf(tx, odd)).toString()).toBe(dec(3 * JT).plus('12.34').toString());

      const audits = await tx.auditLog.findMany({ where: { action: STORED_BALANCE_AUDIT_ACTION, entityId: { in: [closedYear.id, odd.id] } } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entityType: 'Account', entityId: closedYear.id, via: 'repair',
        viaMeta: { script: STORED_BALANCE_AUDIT_ACTION, approvedBy: 'Bu Akuntan' },
        oldValues: { balance: String((200 * JT).toFixed(2)) },
      });
      expect(audits[0].newValues).toMatchObject({
        balance: (1200 * JT).toFixed(2), class: 'closed-year', explanation: `-${q1.name}`, approvedBy: 'Bu Akuntan',
      });

      const withOdd = await applyStoredBalanceRecalc(tx, await planOf(tx, [cash, closedYear, odd]), { approvedBy: 'Bu Akuntan', includeUnexplained: true });
      expect(withOdd.applied.map((c) => c.accountId)).toEqual([odd.id]);
      expect((await balanceOf(tx, odd)).toString()).toBe(String(3 * JT));

      // Nothing drifts any more: the closed-year account is listed as ok and nothing is written.
      const again = await planOf(tx, [cash, closedYear, odd]);
      expect(again.map((r) => r.class)).toEqual(['ok']);
      const before = await snapshot(tx, [cash.id, closedYear.id, odd.id]);
      expect(await applyStoredBalanceRecalc(tx, again, { approvedBy: 'Bu Akuntan', includeUnexplained: true })).toEqual({ approvedBy: 'Bu Akuntan', applied: [], skipped: [] });
      expect(await snapshot(tx, [cash.id, closedYear.id, odd.id])).toEqual(before);
    });
  });

  it('skips a row whose difference moved after the plan', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const q2 = await quarter(tx, 2);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      await post(tx, q1, `${Y}-02-10`, cash.id, revenue.id, 10 * JT);
      await closeLikeRoute(tx, q1, userId);
      const plan = await planOf(tx, [cash, revenue]);
      expect(plan.map((r) => r.class)).toEqual(['closed-year']);
      // A posting moves stored balance and ledger together: still the planned difference.
      await post(tx, q2, `${Y}-05-10`, cash.id, revenue.id, JT);
      // A hand edit does not.
      await tx.account.update({ where: { id: revenue.id }, data: { balance: { increment: 5 } } });

      const result = await applyStoredBalanceRecalc(tx, plan, { approvedBy: 'Bu Akuntan' });
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([{ accountNumber: revenue.accountNumber, reason: 'changed-since-plan' }]);
      expect((await balanceOf(tx, revenue)).toString()).toBe(String(JT + 5));
    });
  });
});

d('orphan ledger repair', () => {
  it('cancels an open-year journal group whole, reports the rest, and records the accountant', async () => {
    await inRollback(async (tx) => {
      const q1 = await quarter(tx, 1, true);
      const q3 = await quarter(tx, 3);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      // Open year after the lock date; the reference's ledger rows are spread over two postings.
      const repairId = `it-orphan-${tag()}`;
      await post(tx, q3, `${Y}-09-10`, cash.id, revenue.id, 3 * JT, { referenceType: 'JournalEntry', referenceId: repairId });
      await post(tx, q3, `${Y}-09-11`, cash.id, revenue.id, 2 * JT, { referenceType: 'JournalEntry', referenceId: repairId });
      const closedId = await post(tx, q1, `${Y}-02-01`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry' });
      const lockedId = await post(tx, q3, `${Y}-08-15`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry' });
      const stockId = await post(tx, q3, `${Y}-09-12`, cash.id, revenue.id, JT, { referenceType: 'StockMovement' });
      const realJournal = await post(tx, q3, `${Y}-09-13`, cash.id, revenue.id, JT, { referenceType: 'ItFixture' });
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${Y}-08-31`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      const ours = new Set([repairId, closedId, lockedId, stockId, realJournal]);

      const plan = (await planOrphanAleRepair(tx)).filter((g) => ours.has(g.referenceId));
      const actionOf = (id: string) => plan.find((g) => g.referenceId === id)?.action;
      expect(actionOf(repairId)).toBe('repair');
      expect(actionOf(closedId)).toBe('closed-year');
      expect(actionOf(lockedId)).toBe('period-locked');
      expect(actionOf(stockId)).toBe('stock-reference');
      expect(actionOf(realJournal)).toBeUndefined();
      const group = plan.find((g) => g.referenceId === repairId)!;
      expect(group).toMatchObject({ rows: 4, yearClosed: false, fiscalYearIds: [q3.id] });
      expect(group.debit.toString()).toBe(String(5 * JT));
      expect(group.credit.toString()).toBe(String(5 * JT));

      const revenueBefore = await balanceOf(tx, revenue);
      const result = await applyOrphanAleRepair(tx, plan, { approvedBy: 'Akuntan Uji' });
      expect(result.applied).toEqual([orphanKey(group)]);
      expect(result.skipped).toEqual([]);
      // Q1 is closed: revenue only loses the cancelled amount, cash is recalculated.
      expect(result.rebalanced).toEqual([cash.accountNumber]);
      expect(result.adjusted).toEqual([revenue.accountNumber]);

      const rowsOf = (referenceId: string) => tx.accountingLedgerEntry.findMany({ where: { referenceId } });
      expect((await rowsOf(repairId)).every((r) => r.isCancelled)).toBe(true);
      for (const id of [closedId, lockedId, stockId, realJournal]) {
        expect((await rowsOf(id)).every((r) => !r.isCancelled)).toBe(true);
      }
      expect((await balanceOf(tx, revenue)).toString()).toBe(dec(revenueBefore).minus(5 * JT).toString());
      expect((await findAccountBalanceDrift(tx, { accountIds: [cash.id, revenue.id] })).total).toBe(0);

      const audits = await tx.auditLog.findMany({ where: { action: ORPHAN_ALE_AUDIT_ACTION, entityId: repairId } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ entityType: 'JournalEntry', via: 'repair', viaMeta: { script: ORPHAN_ALE_AUDIT_ACTION, approvedBy: 'Akuntan Uji' } });
      expect(audits[0].oldValues).toMatchObject({ isCancelled: false, rows: 4, debit: '5000000.00' });
      expect(audits[0].newValues).toMatchObject({ isCancelled: true, approvedBy: 'Akuntan Uji', balanceUpdate: expect.stringContaining('revenue/expense') });

      // The same (now stale) plan again: nothing left to cancel, the group is skipped.
      const again = await applyOrphanAleRepair(tx, plan, { approvedBy: 'Akuntan Uji' });
      expect(again.applied).toEqual([]);
      expect(again.skipped).toEqual([{ key: orphanKey(group), reason: 'changed-since-plan' }]);
      const fresh = (await planOrphanAleRepair(tx)).filter((g) => ours.has(g.referenceId));
      expect(fresh.some((g) => g.action === 'repair')).toBe(false);
    });
  });

  it('judges a group by its row dates too: a stale open-year tag does not open a closed or missing year', async () => {
    await inRollback(async (tx) => {
      const q1 = await quarter(tx, 1, true);
      const q3 = await quarter(tx, 3);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${Y}-01-05`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      // Dated in closed Q1 but tagged with open Q3; dated in Q2, which has no fiscal year here.
      const inClosed = await post(tx, q3, `${Y}-03-20`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry' });
      const inNone = await post(tx, q3, `${Y}-05-10`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry' });
      // Spread over open and closed days, every row tagged with Q3: the closed day counts too.
      const spread = `it-orphan-${tag()}`;
      await post(tx, q3, `${Y}-09-01`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry', referenceId: spread });
      await post(tx, q1, `${Y}-02-01`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry', referenceId: spread });
      await post(tx, q3, `${Y}-03-25`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry', referenceId: spread });
      await tx.$executeRaw`UPDATE accounting_ledger_entries SET fiscal_year_id = ${q3.id} WHERE reference_id = ${spread}`;
      const ours = new Set([inClosed, inNone, spread]);

      const plan = (await planOrphanAleRepair(tx)).filter((g) => ours.has(g.referenceId));
      const actionOf = (id: string) => plan.find((g) => g.referenceId === id)?.action;
      expect(plan.every((g) => !g.yearClosed && g.fiscalYearIds.length === 1 && g.fiscalYearIds[0] === q3.id)).toBe(true);
      expect(actionOf(inClosed)).toBe('closed-year');
      expect(actionOf(inNone)).toBe('no-fiscal-year');
      expect(actionOf(spread)).toBe('closed-year');
      expect(q1.isClosed).toBe(true);

      const result = await applyOrphanAleRepair(tx, plan, { approvedBy: 'Akuntan Uji' });
      expect(result.applied).toEqual([]);
      const active = await tx.accountingLedgerEntry.count({ where: { referenceId: { in: [...ours] }, isCancelled: false } });
      expect(active).toBe(10);
    });
  });

  it('while a year is closed, takes only the cancelled amount off a revenue account', async () => {
    await inRollback(async (tx) => {
      const userId = await ensureAdmin(tx);
      const q1 = await quarter(tx, 1);
      const q3 = await quarter(tx, 3);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      await post(tx, q1, `${Y}-02-10`, cash.id, revenue.id, 10 * JT);
      await closeLikeRoute(tx, q1, userId);
      const id = await post(tx, q3, `${Y}-09-20`, cash.id, revenue.id, 3 * JT, { referenceType: 'JournalEntry' });
      const before = await balanceOf(tx, revenue);
      expect(before.toString()).toBe(String(3 * JT));

      const plan = (await planOrphanAleRepair(tx)).filter((g) => g.referenceId === id);
      expect(plan.map((g) => g.action)).toEqual(['repair']);
      const result = await applyOrphanAleRepair(tx, plan, { approvedBy: 'Akuntan Uji' });
      expect(result.adjusted).toEqual([revenue.accountNumber]);
      // Not the all-time 10 JT the recalculation would give, which a reopen of Q1 would raise to 20 JT.
      expect((await balanceOf(tx, revenue)).toString()).toBe('0');
      expect((await balanceOf(tx, cash)).toString()).toBe(String(10 * JT));
      const drift = rowOf((await planStoredBalanceRecalc(tx)).rows, revenue)!;
      expect(drift).toMatchObject({ class: 'closed-year', explanation: `-${q1.name}` });
    });
  });

  it('refuses --apply without an approver and writes nothing', async () => {
    await inRollback(async (tx) => {
      const q3 = await quarter(tx, 3);
      const cash = await account(tx, 'ASSET');
      const revenue = await account(tx, 'REVENUE');
      const id = await post(tx, q3, `${Y}-09-20`, cash.id, revenue.id, JT, { referenceType: 'JournalEntry' });
      const plan = (await planOrphanAleRepair(tx)).filter((g) => g.referenceId === id);
      expect(plan.map((g) => g.action)).toEqual(['repair']);
      await expect(applyOrphanAleRepair(tx, plan, { approvedBy: '  ' })).rejects.toThrow('--approved-by');
      expect((await tx.accountingLedgerEntry.findMany({ where: { referenceId: id } })).every((r) => !r.isCancelled)).toBe(true);
    });
  });
});

/** Resolves after `ms`, reporting whether `p` had settled by then. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return settled;
}

d('stored balance recalculation lock order (committed rows)', () => {
  let fy: FiscalYear;
  let cash: Account;
  let revenue: Account;
  const refs: string[] = [];

  /** A posting the way postJournal applies it: ledger rows, then the balance increments in id order. */
  async function postingTx(tx: Tx, amount: number) {
    const referenceId = `it-bal-race-${tag()}`;
    refs.push(referenceId);
    const row = { date: new Date(`${Y}-06-15`), fiscalYearId: fy.id, referenceType: 'ItFixture', referenceId };
    await tx.accountingLedgerEntry.createMany({
      data: [
        { ...row, accountId: cash.id, debit: amount, credit: 0 },
        { ...row, accountId: revenue.id, debit: 0, credit: amount },
      ],
    });
    await applyAccountImpacts(tx, [
      { accountId: cash.id, debit: amount, credit: 0 },
      { accountId: revenue.id, debit: 0, credit: amount },
    ]);
  }

  beforeAll(async () => {
    if (!hasDb) return;
    fy = await quarter(prisma, 2);
    cash = await account(prisma, 'ASSET');
    revenue = await account(prisma, 'REVENUE');
    await prisma.$transaction((tx) => postingTx(tx, 100));
  });

  afterAll(async () => {
    if (!hasDb || !fy) return;
    await prisma.accountingLedgerEntry.deleteMany({ where: { referenceId: { in: refs } } });
    await prisma.account.deleteMany({ where: { id: { in: [cash.id, revenue.id] } } });
    await prisma.fiscalYear.delete({ where: { id: fy.id } });
  });

  const balances = async () => {
    const rows = await prisma.account.findMany({ where: { id: { in: [cash.id, revenue.id] } } });
    return Object.fromEntries(rows.map((a) => [a.id === cash.id ? 'cash' : 'revenue', a.balance.toString()]));
  };

  it('a posting that starts while the recalculation holds the locks waits and adds on top', async () => {
    await prisma.account.update({ where: { id: revenue.id }, data: { balance: { increment: 50 } } });
    let posting: Promise<unknown> | null = null;
    await prisma.$transaction(async (tx) => {
      const { changed } = await recalculateAccountBalances(tx, [cash.id, revenue.id]);
      expect(changed.map((c) => c.accountId)).toEqual([revenue.id]);
      posting = prisma.$transaction((t) => postingTx(t, 30));
      expect(await settledWithin(posting, 400)).toBe(false);
    }, { timeout: 20000 });
    await posting;
    expect(await balances()).toEqual({ cash: '130', revenue: '130' });
  });

  it('a recalculation that starts while a posting holds the locks waits and counts it once', async () => {
    let recalc: Promise<{ changed: unknown[] }> | null = null;
    await prisma.$transaction(async (tx) => {
      await postingTx(tx, 20);
      recalc = prisma.$transaction((t) => recalculateAccountBalances(t, [cash.id, revenue.id]));
      expect(await settledWithin(recalc, 400)).toBe(false);
    }, { timeout: 20000 });
    expect((await recalc!).changed).toEqual([]);
    expect(await balances()).toEqual({ cash: '150', revenue: '150' });
    expect((await findAccountBalanceDrift(prisma as unknown as Tx, { accountIds: [cash.id, revenue.id] })).total).toBe(0);
  });
});
