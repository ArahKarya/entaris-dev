/**
 * Integration test: depreciation posting racing an un-post of the same asset (E1-R5, PR-5b review).
 *
 * Fixture: a 12 jt asset over 12 months with its own accounts; January posted. Each race un-posts
 * January while February is posted, and the end state must match the ledger: accumulated
 * depreciation 1 jt (February only), book value 11 jt, accumulated-depreciation account -1 jt.
 * - POST /:id/depreciate starts while the un-post is applied but not committed: it read the asset
 *   before, so it must wait for the asset lock and move the figures relative to the committed row
 *   (not overwrite them with 2 jt).
 * - POST /depreciate-bulk starts while an un-post holds only the asset lock: it must wait on that lock
 *   before touching the account rows, so the un-post can finish (no deadlock, both succeed).
 * - Two posts of one row at once: one 200, one 400 STALE_STATUS, one journal.
 *
 * The races need committed rows on several connections, so the fixtures are created for real in a
 * far-future year and deleted after (pattern of cancelClaim.integration.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({
  client: null as PrismaClient | null,
  /** Runs once, at the end of the next route transaction, before it commits. */
  beforeCommit: null as null | (() => Promise<void>),
}));

// Route handlers use a real client here (not the rollback harness): each `$transaction` is its own
// connection, as in production.
vi.mock('../../lib/prisma', () => ({
  prisma: new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const client = state.client;
      if (!client) throw new Error('fixedAssetDepreciationRace test: no client');
      if (key === '$transaction') {
        return (fn: (t: Tx) => Promise<unknown>, opts?: { timeout?: number }) =>
          client.$transaction(async (t) => {
            const result = await fn(t as Tx);
            const hook = state.beforeCommit;
            state.beforeCommit = null;
            if (hook) await hook();
            return result;
          }, opts);
      }
      const value = (client as unknown as Record<string, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value;
    },
  }),
}));

import fixedAssetsRouter from '../../routes/fixedAssets';
import { cancelDepreciationEntryInTx } from '../../services/fixedAssetDepreciationCancel';
import { cancelTrail, STALE_STATUS } from '../../utils/cancelClaim';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  state.client = prisma;
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
});

afterAll(async () => {
  state.client = null;
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

const Y = 2087;
const MONTHLY = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Starts `p` and reports whether it settled within `ms`; the racing request must be waiting. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

/** A gate: `opened` resolves once `open` runs. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}

function post(assetId: string, entryId: string): Promise<RouteResult> {
  return callRoute(fixedAssetsRouter, 'post', '/:id/depreciate', { params: { id: assetId }, body: { entryId }, userId });
}

/** A committed 12 jt asset (12 months from January Y) with January posted; `cleanup` deletes all of it. */
async function seedAsset() {
  const fy = await createFiscalYear(prisma as unknown as Tx, { year: Y });
  const account = (rootType: 'ASSET' | 'EXPENSE', name: string) => prisma.account.create({
    data: { name: `IT-FADR ${name}`, accountNumber: `IT-FADR-${tag()}`, accountType: rootType, rootType },
  });
  const assetAccount = await account('ASSET', 'Aset');
  const expense = await account('EXPENSE', 'Beban penyusutan');
  const accum = await account('ASSET', 'Akumulasi penyusutan');
  const asset = await prisma.fixedAsset.create({
    data: {
      assetNumber: `IT-FADR-${tag()}`,
      name: `IT-FADR Mesin ${tag()}`,
      category: 'IT-FADR',
      acquisitionDate: new Date(`${Y}-01-01`),
      acquisitionCost: 12 * MONTHLY,
      usefulLifeMonths: 12,
      bookValue: 12 * MONTHLY,
      assetAccountId: assetAccount.id,
      depreciationAccountId: expense.id,
      accumulatedDepAccountId: accum.id,
      fiscalYearId: fy.id,
      createdBy: userId,
    },
  });
  const entryIds: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const e = await prisma.depreciationEntry.create({
      data: { fixedAssetId: asset.id, periodDate: new Date(`${Y}-${String(m).padStart(2, '0')}-01`), amount: MONTHLY },
    });
    entryIds.push(e.id);
  }
  const cleanup = async () => {
    state.beforeCommit = null;
    await prisma.depreciationEntry.deleteMany({ where: { fixedAssetId: asset.id } });
    await prisma.fixedAsset.delete({ where: { id: asset.id } });
    await prisma.accountingLedgerEntry.deleteMany({ where: { fiscalYearId: fy.id } });
    await prisma.journalItem.deleteMany({ where: { journalEntry: { fiscalYearId: fy.id } } });
    await prisma.journalEntry.deleteMany({ where: { fiscalYearId: fy.id } });
    await prisma.account.deleteMany({ where: { id: { in: [assetAccount.id, expense.id, accum.id] } } });
    await prisma.fiscalYear.delete({ where: { id: fy.id } });
  };
  try {
    const jan = await post(asset.id, entryIds[0]);
    expect(jan.status, JSON.stringify(jan.body)).toBe(200);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { assetId: asset.id, entryIds, expenseId: expense.id, accumId: accum.id, cleanup };
}

type Seeded = Awaited<ReturnType<typeof seedAsset>>;

/** January un-posted, February posted: the asset figures must agree with the ledger. */
async function expectFebruaryOnly(f: Seeded) {
  const asset = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: f.assetId } });
  expect({ acc: Number(asset.accumulatedDepreciation), book: Number(asset.bookValue) }).toEqual({ acc: MONTHLY, book: 11 * MONTHLY });
  const rows = await prisma.depreciationEntry.findMany({ where: { id: { in: f.entryIds.slice(0, 2) } }, orderBy: { periodDate: 'asc' } });
  expect(rows.map((r) => r.isPosted)).toEqual([false, true]);
  const balances = await prisma.account.findMany({ where: { id: { in: [f.expenseId, f.accumId] } } });
  expect(Object.fromEntries(balances.map((b) => [b.id, Number(b.balance)]))).toEqual({
    [f.expenseId]: MONTHLY,
    // Contra-asset on an ASSET root: a credit lowers it.
    [f.accumId]: -MONTHLY,
  });
}

