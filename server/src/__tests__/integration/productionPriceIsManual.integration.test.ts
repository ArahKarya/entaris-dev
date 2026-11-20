/**
 * E6-R8 (PR-6.11b): price_is_manual. A main output price the user typed is kept on edit; a price
 * back-filled with the loaded HPP is refilled from the new HPP instead of frozen. Fixture year
 * 2122, everything in a rollback transaction on fixtures made here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, callRoute, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import productionRunsRouter from '../../routes/inventory/productionRuns';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { submitProductionRunInTx, type SubmitProductionRunInput } from '../../services/productionRunSubmit';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import {
  createProductionWorld,
  seedWorldStock,
  worldDate,
  movementsOf,
  assertBalancesMatchAle,
  type ProductionWorld,
} from '../helpers/productionFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2122;

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

async function inWorld(fn: (tx: Tx, world: ProductionWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      systemAccounts.invalidateCache();
      try {
        await fn(tx, await createProductionWorld(tx, YEAR));
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** GKP 1.000 kg at 6.000 -> beras 600 kg, no conversion cost: HPP 10.000. */
function body(w: ProductionWorld, over: Partial<SubmitProductionRunInput> = {}): SubmitProductionRunInput {
  return {
    date: worldDate(w),
    warehouseId: w.warehouseA.id,
    inputs: [{ itemId: w.items.gkp.id, quantity: 1000 }],
    outputs: [{ itemId: w.items.beras.id, quantity: 600 }],
    ...over,
  };
}

