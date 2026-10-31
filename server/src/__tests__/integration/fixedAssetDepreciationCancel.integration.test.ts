/**
 * Integration test: un-posting one depreciation entry of a fixed asset (E1-R5, PR-5b).
 *
 * Fixture: an asset of 12 jt over 12 months with its own accounts, two entries (Feb, Mar) posted
 * through the real POST /:id/depreciate route in its own fiscal year.
 * - Cancelling the newest entry voids its DEP journal (cancelledById, reason), cancels its ledger
 *   rows, puts the expense and accumulated-depreciation balances back, marks the row unposted and
 *   restores accumulatedDepreciation and bookValue. Posting it again writes a new DEP number.
 * - The older entry while the newer one is posted: DEPRECIATION_NOT_LAST; a second cancel:
 *   STALE_STATUS; a closed year: PERIOD_CLOSED; a role without doc.cancel: 403; another asset's
 *   entry: DEPRECIATION_ENTRY_NOT_FOUND; a disposed asset: FIXED_ASSET_NOT_ACTIVE; a journal voided
 *   outside the module: DEPRECIATION_JOURNAL_MISSING. Rejections change nothing.
 *
 * Route handlers run through the route harness, whose `$transaction` is a savepoint; everything
 * runs in a rollback transaction in a far-future year with fixtures made here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import {
  DEPRECIATION_ENTRY_NOT_FOUND,
  DEPRECIATION_JOURNAL_MISSING,
  DEPRECIATION_NOT_LAST,
  FIXED_ASSET_NOT_ACTIVE,
} from '../../services/fixedAssetDepreciationCancel';
import { STALE_STATUS } from '../../utils/cancelClaim';
import { voidJournalByIdInTx } from '../../utils/journalCancel';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import fixedAssetsRouter from '../../routes/fixedAssets';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
/** The acting user (doc.cancel) of the current test. */
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

const Y = 2097;
const MONTHLY = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Fixture {
  assetId: string;
  fiscalYearId: string;
  /** Schedule rows in period order (Jan..Dec of year Y); [0] and [1] are posted. */
  entryIds: string[];
  expenseAccountId: string;
  accumAccountId: string;
}

async function account(tx: Tx, rootType: 'ASSET' | 'EXPENSE', name: string): Promise<string> {
  const a = await tx.account.create({
    data: { name: `IT-FADC ${name}`, accountNumber: `IT-FADC-${tag()}`, accountType: rootType, rootType },
  });
  return a.id;
}

async function balances(tx: Tx, ids: string[]): Promise<Record<string, number>> {
  const rows = await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, balance: true } });
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.balance)]));
}

async function assetFigures(tx: Tx, id: string) {
  const a = await tx.fixedAsset.findUniqueOrThrow({ where: { id } });
  return { accumulatedDepreciation: Number(a.accumulatedDepreciation), bookValue: Number(a.bookValue), status: a.status };
}

function post(assetId: string, entryId: string): Promise<RouteResult> {
  return callRoute(fixedAssetsRouter, 'post', '/:id/depreciate', {
    params: { id: assetId },
    body: { entryId },
    userId: actor.userId,
    role: actor.role,
  });
}

function cancel(assetId: string, entryId: string, opts: { reason?: string; as?: { userId: string; role: string } } = {}) {
  const who = opts.as ?? actor;
  return callRoute(fixedAssetsRouter, 'post', '/:id/depreciation/:entryId/cancel', {
    params: { id: assetId, entryId },
    body: opts.reason === undefined ? {} : { reason: opts.reason },
    userId: who.userId,
    role: who.role,
  });
}

