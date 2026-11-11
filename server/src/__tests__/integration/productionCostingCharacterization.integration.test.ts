/**
 * Characterization of production costing and posting on the code as it is today (PR-6.1a).
 *
 * Pins what submitProductionRunInTx / editProductionRunInTx / cancelProductionRunInTx produce
 * for the PRD R1 fixture and its variants, so the refactors that follow (pure costing module,
 * posting module, journals through postJournal) can prove they change nothing. The pinned
 * numbers include today's rounding quirks: loaded HPP is 4 decimals while the movement
 * unit_cost column is 2, so the output movement value (600 x 10.166,6667 = 6.100.000,02) is not
 * qty x stored unit cost, and the 0,02 lands in COGS. A later PR that changes a number here
 * changes it on purpose, in its own diff.
 *
 * Fixture R1: GKP 1.000 kg @ 6.000, conversion 300/kg on input qty, bekatul 100 kg NRV 2.000,
 * beras 600 kg. Everything runs in a rollback transaction on fixtures made here, fiscal year 2101.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { submitProductionRunInTx, type SubmitProductionRunInput } from '../../services/productionRunSubmit';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import { cancelProductionRunInTx } from '../../services/productionRunCancel';
import {
  createProductionWorld,
  seedWorldStock,
  worldDate,
  journalLinesByRole,
  movementsOf,
  assertBalancesMatchAle,
  type ProductionWorld,
} from '../helpers/productionFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const YEAR = 2101;

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
        const world = await createProductionWorld(tx, YEAR);
        await fn(tx, world);
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

/** R1 body: 1.000 kg GKP -> 600 kg beras + 100 kg bekatul, conversion 300/kg of input. */
function r1Body(world: ProductionWorld, over: Partial<SubmitProductionRunInput> = {}): SubmitProductionRunInput {
  return {
    date: worldDate(world),
    warehouseId: world.warehouseA.id,
    inputs: [{ itemId: world.items.gkp.id, quantity: 1000 }],
    outputs: [
      { itemId: world.items.beras.id, quantity: 600 },
      { itemId: world.items.bekatul.id, quantity: 100, unitPrice: 2000, isByProduct: true },
    ],
    costs: [{ description: 'Konversi', costSide: 'InputSide', basis: 'InputQty', rate: 300 }],
    ...over,
  };
}

async function submit(tx: Tx, world: ProductionWorld, body: SubmitProductionRunInput) {
  const run = await submitProductionRunInTx(tx, body, world.userId);
  expect(run).not.toBeNull();
  return run!;
}

const itemState = async (tx: Tx, itemId: string) => {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  const stocks = await tx.inventoryStock.findMany({ where: { itemId } });
  return {
    currentStock: Number(item.currentStock),
    averageCost: Number(item.averageCost),
    warehouseSum: stocks.reduce((s, r) => s + Number(r.currentStock), 0),
  };
};

const runRow = (tx: Tx, runId: string) => tx.productionRun.findUniqueOrThrow({ where: { id: runId } });

const lineOf = async (tx: Tx, runId: string, itemId: string) => {
  const row = await tx.productionRunItem.findFirstOrThrow({ where: { productionRunId: runId, itemId } });
  return {
    lineType: row.lineType,
    quantity: Number(row.quantity),
    unitPrice: row.unitPrice == null ? null : Number(row.unitPrice),
    batchUnitCost: row.batchUnitCost == null ? null : Number(row.batchUnitCost),
  };
};

