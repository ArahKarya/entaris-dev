/**
 * Integration test: the one stored-balance rule (services/ledger/storedBalances) and the cores of
 * scripts/repair/e2-stored-balance-recalc.ts (dry run) and scripts/repair/e2-orphan-ale-repair.ts
 * (services/ledger/orphanAleRepair).
 *
 * Fixture: fiscal year 2146 (this file's only year, plan §6.3) as four quarters, closed or open per
 * case. The year close is replayed the way routes/fiscalYears.ts still does it until PR-5.5
 * (subtract the year's revenue/expense contribution, add it back on reopen). Everything runs in a
 * rollback transaction and assertions only look at this file's accounts and references, except the
 * lock-order races, which need committed rows on two connections and delete them after.
 * - The dry run writes nothing; a difference equal to minus one closed year, to two closed years,
 *   or to a reopened year added back and another closed is `closed-year`; any other is
 *   `unexplained`; an account that agrees but has closed-year rows is listed as `ok`.
 * - recalculateAccountBalances writes only the accounts that differ, to the all-time ledger sum.
 * - Orphan groups: an open-year journal group is cancelled whole and its accounts rebalanced; a
 *   closed year, a locked month and a stock reference are left as they are; one audit row names the
 *   accountant; a stale plan is skipped; no approver, no run.
 * - A posting that waits for the recalculation's locks, or that the recalculation waits for, is
 *   neither lost nor counted twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, type Account, type FiscalYear, type RootType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import {
  findAccountBalanceDrift,
  planStoredBalanceRecalc,
  recalculateAccountBalances,
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
  ref: { referenceType?: string; referenceId?: string } = {},
) {
  const row = {
    date: new Date(date), fiscalYearId: fy.id,
    referenceType: ref.referenceType ?? 'ItFixture', referenceId: ref.referenceId ?? `it-bal-${tag()}`,
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
async function closeLikeRoute(tx: Tx, fy: FiscalYear, userId: string) {
  for (const { accountId, impact } of await yearImpacts(tx, fy)) {
    await tx.account.update({ where: { id: accountId }, data: { balance: { decrement: impact } } });
  }
  await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
  await tx.fiscalYearEvent.create({ data: { fiscalYearId: fy.id, action: 'close', userId } });
}

/** The reopen before PR-5.5: add the year's contribution back. */
async function reopenLikeRoute(tx: Tx, fy: FiscalYear, userId: string) {
  for (const { accountId, impact } of await yearImpacts(tx, fy)) {
    await tx.account.update({ where: { id: accountId }, data: { balance: { increment: impact } } });
  }
  await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: false, closedAt: null } });
  await tx.fiscalYearEvent.create({ data: { fiscalYearId: fy.id, action: 'reopen', userId, reason: 'test' } });
}

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
      expect(result.rebalanced.sort()).toEqual([cash.accountNumber, revenue.accountNumber].sort());

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

      // The same (now stale) plan again: nothing left to cancel, the group is skipped.
      const again = await applyOrphanAleRepair(tx, plan, { approvedBy: 'Akuntan Uji' });
      expect(again.applied).toEqual([]);
      expect(again.skipped).toEqual([{ key: orphanKey(group), reason: 'changed-since-plan' }]);
      const fresh = (await planOrphanAleRepair(tx)).filter((g) => ours.has(g.referenceId));
      expect(fresh.some((g) => g.action === 'repair')).toBe(false);
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
