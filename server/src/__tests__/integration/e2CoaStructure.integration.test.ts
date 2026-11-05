/**
 * Integration test: chart-of-accounts type and structure rules (E2-R6, G-6).
 *
 * Fixture: fiscal year 2198 (this file's only year, plan §6.3) as two half years, H1 closed and H2
 * open, a cash account and accounts numbered under their own prefixes. Everything runs in a
 * rollback transaction against the route handlers.
 * - A 7.x account credited 10 jt, then renamed: it stays REVENUE and the profit and loss revenue
 *   keeps the 10 jt (a rename used to flip every 5-8 account to EXPENSE).
 * - A 6.x expense with a balance: a move to 1.x is 400 ACCOUNT_STRUCTURE_LOCKED, also to a number
 *   that collides (400 comes before 409); a move inside the 6 prefix is 200; isGroup is locked too.
 * - Deactivating: a balance blocks; an expense whose only ledger rows sit in the closed year is
 *   allowed; one with a row in the open year is not.
 * - Creating: a detail parent is 400, a parent of another type is 400, a type that contradicts
 *   the prefix is 400, and a good child inherits its type from the number.
 * - GET /coa/flat flags only accounts with ledger rows as locked.
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
import { updateAccountBalance } from '../../utils/accountBalance';
import coaRouter from '../../routes/coa';
import reportsRouter from '../../routes/reports';

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

const Y = 2198;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
/** A number under the given prefix no seeded or earlier fixture account can hold. */
const numberUnder = (prefix: string) => `${prefix}.98${Date.now() % 100000}${++seq}`;

type RootType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function account(tx: Tx, rootType: RootType, accountNumber: string, extra: { isGroup?: boolean; parentId?: string } = {}) {
  return tx.account.create({
    data: { name: `IT-COA ${tag()}`, accountNumber, accountType: rootType, rootType, ...extra },
  });
}

async function halfYear(tx: Tx, half: 1 | 2, isClosed: boolean): Promise<FiscalYear> {
  const [start, end] = half === 1 ? ['01-01', '06-30'] : ['07-01', '12-31'];
  return tx.fiscalYear.create({
    data: {
      name: `IT-COA-${Y}H${half}-${tag()}`,
      startDate: new Date(`${Y}-${start}`),
      endDate: new Date(`${Y}-${end}`),
      isClosed,
      ...(isClosed ? { closedAt: new Date() } : {}),
    },
  });
}

