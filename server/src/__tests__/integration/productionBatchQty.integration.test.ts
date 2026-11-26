/**
 * Integration test: a picked batch traces the quantity and never values it (E6-R3, plan step 6
 * PR-6.9), on fixtures made here inside a rollback transaction (helpers/productionFixture.ts), fiscal
 * year 2118:
 * - the PRD acceptance: GKP 10.000 kg worth 60.000.000 (average 6.000) with a batch received @7.000;
 *   5.000 kg taken from the batch with the client's batchUnitCost 7.000 or 0 credits inventory
 *   30.000.000 on a movement at 6.000 and leaves 5.000 kg worth 30.000.000; the line stores 6.000
 *   as its batch cost;
 * - a batch with 3.000 kg left: asking 5.000 is refused, so are two lines of 2.000 on it (summed),
 *   and the picker lists the same 3.000;
 * - an edit of a run that used up the rest of a batch passes with its own quantity (its consumption
 *   is reversed before the check), and is refused above it;
 * - a batch held in another warehouse than the production warehouse is refused (owner decision #10).
 * Each scenario ends with assertLedgerInvariant (warehouses included) and stored balances = ALE.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { submitProductionRunInTx, type SubmitProductionRunInput } from '../../services/productionRunSubmit';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import {
  listBatchAvailability,
  PRODUCTION_BATCH_QTY_INSUFFICIENT,
  PRODUCTION_BATCH_WAREHOUSE,
} from '../../services/inventory/batchAvailability';
import {
  createProductionWorld,
  seedWorldStock,
  worldDate,
  journalLinesByRole,
  assertBalancesMatchAle,
  type ProductionWorld,
} from '../helpers/productionFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const YEAR = 2118;

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
        await assertLedgerInvariant(tx, Object.values(world.items).map((i) => i.id), { warehouses: true });
        await assertBalancesMatchAle(tx, world);
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

let savepointSeq = 0;

/** The refusal `fn` throws, inside a savepoint so whatever it wrote first is rolled back as a route's transaction would be. */
async function refusalOf(tx: Tx, fn: () => Promise<unknown>): Promise<Error & { code?: string }> {
  const name = `pbq_${++savepointSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    await fn();
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    return e as Error & { code?: string };
  }
  throw new Error('expected a refusal');
}

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);

/** GKP 10.000 kg at warehouse A worth 60.000.000: 5.000 @5.000, then the batch 5.000 @7.000. */
async function seedAcceptanceStock(tx: Tx, w: ProductionWorld) {
  await seedWorldStock(tx, w, 'gkp', 5_000, 5_000);
  const { movementId } = await seedWorldStock(tx, w, 'gkp', 5_000, 7_000);
  return movementId;
}

function runBody(w: ProductionWorld, inputs: SubmitProductionRunInput['inputs'], beras: number): SubmitProductionRunInput {
  return { date: worldDate(w), warehouseId: w.warehouseA.id, inputs, outputs: [{ itemId: w.items.beras.id, quantity: beras }] };
}

async function submit(tx: Tx, w: ProductionWorld, body: SubmitProductionRunInput) {
  const run = await submitProductionRunInTx(tx, body, w.userId);
  expect(run).not.toBeNull();
  return run!;
}

async function bookOf(tx: Tx, itemId: string) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  return { stock: item.currentStock.toFixed(3), value: item.stockValue.toFixed(2), average: item.averageCost.toFixed(6) };
}

async function availableOf(tx: Tx, w: ProductionWorld, batchId: string) {
  const listed = await listBatchAvailability(tx, w.items.gkp.id, w.warehouseA.id);
  return listed!.batches.find((b) => b.id === batchId)!.available.toFixed(3);
}

d('production batch remainder (PR-6.9)', () => {
  for (const batchUnitCost of [7_000, 0]) {
    it(`5.000 kg from a batch @7.000 at an average of 6.000 (client batchUnitCost ${batchUnitCost}): credited 30.000.000 at 6.000`, async () => {
      await inWorld(async (tx, w) => {
        const batch = await seedAcceptanceStock(tx, w);
        expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '10000.000', value: '60000000.00', average: '6000.000000' });

        const run = await submit(tx, w, runBody(w, [{ itemId: w.items.gkp.id, quantity: 5_000, sourceMovementId: batch, batchUnitCost }], 3_000));

        const out = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: 'ProductionRun', referenceId: run.id, itemId: w.items.gkp.id } });
        expect({ type: out.movementType, value: money(out.valueDelta.toString()), unitCost: out.unitCost.toFixed(6), source: out.sourceMovementId })
          .toEqual({ type: 'Out', value: '-30000000.00', unitCost: '6000.000000', source: batch });
        expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '5000.000', value: '30000000.00', average: '6000.000000' });
        const line = await tx.productionRunItem.findFirstOrThrow({ where: { productionRunId: run.id, itemId: w.items.gkp.id } });
        expect({ unitPrice: Number(line.unitPrice), batchUnitCost: Number(line.batchUnitCost), source: line.sourceMovementId })
          .toEqual({ unitPrice: 6_000, batchUnitCost: 6_000, source: batch });
        // One inventory account: GKP out 30.000.000, rice in 30.000.000.
        const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
        expect(jv.lines.inventory).toEqual({ debit: 30_000_000, credit: 30_000_000 });
        expect(await bookOf(tx, w.items.beras.id)).toEqual({ stock: '3000.000', value: '30000000.00', average: '10000.000000' });
        expect(await availableOf(tx, w, batch)).toBe('0.000');
      });
    });
  }

  it('a batch with 3.000 kg left: 5.000 is refused, so are two lines of 2.000; 3.000 passes', async () => {
    await inWorld(async (tx, w) => {
      const batch = await seedAcceptanceStock(tx, w);
      await submit(tx, w, runBody(w, [{ itemId: w.items.gkp.id, quantity: 2_000, sourceMovementId: batch }], 1_200));
      expect(await availableOf(tx, w, batch)).toBe('3000.000');
      const before = await bookOf(tx, w.items.gkp.id);

      const tooMuch = await refusalOf(tx, () => submit(tx, w, runBody(w, [{ itemId: w.items.gkp.id, quantity: 5_000, sourceMovementId: batch }], 3_000)));
      expect(tooMuch.code).toBe(PRODUCTION_BATCH_QTY_INSUFFICIENT);
      expect(tooMuch.message).toMatch(/^Sisa batch \S+ \(input ke-1\) tidak cukup: tersedia 3\.000 Kg, diminta 5\.000 Kg\.$/);

      const twoLines = await refusalOf(tx, () => submit(tx, w, runBody(w, [
        { itemId: w.items.gkp.id, quantity: 2_000, sourceMovementId: batch },
        { itemId: w.items.gkp.id, quantity: 2_000, sourceMovementId: batch },
      ], 2_400)));
      expect(twoLines.code).toBe(PRODUCTION_BATCH_QTY_INSUFFICIENT);
      expect(twoLines.message).toMatch(/tersedia 3\.000 Kg, diminta 4\.000 Kg\.$/);
      expect(await bookOf(tx, w.items.gkp.id)).toEqual(before);

      // The rest of the stock without a batch is not limited by the batch.
      await submit(tx, w, runBody(w, [
        { itemId: w.items.gkp.id, quantity: 3_000, sourceMovementId: batch },
        { itemId: w.items.gkp.id, quantity: 1_000 },
      ], 2_400));
      expect(await availableOf(tx, w, batch)).toBe('0.000');
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '4000.000', value: '24000000.00', average: '6000.000000' });
    });
  });

  it('an edit of a run that used up the batch passes with its own quantity and is refused above it', async () => {
    await inWorld(async (tx, w) => {
      const batch = await seedAcceptanceStock(tx, w);
      await submit(tx, w, runBody(w, [{ itemId: w.items.gkp.id, quantity: 2_000, sourceMovementId: batch }], 1_200));
      const body = runBody(w, [{ itemId: w.items.gkp.id, quantity: 3_000, sourceMovementId: batch }], 1_800);
      const run = await submit(tx, w, body);
      expect(await availableOf(tx, w, batch)).toBe('0.000');

      await editProductionRunInTx(tx, run.id, { ...body, notes: 'IT 6.9 edit' }, w.userId);
      const active = await tx.stockMovement.findMany({
        where: { referenceType: 'ProductionRun', referenceId: run.id, itemId: w.items.gkp.id, isCancelled: false },
      });
      expect(active.map((m) => [m.quantity.toFixed(3), m.sourceMovementId])).toEqual([['3000.000', batch]]);
      expect(await availableOf(tx, w, batch)).toBe('0.000');

      const above = await refusalOf(tx, () => editProductionRunInTx(tx, run.id, {
        ...body, inputs: [{ itemId: w.items.gkp.id, quantity: 3_500, sourceMovementId: batch }],
      }, w.userId));
      expect(above.code).toBe(PRODUCTION_BATCH_QTY_INSUFFICIENT);
      expect(above.message).toMatch(/tersedia 3\.000 Kg, diminta 3\.500 Kg\.$/);
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '5000.000', value: '30000000.00', average: '6000.000000' });
    });
  });

  it('a batch held in warehouse B cannot feed a run at warehouse A', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1_000, 6_000);
      const { movementId: atB } = await seedWorldStock(tx, w, 'gkp', 1_000, 6_000, 'B');
      const refused = await refusalOf(tx, () => submit(tx, w, runBody(w, [{ itemId: w.items.gkp.id, quantity: 500, sourceMovementId: atB }], 300)));
      expect(refused.code).toBe(PRODUCTION_BATCH_WAREHOUSE);
      expect(refused.message).toMatch(/^Batch \S+ \(input ke-1\) tidak berada di gudang produksi IT-6\.1a gudang A\. Pilih batch dari gudang produksi\.$/);
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '2000.000', value: '12000000.00', average: '6000.000000' });
    });
  });
});
