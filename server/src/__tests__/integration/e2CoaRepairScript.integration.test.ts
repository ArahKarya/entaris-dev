/**
 * Integration test: core of scripts/repair/e2-coa-structure-check.ts (services/coa/coaStructureRepair).
 *
 * Fixture: fiscal year 2161 (this file's only year, plan §6.3) as two half years, H1 closed and H2
 * open. Everything runs in a rollback transaction; assertions only look at this file's accounts
 * since the database may hold other findings.
 * - The dry run (the plan) writes nothing and reports every kind of finding.
 * - --apply re-types a 7.x EXPENSE account to REVENUE: balance becomes the contribution of the
 *   open year only, profit per fiscal year is the same before and after, and one audit row names
 *   the accountant.
 * - An account with ledger rows in the closed year stops the run, writing nothing, until
 *   --include-closed-years is given.
 * - --apply without an approver name is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import {
  applyCoaStructureRepair,
  CoaRepairRefusal,
  COA_STRUCTURE_AUDIT_ACTION,
  planCoaStructureCheck,
  type CoaFindingRow,
} from '../../services/coa/coaStructureRepair';
import { updateAccountBalance } from '../../utils/accountBalance';

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

const Y = 2161;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const numberUnder = (prefix: string) => `${prefix}.96${Date.now() % 100000}${++seq}`;

type RootType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

const account = (tx: Tx, rootType: RootType, accountNumber: string, extra: { isGroup?: boolean; isActive?: boolean; parentId?: string } = {}) =>
  tx.account.create({ data: { name: `IT-REPAIR ${tag()}`, accountNumber, accountType: rootType, rootType, ...extra } });

async function halfYear(tx: Tx, half: 1 | 2, isClosed: boolean): Promise<FiscalYear> {
  const [start, end] = half === 1 ? ['01-01', '06-30'] : ['07-01', '12-31'];
  return tx.fiscalYear.create({
    data: {
      name: `IT-REPAIR-${Y}H${half}-${tag()}`,
      startDate: new Date(`${Y}-${start}`),
      endDate: new Date(`${Y}-${end}`),
      isClosed,
      ...(isClosed ? { closedAt: new Date() } : {}),
    },
  });
}

/** Ledger rows only, plus the incremental balance the way posting does it (by the stored type). */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number) {
  const row = { date: new Date(date), referenceType: 'JournalEntry', referenceId: `it-repair-${tag()}`, fiscalYearId: fy.id };
  await tx.accountingLedgerEntry.createMany({
    data: [
      { ...row, accountId: debitId, debit: amount, credit: 0 },
      { ...row, accountId: creditId, debit: 0, credit: amount },
    ],
  });
  await updateAccountBalance(tx, debitId, amount, 0);
  await updateAccountBalance(tx, creditId, 0, amount);
}

/** Profit of a fiscal year the way the year close computes it: revenue accounts minus expense accounts. */
async function profitOf(tx: Tx, fy: FiscalYear): Promise<Prisma.Decimal> {
  const sum = async (rootType: RootType) => {
    const r = await tx.accountingLedgerEntry.aggregate({
      where: { fiscalYearId: fy.id, isCancelled: false, account: { rootType } },
      _sum: { debit: true, credit: true },
    });
    return { debit: r._sum.debit ?? new Prisma.Decimal(0), credit: r._sum.credit ?? new Prisma.Decimal(0) };
  };
  const rev = await sum('REVENUE');
  const exp = await sum('EXPENSE');
  return rev.credit.minus(rev.debit).minus(exp.debit.minus(exp.credit));
}

async function ensureAdmin(tx: Tx): Promise<string> {
  const existing = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (existing) return existing.id;
  return (await tx.user.create({
    data: { username: `adm_${tag()}`, fullName: 'Admin Uji', email: `adm_${tag()}@uji.local`, passwordHash: 'x', role: 'Admin' },
  })).id;
}

const only = (plan: CoaFindingRow[], ids: string[]) => plan.filter((r) => ids.includes(r.accountId));