const outputLines = (tx: Tx, runId: string) =>
  tx.productionRunItem.findMany({ where: { productionRunId: runId, lineType: { in: ['Output', 'ByProduct'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

d('production price_is_manual (E6-R8)', () => {
  it('edit refills a back-filled price from the new HPP, with no 5.1 line', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, body(w), w.userId))!;
      const [first] = await outputLines(tx, run.id);
      expect(Number(first!.unitPrice)).toBe(10000);
      expect(first!.priceIsManual).toBe(false);

      // The form prefilled from the stored line sends 10.000 back as if typed.
      const edited = (await editProductionRunInTx(tx, run.id, body(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1100 }],
        outputs: [{ itemId: w.items.beras.id, quantity: 600, unitPrice: 10000 }],
      }), w.userId))!;

      const stored = await tx.productionRun.findUniqueOrThrow({ where: { id: edited.id } });
      expect(Number(stored.computedHpp)).toBe(11000);
      const [line] = await outputLines(tx, run.id);
      expect(Number(line!.unitPrice)).toBe(11000);
      expect(line!.priceIsManual).toBe(false);
      const mv = (await movementsOf(tx, run.id, { activeOnly: true })).find((m) => m.itemId === w.items.beras.id)!;
      expect(mv).toMatchObject({ quantity: 600, unitCost: 11000, totalValue: 6_600_000 });
      expect(mv.unitCost).toBe(Number(stored.computedHpp));
      const cogsLines = await tx.accountingLedgerEntry.count({ where: { accountId: w.accounts.cogs.id, isCancelled: false } });
      expect(cogsLines).toBe(0);
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('keeps a typed price through an edit and flags it manual', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, body(w, {
        outputs: [{ itemId: w.items.beras.id, quantity: 600, unitPrice: 12000 }],
      }), w.userId))!;
      expect((await outputLines(tx, run.id))[0]!.priceIsManual).toBe(true);

      await editProductionRunInTx(tx, run.id, body(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1100 }],
        outputs: [{ itemId: w.items.beras.id, quantity: 600, unitPrice: 12000 }],
      }), w.userId);
      const [line] = await outputLines(tx, run.id);
      expect(Number(line!.unitPrice)).toBe(12000);
      expect(line!.priceIsManual).toBe(true);
    });
  });

  it('keeps by-product NRV as typed and not manual', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, body(w, {
        outputs: [
          { itemId: w.items.beras.id, quantity: 600 },
          { itemId: w.items.bekatul.id, quantity: 100, unitPrice: 2000, isByProduct: true },
        ],
      }), w.userId))!;
      const lines = await outputLines(tx, run.id);
      const by = lines.find((l) => l.isByProduct)!;
      expect(Number(by.unitPrice)).toBe(2000);
      expect(by.priceIsManual).toBe(false);
    });
  });

  it('edits one of three main outputs of the same item and matches lines by order', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const three = (price2?: number) => [
        { itemId: w.items.beras.id, quantity: 200 },
        { itemId: w.items.beras.id, quantity: 200, ...(price2 ? { unitPrice: price2 } : {}) },
        { itemId: w.items.beras.id, quantity: 200 },
      ];
      const run = (await submitProductionRunInTx(tx, body(w, { outputs: three(15000) }), w.userId))!;
      expect((await outputLines(tx, run.id)).map((l) => l.priceIsManual).sort()).toEqual([false, false, true]);

      // The second line carries its typed price, the others the old back-filled HPP.
      const hpp = Number((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).computedHpp);
      const lines = await outputLines(tx, run.id);
      const typedIdx = lines.findIndex((l) => l.priceIsManual);
      const sent = lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }));
      expect(sent[typedIdx]!.unitPrice).toBe(15000);
      await editProductionRunInTx(tx, run.id, body(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1100 }],
        outputs: sent,
      }), w.userId);
      const after = await outputLines(tx, run.id);
      expect(after.filter((l) => l.priceIsManual)).toHaveLength(1);
      const newHpp = Number((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).computedHpp);
      expect(newHpp).not.toBe(hpp);
      for (const l of after.filter((x) => !x.priceIsManual)) expect(Number(l.unitPrice)).toBeCloseTo(newHpp, 2);
    });
  });

  it('refills a back-filled price when the HPP override changes on edit', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, body(w, { hppOverride: 10000 }), w.userId))!;
      const [first] = await outputLines(tx, run.id);
      expect(first!.priceIsManual).toBe(false);
      await editProductionRunInTx(tx, run.id, body(w, {
        hppOverride: 9000,
        outputs: [{ itemId: w.items.beras.id, quantity: 600, unitPrice: Number(first!.unitPrice) }],
      }), w.userId);
      const [line] = await outputLines(tx, run.id);
      expect(Number(line!.unitPrice)).toBe(9000);
      const mv = (await movementsOf(tx, run.id, { activeOnly: true })).find((m) => m.itemId === w.items.beras.id)!;
      expect(mv.unitCost).toBe(9000);
    });
  });

  it('matches lines in the deterministic (createdAt, id) order the GET returns', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, body(w, {
        outputs: [
          { itemId: w.items.beras.id, quantity: 200 },
          { itemId: w.items.beras.id, quantity: 200, unitPrice: 15000 },
          { itemId: w.items.beras.id, quantity: 200 },
        ],
      }), w.userId))!;
      const lines = await outputLines(tx, run.id);
      const sent = lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }));
      await editProductionRunInTx(tx, run.id, body(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1100 }],
        outputs: sent,
      }), w.userId);
      const after = await outputLines(tx, run.id);
      expect(after.filter((l) => l.priceIsManual).map((l) => Number(l.unitPrice))).toEqual([15000]);
    });
  });

  it('GET / lists the lines in the same (createdAt, id) order as the edit match', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, body(w, {
        outputs: [
          { itemId: w.items.beras.id, quantity: 100 },
          { itemId: w.items.beras.id, quantity: 100 },
          { itemId: w.items.beras.id, quantity: 100 },
        ],
      }), w.userId))!;
      const user = await createCapUser(tx, [], { perms: { inventory: 'view' } });
      const res = await callRoute(productionRunsRouter, 'get', '/', { ...user, query: { search: run.runNumber } });
      const listed = res.body.data.find((r: { id: string }) => r.id === run.id);
      const expected = (await outputLines(tx, run.id)).map((l) => l.id);
      expect(listed.items.filter((l: { lineType: string; isByProduct: boolean }) => l.lineType === 'Output' && !l.isByProduct)
        .map((l: { id: string }) => l.id)).toEqual(expected);
    });
  });

  it('migration backfill marks typed main output prices only', async () => {
    await inWorld(async (tx, w) => {
      const migrationsDir = join(__dirname, '../../../prisma/migrations');
      const folder = readdirSync(migrationsDir).find((n) => n.endsWith('_production_item_price_is_manual'));
      if (!folder) throw new Error('migration folder *_production_item_price_is_manual not found');
      const sql = readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8');
      const update = sql.slice(sql.indexOf('DO $$'));
      const fy = await tx.fiscalYear.findFirstOrThrow({ where: { startDate: new Date(`${YEAR}-01-01`) } });
      const mkRun = (n: string, hpp: number | null, override = false) => tx.productionRun.create({
        data: { runNumber: `IT-6.11B-${n}-${Date.now()}`, date: new Date(`${YEAR}-03-05`), fiscalYear: { connect: { id: fy.id } }, createdBy: { connect: { id: w.userId } }, computedHpp: hpp, hppManualOverride: override },
      });
      const mkLine = (runId: string, over: Record<string, unknown>) => tx.productionRunItem.create({
        data: { productionRunId: runId, itemId: w.items.beras.id, lineType: 'Output', quantity: 1, ...over } as never,
      });
      const r1 = await mkRun('a', 10166.6667);
      const r2 = await mkRun('b', null);
      const r3 = await mkRun('c', 10000, true);
      const backfilled = await mkLine(r1.id, { unitPrice: 10166.67 });
      const unpriced = await mkLine(r1.id, { unitPrice: null });
      const typed = await mkLine(r1.id, { unitPrice: 12000 });
      const byProduct = await mkLine(r1.id, { lineType: 'ByProduct', isByProduct: true, unitPrice: 20 });
      const noHpp = await mkLine(r2.id, { unitPrice: 5000 });
      const overridden = await mkLine(r3.id, { unitPrice: 10000 });
      const overriddenTyped = await mkLine(r3.id, { unitPrice: 9000 });

      await tx.$executeRawUnsafe(update);
      const flag = async (id: string) => (await tx.productionRunItem.findUniqueOrThrow({ where: { id } })).priceIsManual;
      expect(await flag(backfilled.id)).toBe(false);
      expect(await flag(unpriced.id)).toBe(false);
      expect(await flag(typed.id)).toBe(true);
      expect(await flag(byProduct.id)).toBe(false);
      expect(await flag(noHpp.id)).toBe(true);
      expect(await flag(overridden.id)).toBe(false);
      expect(await flag(overriddenTyped.id)).toBe(true);
    });
  });
});