/** A submitted two-line journal with its ledger rows; balances follow when `balances` is set. */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number, balances = true) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-COA-${tag()}`,
      date: new Date(date),
      narration: 'IT-COA fixture',
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
  if (balances) {
    await updateAccountBalance(tx, debitId, amount, 0);
    await updateAccountBalance(tx, creditId, 0, amount);
  }
}

const put = (id: string, body: Record<string, unknown>) => callRoute(coaRouter, 'put', '/:id', { params: { id }, body });
const create = (body: Record<string, unknown>) => callRoute(coaRouter, 'post', '/', { body });

async function revenueTotal(): Promise<number> {
  const r = await callRoute(reportsRouter, 'get', '/profit-loss', { query: { startDate: `${Y}-01-01`, endDate: `${Y}-12-31` } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.totalRevenue;
}

d('chart of accounts structure rules (E2-R6)', () => {
  it('a 7.x account stays REVENUE after a rename and keeps its profit and loss revenue', async () => {
    await inRollback(async (tx) => {
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const other = await account(tx, 'REVENUE', numberUnder('7'));
      await post(tx, open, `${Y}-08-10`, cash.id, other.id, 10 * JT);
      const before = await revenueTotal();
      expect(before).toBe(10 * JT);

      const r = await put(other.id, { name: 'Pendapatan lain-lain', accountNumber: other.accountNumber });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rootType).toBe('REVENUE');
      expect(r.body.accountType).toBe('REVENUE');
      expect(await revenueTotal()).toBe(before);
    });
  });

  it('freezes the prefix of an account with ledger rows, before checking uniqueness', async () => {
    await inRollback(async (tx) => {
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const expense = await account(tx, 'EXPENSE', numberUnder('6'));
      await post(tx, open, `${Y}-08-10`, expense.id, cash.id, 5 * JT);
      const taken = await account(tx, 'ASSET', numberUnder('1'));

      const moved = await put(expense.id, { accountNumber: numberUnder('1') });
      expect(moved.status).toBe(400);
      expect(moved.body.code).toBe('ACCOUNT_STRUCTURE_LOCKED');
      const collide = await put(expense.id, { accountNumber: taken.accountNumber });
      expect(collide.status).toBe(400);
      expect(collide.body.code).toBe('ACCOUNT_STRUCTURE_LOCKED');

      const within = numberUnder('6');
      const ok = await put(expense.id, { accountNumber: within });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ accountNumber: within, rootType: 'EXPENSE' });

      const sameInPrefix = await put(expense.id, { accountNumber: taken.accountNumber.replace(/^1/, '6') });
      expect(sameInPrefix.status).toBe(200);
    });
  });

  it('answers 409 for a taken number only when the structure allows the move', async () => {
    await inRollback(async (tx) => {
      const a = await account(tx, 'EXPENSE', numberUnder('6'));
      const b = await account(tx, 'EXPENSE', numberUnder('6'));
      const r = await put(a.id, { accountNumber: b.accountNumber });
      expect(r.status).toBe(409);
    });
  });

  it('freezes the group flag of an account with ledger rows', async () => {
    await inRollback(async (tx) => {
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const expense = await account(tx, 'EXPENSE', numberUnder('6'));
      await post(tx, open, `${Y}-08-10`, expense.id, cash.id, 5 * JT);
      const r = await put(expense.id, { isGroup: true });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ACCOUNT_STRUCTURE_LOCKED');
    });
  });

  it('re-derives the type when an empty account changes prefix, and refuses it with children', async () => {
    await inRollback(async (tx) => {
      const empty = await account(tx, 'EXPENSE', numberUnder('6'));
      const moved = await put(empty.id, { accountNumber: numberUnder('7') });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toMatchObject({ rootType: 'REVENUE', accountType: 'REVENUE' });

      const parent = await account(tx, 'REVENUE', numberUnder('7'), { isGroup: true });
      await account(tx, 'REVENUE', `${parent.accountNumber}.1`, { parentId: parent.id });
      const blocked = await put(parent.id, { accountNumber: numberUnder('4') });
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe('ACCOUNT_STRUCTURE_LOCKED');

      // Inside the same prefix the children would still be left under a number that is not theirs.
      const sameBranch = await put(parent.id, { accountNumber: numberUnder('7') });
      expect(sameBranch.status).toBe(400);
      expect(sameBranch.body.code).toBe('ACCOUNT_STRUCTURE_LOCKED');
    });
  });

  it('answers a malformed number on create with the ACCOUNT_NUMBER_FORMAT code', async () => {
    await inRollback(async () => {
      const r = await create({ accountNumber: '9.1', name: 'x' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ACCOUNT_NUMBER_FORMAT');
    });
  });

  it('refuses to deactivate an account with a balance, with an open-year row; allows a closed-year-only expense', async () => {
    await inRollback(async (tx) => {
      const closed = await halfYear(tx, 1, true);
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const withBalance = await account(tx, 'EXPENSE', numberUnder('6'));
      await post(tx, open, `${Y}-08-10`, withBalance.id, cash.id, 3 * JT);
      const blocked = await put(withBalance.id, { isActive: false });
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe('ACCOUNT_DEACTIVATE_BLOCKED');

      // Rows only in the closed year and a zero balance: the year was closed, nothing is open.
      const closedOnly = await account(tx, 'EXPENSE', numberUnder('6'));
      await post(tx, closed, `${Y}-03-10`, closedOnly.id, cash.id, 4 * JT, false);
      const ok = await put(closedOnly.id, { isActive: false });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.isActive).toBe(false);

      // The same expense with an open-year row whose balance was zeroed by hand still has a net.
      const openNet = await account(tx, 'EXPENSE', numberUnder('6'));
      await post(tx, open, `${Y}-09-10`, openNet.id, cash.id, 2 * JT, false);
      const net = await put(openNet.id, { isActive: false });
      expect(net.status).toBe(400);
      expect(net.body.code).toBe('ACCOUNT_DEACTIVATE_BLOCKED');
    });
  });

  it('refuses to deactivate a balance-sheet account whose history nets to a balance in a closed year', async () => {
    await inRollback(async (tx) => {
      const closed = await halfYear(tx, 1, true);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const equity = await account(tx, 'EQUITY', numberUnder('3'));
      await post(tx, closed, `${Y}-03-10`, cash.id, equity.id, 4 * JT, false);
      const r = await put(cash.id, { isActive: false });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ACCOUNT_DEACTIVATE_BLOCKED');
    });
  });

  it('refuses to deactivate a group with an active child', async () => {
    await inRollback(async (tx) => {
      const parent = await account(tx, 'EXPENSE', numberUnder('6'), { isGroup: true });
      await account(tx, 'EXPENSE', `${parent.accountNumber}.1`, { parentId: parent.id });
      const r = await put(parent.id, { isActive: false });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ACCOUNT_DEACTIVATE_BLOCKED');
    });
  });

  it('creates accounts under their parent and refuses a bad parent or type', async () => {
    await inRollback(async (tx) => {
      const detail = await account(tx, 'REVENUE', numberUnder('4'));
      const asDetail = await create({ accountNumber: `${detail.accountNumber}.1`, name: 'x', parentId: detail.id });
      expect(asDetail.status).toBe(400);
      expect(asDetail.body.code).toBe('ACCOUNT_PARENT_NOT_GROUP');

      const group = await account(tx, 'REVENUE', numberUnder('4'), { isGroup: true });
      const otherType = await create({ accountNumber: numberUnder('1'), name: 'x', parentId: group.id });
      expect(otherType.status).toBe(400);
      expect(otherType.body.code).toBe('ACCOUNT_PARENT_MISMATCH');

      const wrongType = await create({ accountNumber: numberUnder('7'), name: 'x', rootType: 'EXPENSE', accountType: 'EXPENSE' });
      expect(wrongType.status).toBe(400);
      expect(wrongType.body.code).toBe('ACCOUNT_TYPE_MISMATCH');

      const child = await create({ accountNumber: `${group.accountNumber}.1`, name: 'Anak', parentId: group.id });
      expect(child.status, JSON.stringify(child.body)).toBe(201);
      expect(child.body).toMatchObject({ rootType: 'REVENUE', accountType: 'REVENUE', parentId: group.id, isGroup: false });

      const root = await create({ accountNumber: numberUnder('7'), name: 'Lain-lain' });
      expect(root.status, JSON.stringify(root.body)).toBe(201);
      expect(root.body).toMatchObject({ rootType: 'REVENUE', accountType: 'REVENUE', parentId: null });
    });
  });

  it('flags only accounts with ledger rows as locked in /coa/flat', async () => {
    await inRollback(async (tx) => {
      const open = await halfYear(tx, 2, false);
      const cash = await account(tx, 'ASSET', numberUnder('1'));
      const used = await account(tx, 'EXPENSE', numberUnder('6'));
      const fresh = await account(tx, 'EXPENSE', numberUnder('6'));
      await post(tx, open, `${Y}-08-10`, used.id, cash.id, JT);
      const r = await callRoute(coaRouter, 'get', '/flat');
      expect(r.status).toBe(200);
      const byId = new Map<string, { locked: boolean }>(r.body.map((a: { id: string; locked: boolean }) => [a.id, a]));
      expect(byId.get(used.id)?.locked).toBe(true);
      expect(byId.get(fresh.id)?.locked).toBe(false);
    });
  });
});