d('depreciation posting racing an un-post of the same asset', () => {
  it('a single post started during an un-post waits for it and does not overwrite the restored figures', async () => {
    const f = await seedAsset();
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const applied = gate();
      const cancel = prisma.$transaction(async (t) => {
        await cancelDepreciationEntryInTx(t as unknown as Tx, f.assetId, f.entryIds[0], cancelTrail(userId));
        applied.open();
        await held;
      }, { timeout: 20000 });
      await applied.opened;

      const feb = post(f.assetId, f.entryIds[1]);
      expect(await stillPending(feb)).toBe(true);
      release();
      await cancel;
      const r = await feb;
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await expectFebruaryOnly(f);
    } finally {
      await f.cleanup();
    }
  });

  it('a bulk run started while an un-post holds the asset lock waits on that lock; both succeed', async () => {
    const f = await seedAsset();
    try {
      const locked = gate();
      const proceed = gate();
      const cancel = prisma.$transaction(async (t) => {
        await t.$queryRaw`SELECT id FROM fixed_assets WHERE id = ${f.assetId} FOR UPDATE`;
        locked.open();
        await proceed.opened;
        // Voids the January journal: updates the expense and accumulated-depreciation account rows.
        await cancelDepreciationEntryInTx(t as unknown as Tx, f.assetId, f.entryIds[0], cancelTrail(userId));
      }, { timeout: 20000 });
      await locked.opened;

      const bulk = callRoute(fixedAssetsRouter, 'post', '/depreciate-bulk', { body: { month: `${Y}-02` }, userId });
      expect(await stillPending(bulk)).toBe(true);
      proceed.open();
      await cancel;
      const r = await bulk;
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ posted: 1, totalAmount: MONTHLY, skipped: 0 });
      await expectFebruaryOnly(f);
    } finally {
      await f.cleanup();
    }
  });

  it('two posts of one row at once: one 200, one 400 STALE_STATUS and a single journal', async () => {
    const f = await seedAsset();
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const applied = gate();
      state.beforeCommit = async () => {
        applied.open();
        await held;
      };
      const first = post(f.assetId, f.entryIds[1]);
      await applied.opened;
      const second = post(f.assetId, f.entryIds[1]);
      expect(await stillPending(second)).toBe(true);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(b.status, JSON.stringify(b.body)).toBe(400);
      expect(b.body.code).toBe(STALE_STATUS);

      const entry = await prisma.depreciationEntry.findUniqueOrThrow({ where: { id: f.entryIds[1] } });
      expect(entry.journalEntryId).toBe(a.body.journalEntryId);
      expect(await prisma.journalEntry.count({ where: { sourceType: 'DEPRECIATION', narration: { contains: `${Y}-02` }, items: { some: { accountId: f.expenseId } } } })).toBe(1);
      const asset = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: f.assetId } });
      expect(Number(asset.accumulatedDepreciation)).toBe(2 * MONTHLY);
    } finally {
      await f.cleanup();
    }
  });
});