d('e2-coa-structure-check core', () => {
  it('dry run reports every finding kind and writes nothing', async () => {
    await inRollback(async (tx) => {
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const wrong = await account(tx, 'EXPENSE', numberUnder('7'));
      await post(tx, open, `${Y}-08-10`, cash.id, wrong.id, 4 * JT);
      const typed = await account(tx, 'ASSET', numberUnder('6'));
      const parent = await account(tx, 'ASSET', numberUnder('1'), { isGroup: true });
      const child = await account(tx, 'LIABILITY', `${parent.accountNumber}.1`, { parentId: parent.id });
      const group = await account(tx, 'ASSET', numberUnder('1'), { isGroup: true });
      await post(tx, open, `${Y}-08-11`, group.id, cash.id, JT);
      const inactive = await account(tx, 'ASSET', numberUnder('1'), { isActive: false });
      await post(tx, open, `${Y}-08-12`, inactive.id, cash.id, JT);
      const orphan = await account(tx, 'ASSET', numberUnder('1'));
      const ids = [wrong.id, typed.id, child.id, group.id, inactive.id, orphan.id];
      const before = await tx.account.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });

      const plan = only(await planCoaStructureCheck(tx), ids);
      // Every fixture number is dotted without a parent in the table, so each is also an orphan except the child.
      const kinds = (id: string) => plan.filter((r) => r.accountId === id && r.kind !== 'dottedOrphan').map((r) => [r.kind, r.action]);
      const orphans = plan.filter((r) => r.kind === 'dottedOrphan' && ids.includes(r.accountId)).map((r) => r.accountId).sort();

      expect(kinds(wrong.id)).toEqual([['revenueAsExpense', 'fix']]);
      expect(kinds(typed.id)).toEqual([['rootTypeVsPrefix', 'manual']]);
      expect(kinds(child.id)).toEqual([['rootTypeVsPrefix', 'manual'], ['childVsParent', 'manual']]);
      expect(kinds(group.id)).toEqual([['groupWithLedger', 'info']]);
      expect(kinds(inactive.id)).toEqual([['inactiveWithLedger', 'info']]);
      expect(kinds(orphan.id)).toEqual([]);
      expect(orphans).toEqual([wrong.id, typed.id, group.id, inactive.id, orphan.id].sort());
      expect(plan.find((r) => r.accountId === wrong.id)).toMatchObject({ expectedRootType: 'REVENUE', ledgerRows: 1, closedYearLedgerRows: 0 });

      expect(await tx.account.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(before);
      expect(await tx.auditLog.count({ where: { action: COA_STRUCTURE_AUDIT_ACTION, entityId: { in: ids } } })).toBe(0);
    });
  });

  it('--apply re-types 7.x to REVENUE: open-year balance, same profit per year, one audit row', async () => {
    await inRollback(async (tx) => {
      const admin = await ensureAdmin(tx);
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const expense = await account(tx, 'EXPENSE', numberUnder('6'));
      const wrong = await account(tx, 'EXPENSE', numberUnder('7'));
      // Other income of 10 jt stored on the expense side, and a 3 jt expense.
      await post(tx, open, `${Y}-08-10`, cash.id, wrong.id, 10 * JT);
      await post(tx, open, `${Y}-08-11`, expense.id, cash.id, 3 * JT);
      expect((await tx.account.findUniqueOrThrow({ where: { id: wrong.id } })).balance.toNumber()).toBe(-10 * JT);
      const profitBefore = await profitOf(tx, open);
      expect(profitBefore.toNumber()).toBe(7 * JT);

      const plan = only(await planCoaStructureCheck(tx), [wrong.id]);
      const result = await applyCoaStructureRepair(tx, plan, { approvedBy: ' Bu Akuntan ' });

      expect(result).toEqual({ approvedBy: 'Bu Akuntan', applied: [wrong.accountNumber], skipped: [] });
      expect(await tx.account.findUniqueOrThrow({ where: { id: wrong.id } })).toMatchObject({ rootType: 'REVENUE', accountType: 'REVENUE' });
      expect((await tx.account.findUniqueOrThrow({ where: { id: wrong.id } })).balance.toNumber()).toBe(10 * JT);
      expect((await profitOf(tx, open)).toNumber()).toBe(7 * JT);
      expect(await tx.account.findUniqueOrThrow({ where: { id: expense.id } })).toMatchObject({ rootType: 'EXPENSE' });

      const audit = await tx.auditLog.findMany({ where: { action: COA_STRUCTURE_AUDIT_ACTION, entityId: wrong.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ userId: admin, via: 'repair', entityType: 'Account' });
      expect(audit[0].viaMeta).toMatchObject({ approvedBy: 'Bu Akuntan' });
      expect(audit[0].oldValues).toMatchObject({ rootType: 'EXPENSE' });
    });
  });

  it('keeps profit per year when ledger rows sit in a closed year, and counts only the open year in balance', async () => {
    await inRollback(async (tx) => {
      await ensureAdmin(tx);
      const closed = await halfYear(tx, 1, true);
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const wrong = await account(tx, 'EXPENSE', numberUnder('7'));
      await post(tx, closed, `${Y}-02-10`, cash.id, wrong.id, 6 * JT);
      await post(tx, open, `${Y}-08-10`, cash.id, wrong.id, 4 * JT);
      // The close of H1 subtracted its contribution (as the expense side saw it: -6 jt).
      await tx.account.update({ where: { id: wrong.id }, data: { balance: -4 * JT } });
      const [closedProfit, openProfit] = [await profitOf(tx, closed), await profitOf(tx, open)];
      const plan = only(await planCoaStructureCheck(tx), [wrong.id]);
      expect(plan[0].closedYearLedgerRows).toBe(1);

      await expect(applyCoaStructureRepair(tx, plan, { approvedBy: 'Bu Akuntan' })).rejects.toBeInstanceOf(CoaRepairRefusal);
      await expect(applyCoaStructureRepair(tx, plan, { approvedBy: 'Bu Akuntan' })).rejects.toThrow(/--include-closed-years/);
      expect(await tx.account.findUniqueOrThrow({ where: { id: wrong.id } })).toMatchObject({ rootType: 'EXPENSE' });
      expect(await tx.auditLog.count({ where: { action: COA_STRUCTURE_AUDIT_ACTION, entityId: wrong.id } })).toBe(0);

      const result = await applyCoaStructureRepair(tx, plan, { approvedBy: 'Bu Akuntan', includeClosedYears: true });
      expect(result.applied).toEqual([wrong.accountNumber]);
      const after = await tx.account.findUniqueOrThrow({ where: { id: wrong.id } });
      expect(after.rootType).toBe('REVENUE');
      expect(after.balance.toNumber()).toBe(4 * JT);
      // Moving 7.x to the revenue side changes the sign of its contribution to the year (it was
      // booked as a negative expense), never the profit: revenue minus expense stays the same.
      expect((await profitOf(tx, closed)).equals(closedProfit)).toBe(true);
      expect((await profitOf(tx, open)).equals(openProfit)).toBe(true);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: COA_STRUCTURE_AUDIT_ACTION, entityId: wrong.id } });
      expect(audit.newValues).toMatchObject({ closedYearsAcknowledged: true });
    });
  });

  it('refuses --apply without an approver name', async () => {
    await inRollback(async (tx) => {
      await expect(applyCoaStructureRepair(tx, [], { approvedBy: '  ' })).rejects.toThrow('--apply needs --approved-by');
    });
  });
});
