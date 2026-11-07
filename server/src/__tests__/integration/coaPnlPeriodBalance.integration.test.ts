/**
 * Integration test: the COA Saldo column of profit and loss accounts is the current fiscal year
 * from the ledger (E2-R15a, PR-5.3).
 *
 * Fixture: fiscal year 2145 (this file's only year, plan §6.3) as two half years, H1 closed and H2
 * open; the clock is set into H2. A sales revenue account is credited 1 M in H1 and 200 jt in H2, and
 * its stored balance (accounts.balance) holds the sum, 1.2 M, like a production account that still
 * carries a closed year. Everything runs in a rollback transaction against the route handler.
 * - GET /coa: periodBalance of the revenue account is 200 jt although balance is 1.2 M; an expense
 *   shows its H2 amount; the CURRENT_PROFIT account shows the profit of H2; a balance sheet account
 *   has null.
 * - A cancelled journal's rows are not counted.
 * - No fiscal year holding today: P&L accounts get null for periodBalance and periodYearName.
 * - GET /coa/flat stays a flat array without the new fields.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { updateAccountBalance } from '../../utils/accountBalance';
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

const Y = 2145;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const numberUnder = (prefix: string) => `${prefix}.97${Date.now() % 100000}${++seq}`;

type RootType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

function account(tx: Tx, rootType: RootType, accountNumber: string, extra: { isGroup?: boolean; parentId?: string } = {}) {
  return tx.account.create({ data: { name: `IT-PNL ${tag()}`, accountNumber, accountType: rootType, rootType, ...extra } });
}

function halfYear(tx: Tx, half: 1 | 2, isClosed: boolean): Promise<FiscalYear> {
  const [start, end] = half === 1 ? ['01-01', '06-30'] : ['07-01', '12-31'];
  return tx.fiscalYear.create({
    data: {
      name: `IT-PNL-${Y}H${half}-${tag()}`,
      startDate: new Date(`${Y}-${start}`),
      endDate: new Date(`${Y}-${end}`),
      isClosed,
      ...(isClosed ? { closedAt: new Date() } : {}),
    },
  });
}

/** A two-line journal with ledger rows and balances; `cancelled` marks journal and rows cancelled. */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number, cancelled = false) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-PNL-${tag()}`,
      date: new Date(date),
      narration: 'IT-PNL fixture',
      status: cancelled ? 'Cancelled' : 'Submitted',
      fiscalYearId: fy.id,
      createdBy: actor.userId,
      submittedAt: new Date(),
      items: { create: [{ accountId: debitId, debit: amount, credit: 0 }, { accountId: creditId, debit: 0, credit: amount }] },
    },
  });
  const row = { date: new Date(date), referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id, isCancelled: cancelled };
  await tx.accountingLedgerEntry.createMany({
    data: [
      { ...row, accountId: debitId, debit: amount, credit: 0 },
      { ...row, accountId: creditId, debit: 0, credit: amount },
    ],
  });
  if (!cancelled) {
    await updateAccountBalance(tx, debitId, amount, 0);
    await updateAccountBalance(tx, creditId, 0, amount);
  }
}

/** Only the Date clock moves; timers stay real so the transaction timeout keeps working. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function stubProfitMapping(id: string) {
  const original = systemAccounts.getAccounts.bind(systemAccounts);
  vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) =>
    role === 'CURRENT_PROFIT' ? [{ id, accountNumber: id, name: id }] : original(role));
}

type Row = { id: string; balance: string; periodBalance?: string | null; periodYearName?: string | null; children: Row[] };
const flatten = (rows: Row[]): Row[] => rows.flatMap((r) => [r, ...flatten(r.children)]);

async function coaRows(): Promise<Map<string, Row>> {
  const r = await callRoute(coaRouter, 'get', '/');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(Array.isArray(r.body)).toBe(true);
  return new Map(flatten(r.body as Row[]).map((row) => [row.id, row]));
}

d('COA profit and loss balances of the current fiscal year (E2-R15a)', () => {
  it('shows 200 jt for the current year although the stored balance is 1.2 M, and the year profit on 3.4', async () => {
    await inRollback(async (tx) => {
      const closed = await halfYear(tx, 1, true);
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const revenue = await account(tx, 'REVENUE', numberUnder('4'));
      const expense = await account(tx, 'EXPENSE', numberUnder('6'));
      const profitAcc = await account(tx, 'EQUITY', numberUnder('3'));
      stubProfitMapping(profitAcc.id);
      await post(tx, closed, `${Y}-03-10`, cash.id, revenue.id, 1000 * JT);
      await post(tx, open, `${Y}-08-10`, cash.id, revenue.id, 200 * JT);
      await post(tx, open, `${Y}-08-11`, expense.id, cash.id, 50 * JT);
      clockAt(`${Y}-09-15T05:00:00Z`);

      const rows = await coaRows();
      const rev = rows.get(revenue.id)!;
      expect(Number(rev.balance)).toBe(1200 * JT);
      expect(rev.periodBalance).toBe(String(200 * JT));
      expect(rev.periodYearName).toBe(open.name);
      expect(rows.get(expense.id)!.periodBalance).toBe(String(50 * JT));
      expect(rows.get(profitAcc.id)!.periodBalance).toBe(String(150 * JT));
      expect(rows.get(profitAcc.id)!.periodYearName).toBe(open.name);
      expect(rows.get(cash.id)!.periodBalance).toBeNull();
      expect(rows.get(cash.id)!.periodYearName).toBeNull();
    });
  });

  it('does not count the rows of a cancelled journal and shows 0 for an account without rows', async () => {
    await inRollback(async (tx) => {
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const revenue = await account(tx, 'REVENUE', numberUnder('4'));
      const idle = await account(tx, 'REVENUE', numberUnder('7'));
      await post(tx, open, `${Y}-08-10`, cash.id, revenue.id, 200 * JT);
      await post(tx, open, `${Y}-08-12`, cash.id, revenue.id, 90 * JT, true);
      clockAt(`${Y}-09-15T05:00:00Z`);

      const rows = await coaRows();
      expect(rows.get(revenue.id)!.periodBalance).toBe(String(200 * JT));
      expect(Number(rows.get(idle.id)!.periodBalance)).toBe(0);
    });
  });

  it('has null period fields on profit and loss accounts when no fiscal year holds today', async () => {
    await inRollback(async (tx) => {
      await halfYear(tx, 2, false);
      const revenue = await account(tx, 'REVENUE', numberUnder('4'));
      clockAt('2160-06-15T05:00:00Z');

      const row = (await coaRows()).get(revenue.id)!;
      expect(row.periodBalance).toBeNull();
      expect(row.periodYearName).toBeNull();
    });
  });

  it('leaves GET /coa/flat a flat array without the period fields', async () => {
    await inRollback(async (tx) => {
      await halfYear(tx, 2, false);
      const revenue = await account(tx, 'REVENUE', numberUnder('4'));
      clockAt(`${Y}-09-15T05:00:00Z`);

      const r = await callRoute(coaRouter, 'get', '/flat');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      const row = (r.body as Record<string, unknown>[]).find((a) => a.id === revenue.id)!;
      expect(row).toBeDefined();
      expect('periodBalance' in row).toBe(false);
      expect('periodYearName' in row).toBe(false);
      expect('children' in row).toBe(false);
    });
  });
});
