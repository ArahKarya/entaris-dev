/**
 * Integration test: fiscal-year lookup by WIB business day (E2-R2).
 *
 * getOpenFiscalYear puts 31 Dec 23:30 WIB in the old year and 1 Jan 03:00 WIB in the new one,
 * and bulk depreciation for December and January both find their fiscal year (December used
 * to fail because the year "ended" at 31 Dec 07:00 WIB). Fiscal years are stored the way the
 * API stores them (`new Date('YYYY-MM-DD')`, UTC midnight). Everything runs in a rollback
 * transaction in a far future year.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { getOpenFiscalYear } from '../../utils/fiscalYear';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import fixedAssetsRouter from '../../routes/fixedAssets';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
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

const OLD = 2096;
const NEW = 2097;

async function twoYears(tx: Tx) {
  const tag = Math.random().toString(36).slice(2, 8);
  const mk = (y: number) =>
    tx.fiscalYear.create({ data: { name: `IT-FY-${y}-${tag}`, startDate: new Date(`${y}-01-01`), endDate: new Date(`${y}-12-31`) } });
  return { oldFy: await mk(OLD), newFy: await mk(NEW) };
}

d('fiscal year lookup by business day', () => {
  it('assigns year-end instants to the right year', async () => {
    await inRollback(async (tx) => {
      const { oldFy, newFy } = await twoYears(tx);
      const dec31 = await getOpenFiscalYear(tx, new Date(`${OLD}-12-31T16:30:00.000Z`)); // 23:30 WIB
      const jan1 = await getOpenFiscalYear(tx, new Date(`${OLD}-12-31T20:00:00.000Z`)); // 1 Jan 03:00 WIB
      expect(dec31.id).toBe(oldFy.id);
      expect(jan1.id).toBe(newFy.id);
    });
  });

  it('posts bulk depreciation for December and January', async () => {
    await inRollback(async (tx) => {
      const { oldFy, newFy } = await twoYears(tx);
      const [assetAcc, expenseAcc, accumAcc] = await Promise.all([
        tx.account.findFirst({ where: { rootType: 'ASSET', isGroup: false, isActive: true } }),
        tx.account.findFirst({ where: { rootType: 'EXPENSE', isGroup: false, isActive: true } }),
        tx.account.findFirst({ where: { rootType: 'ASSET', isGroup: false, isActive: true }, skip: 1 }),
      ]);
      if (!assetAcc || !expenseAcc || !accumAcc) throw new Error('Need asset and expense detail accounts.');
      const tag = Math.random().toString(36).slice(2, 8);
      const asset = await tx.fixedAsset.create({
        data: {
          assetNumber: `IT-FA-${tag}`,
          name: 'Mesin uji',
          category: 'Mesin',
          acquisitionDate: new Date(`${OLD}-12-01`),
          acquisitionCost: 1_200_000,
          usefulLifeMonths: 12,
          bookValue: 1_200_000,
          assetAccountId: assetAcc.id,
          depreciationAccountId: expenseAcc.id,
          accumulatedDepAccountId: accumAcc.id,
          fiscalYearId: oldFy.id,
          createdBy: userId,
          // Schedule rows as the API writes them: the 1st of each month at UTC midnight.
          depreciationEntries: {
            create: [
              { periodDate: new Date(`${OLD}-12-01T00:00:00.000Z`), amount: 100_000 },
              { periodDate: new Date(`${NEW}-01-01T00:00:00.000Z`), amount: 100_000 },
            ],
          },
        },
      });

      for (const [month, fy] of [[`${OLD}-12`, oldFy], [`${NEW}-01`, newFy]] as const) {
        const r = await callRoute(fixedAssetsRouter, 'post', '/depreciate-bulk', { body: { month }, userId });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.posted).toBe(1);
        const entry = await tx.depreciationEntry.findFirst({
          where: { fixedAssetId: asset.id, isPosted: true, journalEntry: { fiscalYearId: fy.id } },
        });
        expect(entry, month).not.toBeNull();
      }
    });
  });
});