d('production costing characterization - PRD R1 fixture', () => {
  it('pins HPP, movements, journal, averages and persisted lines', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w));

      const stored = await runRow(tx, run.id);
      expect(Number(stored.computedHpp)).toBe(10166.6667);
      expect(stored.hppManualOverride).toBe(false);
      expect(Number(stored.totalMaterialCost)).toBe(6_000_000);
      expect(Number(stored.totalCostInputSide)).toBe(300_000);
      expect(Number(stored.totalCostOutputSide)).toBe(0);
      expect(Number(stored.totalByproductValue)).toBe(200_000);
      expect(Number(stored.yieldPct)).toBeCloseTo(60, 6);

      // Movements: the material goes out at its average, the output value is qty x HPP(4 dp)
      // although unit_cost keeps 2 decimals.
      const moves = await movementsOf(tx, run.id);
      const gkp = moves.find((m) => m.itemId === w.items.gkp.id)!;
      const beras = moves.find((m) => m.itemId === w.items.beras.id)!;
      const bekatul = moves.find((m) => m.itemId === w.items.bekatul.id)!;
      expect(gkp).toMatchObject({ type: 'Out', quantity: 1000, unitCost: 6000, totalValue: 6_000_000 });
      expect(beras).toMatchObject({ type: 'In', quantity: 600, unitCost: 10166.67, totalValue: 6_100_000.02, unitCostLoaded: 10166.6667 });
      expect(600 * beras.unitCost).not.toBe(beras.totalValue);
      expect(bekatul).toMatchObject({ type: 'In', quantity: 100, unitCost: 2000, totalValue: 200_000, unitCostLoaded: 2000 });

      // Journal: output 6.300.000,02 against input 6.000.000; conversion 300.000, the 0,02 rest to COGS.
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.status).toBe('Submitted');
      expect(jv.lines.inventory).toEqual({ debit: 6_300_000.02, credit: 6_000_000 });
      expect(jv.lines.conversion).toEqual({ debit: 0, credit: 300_000 });
      expect(jv.lines.cogs).toEqual({ debit: 0, credit: 0.02 });

      // Item totals, per-warehouse rows and averages.
      expect(await itemState(tx, w.items.gkp.id)).toEqual({ currentStock: 1000, averageCost: 6000, warehouseSum: 1000 });
      expect(await itemState(tx, w.items.beras.id)).toEqual({ currentStock: 600, averageCost: 10166.67, warehouseSum: 600 });
      expect(await itemState(tx, w.items.bekatul.id)).toEqual({ currentStock: 100, averageCost: 2000, warehouseSum: 100 });

      // Persisted lines: the main output carries the back-filled HPP at 2 dp.
      expect(await lineOf(tx, run.id, w.items.gkp.id)).toMatchObject({ lineType: 'Input', quantity: 1000, unitPrice: null, batchUnitCost: null });
      expect(await lineOf(tx, run.id, w.items.beras.id)).toMatchObject({ lineType: 'Output', quantity: 600, unitPrice: 10166.67 });
      expect(await lineOf(tx, run.id, w.items.bekatul.id)).toMatchObject({ lineType: 'ByProduct', quantity: 100, unitPrice: 2000 });

      const cost = await tx.productionRunCost.findFirstOrThrow({ where: { productionRunId: run.id } });
      expect(Number(cost.qtyBasis)).toBe(1000);
      expect(Number(cost.totalAmount)).toBe(300_000);

      await assertBalancesMatchAle(tx, w);
    });
  });

  it('keeps the movement and journal sequence: -R1 on edit, original journal cancelled', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w));
      const edited = await editProductionRunInTx(
        tx,
        run.id,
        r1Body(w, {
          inputs: [{ itemId: w.items.gkp.id, quantity: 800 }],
          outputs: [
            { itemId: w.items.beras.id, quantity: 500 },
            { itemId: w.items.bekatul.id, quantity: 80, unitPrice: 2000, isByProduct: true },
          ],
        }),
        w.userId,
      );
      expect(edited!.runNumber).toBe(run.runNumber);

      // Material 4.800.000 + conversion 240.000 - by-product 160.000 = 4.880.000 over 500 kg = 9.760 exactly.
      const stored = await runRow(tx, run.id);
      expect(Number(stored.computedHpp)).toBe(9760);
      expect(Number(stored.totalCostInputSide)).toBe(240_000);

      const original = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(original.status).toBe('Cancelled');
      const revision = await journalLinesByRole(tx, w, `JV-${run.runNumber}-R1`);
      expect(revision.status).toBe('Submitted');
      expect(revision.lines.inventory).toEqual({ debit: 5_040_000, credit: 4_800_000 });
      expect(revision.lines.conversion).toEqual({ debit: 0, credit: 240_000 });
      expect(revision.lines.cogs).toBeUndefined();

      const moves = await movementsOf(tx, run.id);
      expect(moves.filter((m) => m.isCancelled)).toHaveLength(3);
      expect(await movementsOf(tx, run.id, { activeOnly: true })).toHaveLength(3);
      expect(await itemState(tx, w.items.gkp.id)).toEqual({ currentStock: 1200, averageCost: 6000, warehouseSum: 1200 });
      expect(await itemState(tx, w.items.beras.id)).toEqual({ currentStock: 500, averageCost: 9760, warehouseSum: 500 });
      expect(await itemState(tx, w.items.bekatul.id)).toEqual({ currentStock: 80, averageCost: 2000, warehouseSum: 80 });
      expect(await lineOf(tx, run.id, w.items.beras.id)).toMatchObject({ unitPrice: 9760 });

      await assertBalancesMatchAle(tx, w);
    });
  });

  it('cancel restores stock and averages and voids the journal', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w));
      await cancelProductionRunInTx(tx, run.id, { userId: w.userId, reason: 'IT characterization' });

      expect((await runRow(tx, run.id)).isCancelled).toBe(true);
      expect((await journalLinesByRole(tx, w, `JV-${run.runNumber}`)).status).toBe('Cancelled');
      expect((await movementsOf(tx, run.id)).every((m) => m.isCancelled)).toBe(true);
      expect(await itemState(tx, w.items.gkp.id)).toEqual({ currentStock: 2000, averageCost: 6000, warehouseSum: 2000 });
      expect((await itemState(tx, w.items.beras.id)).currentStock).toBe(0);
      expect((await itemState(tx, w.items.beras.id)).warehouseSum).toBe(0);
      await assertBalancesMatchAle(tx, w);
    });
  });
});