/** A 12 jt asset (12 months, no salvage) with the first two schedule rows posted through the route. */
async function assetWithTwoPosted(tx: Tx): Promise<Fixture> {
  const fy = await createFiscalYear(tx, { year: Y });
  const assetAccountId = await account(tx, 'ASSET', 'Aset');
  const expenseAccountId = await account(tx, 'EXPENSE', 'Beban penyusutan');
  const accumAccountId = await account(tx, 'ASSET', 'Akumulasi penyusutan');
  const asset = await tx.fixedAsset.create({
    data: {
      assetNumber: `IT-FADC-${tag()}`,
      name: `IT-FADC Mesin ${tag()}`,
      category: 'IT-FADC',
      acquisitionDate: new Date(`${Y}-01-01`),
      acquisitionCost: 12 * MONTHLY,
      usefulLifeMonths: 12,
      bookValue: 12 * MONTHLY,
      assetAccountId,
      depreciationAccountId: expenseAccountId,
      accumulatedDepAccountId: accumAccountId,
      fiscalYearId: fy.id,
      createdBy: actor.userId,
    },
  });
  const entryIds: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const e = await tx.depreciationEntry.create({
      data: { fixedAssetId: asset.id, periodDate: new Date(`${Y}-${String(m).padStart(2, '0')}-01`), amount: MONTHLY },
    });
    entryIds.push(e.id);
  }
  for (const id of entryIds.slice(0, 2)) {
    const r = await post(asset.id, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return { assetId: asset.id, fiscalYearId: fy.id, entryIds, expenseAccountId, accumAccountId };
}

/** Everything a rejected cancel must leave untouched. */
async function snapshot(tx: Tx, f: Fixture) {
  const entries = await tx.depreciationEntry.findMany({
    where: { fixedAssetId: f.assetId },
    select: { id: true, isPosted: true, journalEntryId: true },
    orderBy: { periodDate: 'asc' },
  });
  const journalIds = entries.flatMap((e) => (e.journalEntryId ? [e.journalEntryId] : []));
  const journals = await tx.journalEntry.findMany({ where: { id: { in: journalIds } }, select: { id: true, status: true }, orderBy: { id: 'asc' } });
  return {
    entries,
    journals,
    asset: await assetFigures(tx, f.assetId),
    balances: await balances(tx, [f.expenseAccountId, f.accumAccountId]),
  };
}

d('POST /fixed-assets/:id/depreciation/:entryId/cancel', () => {
  it('un-posts the newest entry: journal voided with its trail, balances and asset figures restored', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      expect(await assetFigures(tx, f.assetId)).toEqual({ accumulatedDepreciation: 2 * MONTHLY, bookValue: 10 * MONTHLY, status: 'Active' });
      expect(await balances(tx, [f.expenseAccountId, f.accumAccountId])).toEqual({
        [f.expenseAccountId]: 2 * MONTHLY,
        // Contra-asset on an ASSET root: a credit lowers it.
        [f.accumAccountId]: -2 * MONTHLY,
      });
      const { journalEntryId } = await tx.depreciationEntry.findUniqueOrThrow({ where: { id: f.entryIds[1] } });

      const r = await cancel(f.assetId, f.entryIds[1], { reason: '  salah periode  ' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({
        id: f.assetId,
        entryId: f.entryIds[1],
        journalEntryId,
        amount: MONTHLY,
        accumulatedDepreciation: MONTHLY,
        bookValue: 11 * MONTHLY,
      });
      expect(r.body.entryNumber).toMatch(/^DEP-/);

      const journal = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId! } });
      expect(journal).toMatchObject({ status: 'Cancelled', cancelledById: actor.userId, cancelReason: 'salah periode' });
      expect(journal.cancelledAt).not.toBeNull();
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: journalEntryId!, isCancelled: false } })).toBe(0);
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: journalEntryId!, isCancelled: true } })).toBe(2);

      expect(await tx.depreciationEntry.findUniqueOrThrow({ where: { id: f.entryIds[1] } })).toMatchObject({ isPosted: false, journalEntryId: null });
      expect(await tx.depreciationEntry.findUniqueOrThrow({ where: { id: f.entryIds[0] } })).toMatchObject({ isPosted: true });
      expect(await assetFigures(tx, f.assetId)).toEqual({ accumulatedDepreciation: MONTHLY, bookValue: 11 * MONTHLY, status: 'Active' });
      expect(await balances(tx, [f.expenseAccountId, f.accumAccountId])).toEqual({
        [f.expenseAccountId]: MONTHLY,
        [f.accumAccountId]: -MONTHLY,
      });

      // The older entry is now the newest posted one.
      const first = await cancel(f.assetId, f.entryIds[0]);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(await assetFigures(tx, f.assetId)).toEqual({ accumulatedDepreciation: 0, bookValue: 12 * MONTHLY, status: 'Active' });
      expect(await balances(tx, [f.expenseAccountId, f.accumAccountId])).toEqual({ [f.expenseAccountId]: 0, [f.accumAccountId]: 0 });
    });
  });

  it('posting the entry again after a cancel writes a new, unique DEP number', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      const r = await cancel(f.assetId, f.entryIds[1]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const again = await post(f.assetId, f.entryIds[1]);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.journalEntryId).not.toBe(r.body.journalEntryId);
      const repost = await tx.journalEntry.findUniqueOrThrow({ where: { id: again.body.journalEntryId } });
      expect(repost.entryNumber).not.toBe(r.body.entryNumber);
      expect(repost.status).not.toBe('Cancelled');
      expect(await tx.journalEntry.count({ where: { entryNumber: repost.entryNumber } })).toBe(1);
      expect(await assetFigures(tx, f.assetId)).toEqual({ accumulatedDepreciation: 2 * MONTHLY, bookValue: 10 * MONTHLY, status: 'Active' });
    });
  });

  it('rejects the older entry while a newer one is posted (DEPRECIATION_NOT_LAST)', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      const before = await snapshot(tx, f);
      const r = await cancel(f.assetId, f.entryIds[0]);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(DEPRECIATION_NOT_LAST);
      expect(await snapshot(tx, f)).toEqual(before);
    });
  });

  it('a second cancel of the same entry gets STALE_STATUS and reverses nothing twice', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      const first = await cancel(f.assetId, f.entryIds[1]);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const after = await snapshot(tx, f);

      const second = await cancel(f.assetId, f.entryIds[1]);
      expect(second.status).toBe(400);
      expect(second.body.code).toBe(STALE_STATUS);
      expect(await snapshot(tx, f)).toEqual(after);

      // A row that was never posted is rejected the same way.
      const unposted = await cancel(f.assetId, f.entryIds[5]);
      expect(unposted.status).toBe(400);
      expect(unposted.body.code).toBe(STALE_STATUS);
    });
  });

  it('rejects a cancel in a closed fiscal year (PERIOD_CLOSED)', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      await tx.fiscalYear.update({ where: { id: f.fiscalYearId }, data: { isClosed: true, closedAt: new Date() } });
      const before = await snapshot(tx, f);
      const r = await cancel(f.assetId, f.entryIds[1]);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(PERIOD_CLOSED);
      expect(await snapshot(tx, f)).toEqual(before);
    });
  });

  it('returns 403 for a role without doc.cancel', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      const noCap = await createCapUser(tx, []);
      const before = await snapshot(tx, f);
      const r = await cancel(f.assetId, f.entryIds[1], { as: noCap });
      expect(r.status).toBe(403);
      expect(await snapshot(tx, f)).toEqual(before);
    });
  });

  it('rejects an entry of another asset, a disposed asset and a journal voided outside the module', async () => {
    await inRollback(async (tx) => {
      const f = await assetWithTwoPosted(tx);
      const other = await assetWithTwoPosted(tx);
      const before = await snapshot(tx, f);

      const foreign = await cancel(f.assetId, other.entryIds[1]);
      expect(foreign.status).toBe(400);
      expect(foreign.body.code).toBe(DEPRECIATION_ENTRY_NOT_FOUND);
      expect(await snapshot(tx, f)).toEqual(before);

      await tx.fixedAsset.update({ where: { id: other.assetId }, data: { status: 'Disposed', disposalDate: new Date(`${Y}-06-30`) } });
      const disposed = await cancel(other.assetId, other.entryIds[1]);
      expect(disposed.status).toBe(400);
      expect(disposed.body.code).toBe(FIXED_ASSET_NOT_ACTIVE);
      expect(await tx.depreciationEntry.findUniqueOrThrow({ where: { id: other.entryIds[1] } })).toMatchObject({ isPosted: true });

      const { journalEntryId } = await tx.depreciationEntry.findUniqueOrThrow({ where: { id: f.entryIds[1] } });
      await voidJournalByIdInTx(tx, journalEntryId!);
      const voidedBefore = await snapshot(tx, f);
      const voided = await cancel(f.assetId, f.entryIds[1]);
      expect(voided.status).toBe(400);
      expect(voided.body.code).toBe(DEPRECIATION_JOURNAL_MISSING);
      expect(await snapshot(tx, f)).toEqual(voidedBefore);
    });
  });
});