d('production costing characterization - variants', () => {
  it('HPP override is taken verbatim and the shortfall is a COGS debit', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w, { hppOverride: 9000 }));

      const stored = await runRow(tx, run.id);
      expect(Number(stored.computedHpp)).toBe(9000);
      expect(stored.hppManualOverride).toBe(true);
      const beras = (await movementsOf(tx, run.id)).find((m) => m.itemId === w.items.beras.id)!;
      expect(beras).toMatchObject({ unitCost: 9000, totalValue: 5_400_000, unitCostLoaded: 9000 });

      // Output 5.400.000 + 200.000 against 6.000.000 input: a 400.000 loss, no conversion credit.
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 5_600_000, credit: 6_000_000 });
      expect(jv.lines.cogs).toEqual({ debit: 400_000, credit: 0 });
      expect(jv.lines.conversion).toBeUndefined();
      expect(await lineOf(tx, run.id, w.items.beras.id)).toMatchObject({ unitPrice: 9000 });
      expect((await itemState(tx, w.items.beras.id)).averageCost).toBe(9000);
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('an explicit main output price wins over the computed HPP; unit_cost_loaded keeps the HPP', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w, {
        outputs: [
          { itemId: w.items.beras.id, quantity: 600, unitPrice: 11_000 },
          { itemId: w.items.bekatul.id, quantity: 100, unitPrice: 2000, isByProduct: true },
        ],
      }));

      expect(Number((await runRow(tx, run.id)).computedHpp)).toBe(10166.6667);
      const beras = (await movementsOf(tx, run.id)).find((m) => m.itemId === w.items.beras.id)!;
      expect(beras).toMatchObject({ unitCost: 11_000, totalValue: 6_600_000, unitCostLoaded: 10166.6667 });

      // Gain 800.000: the conversion cost (300.000) first, the other 500.000 to COGS.
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 6_800_000, credit: 6_000_000 });
      expect(jv.lines.conversion).toEqual({ debit: 0, credit: 300_000 });
      expect(jv.lines.cogs).toEqual({ debit: 0, credit: 500_000 });
      expect(await lineOf(tx, run.id, w.items.beras.id)).toMatchObject({ unitPrice: 11_000 });
      expect((await itemState(tx, w.items.beras.id)).averageCost).toBe(11_000);
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('by-product NRV above total cost clamps the HPP to 0 and leaves the main output unvalued', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 500, 1000);
      const run = await submit(tx, w, {
        date: worldDate(w),
        warehouseId: w.warehouseA.id,
        inputs: [{ itemId: w.items.gkp.id, quantity: 100 }],
        outputs: [
          { itemId: w.items.beras.id, quantity: 60 },
          { itemId: w.items.bekatul.id, quantity: 100, unitPrice: 2000, isByProduct: true },
        ],
      });

      const stored = await runRow(tx, run.id);
      expect(Number(stored.computedHpp)).toBe(0);
      expect(stored.hppManualOverride).toBe(false);
      const beras = (await movementsOf(tx, run.id)).find((m) => m.itemId === w.items.beras.id)!;
      expect(beras).toMatchObject({ unitCost: 0, totalValue: 0, unitCostLoaded: 0 });
      // No price is persisted for a zero HPP and the average is not touched by an unvalued receipt.
      expect(await lineOf(tx, run.id, w.items.beras.id)).toMatchObject({ unitPrice: null });
      expect(await itemState(tx, w.items.beras.id)).toEqual({ currentStock: 60, averageCost: 0, warehouseSum: 60 });

      // Only the by-product (200.000) is debited against 100.000 of input: 100.000 gain to COGS.
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 200_000, credit: 100_000 });
      expect(jv.lines.cogs).toEqual({ debit: 0, credit: 100_000 });
      expect(jv.lines.conversion).toBeUndefined();
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('Fixed and OutputQty bases: Fixed rate is the total, OutputQty multiplies main output qty', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w, {
        costs: [
          { description: 'Tetap', costSide: 'InputSide', basis: 'Fixed', rate: 500_000 },
          { description: 'Per hasil', costSide: 'OutputSide', basis: 'OutputQty', rate: 100 },
        ],
      }));

      // 6.000.000 + 500.000 + 60.000 - 200.000 = 6.360.000 over 600 kg = 10.600.
      const stored = await runRow(tx, run.id);
      expect(Number(stored.computedHpp)).toBe(10_600);
      expect(Number(stored.totalCostInputSide)).toBe(500_000);
      expect(Number(stored.totalCostOutputSide)).toBe(60_000);
      const costs = await tx.productionRunCost.findMany({ where: { productionRunId: run.id }, orderBy: { description: 'asc' } });
      expect(costs.map((c) => [c.basis, Number(c.qtyBasis), Number(c.totalAmount)])).toEqual([
        ['OutputQty', 600, 60_000],
        ['Fixed', 1, 500_000],
      ]);

      // Output 6.360.000 + 200.000 against 6.000.000: gain 560.000 = the conversion cost exactly.
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 6_560_000, credit: 6_000_000 });
      expect(jv.lines.conversion).toEqual({ debit: 0, credit: 560_000 });
      expect(jv.lines.cogs).toBeUndefined();
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('counts a Pcs input in the InputQty basis today (no mass conversion yet)', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      await seedWorldStock(tx, w, 'karung', 50, 1000);
      const run = await submit(tx, w, r1Body(w, {
        inputs: [
          { itemId: w.items.gkp.id, quantity: 1000 },
          { itemId: w.items.karung.id, quantity: 10 },
        ],
      }));

      // 1.010 "units" of input: conversion 303.000; material 6.000.000 + 10.000.
      const stored = await runRow(tx, run.id);
      expect(Number(stored.totalCostInputSide)).toBe(303_000);
      expect(Number(stored.totalMaterialCost)).toBe(6_010_000);
      const cost = await tx.productionRunCost.findFirstOrThrow({ where: { productionRunId: run.id } });
      expect(Number(cost.qtyBasis)).toBe(1010);
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('a picked batch locks its cost: batchUnitCost wins over the item average', async () => {
    await inWorld(async (tx, w) => {
      const { movementId } = await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = await submit(tx, w, r1Body(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1000, sourceMovementId: movementId, batchUnitCost: 5000 }],
      }));

      const gkp = (await movementsOf(tx, run.id)).find((m) => m.itemId === w.items.gkp.id)!;
      expect(gkp).toMatchObject({ unitCost: 5000, totalValue: 5_000_000 });
      expect(await lineOf(tx, run.id, w.items.gkp.id)).toMatchObject({ batchUnitCost: 5000 });
      // 5.000.000 + 300.000 - 200.000 = 5.100.000 over 600 kg = 8.500; the item average is unchanged.
      expect(Number((await runRow(tx, run.id)).computedHpp)).toBe(8500);
      expect((await itemState(tx, w.items.gkp.id)).averageCost).toBe(6000);
      await assertBalancesMatchAle(tx, w);
    });
  });

  it('rejects an input larger than the item total unless negative stock is allowed', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 500, 6000);
      await expect(submitProductionRunInTx(tx, r1Body(w), w.userId)).rejects.toThrow(/tidak cukup/);
    });
  });
});
