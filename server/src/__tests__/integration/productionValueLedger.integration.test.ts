/**
 * Integration test: production through the inventory value ledger (E3-R6, E3-R7, the cost part of
 * E6-R3; plan step 6 PR-6.4e), on fixtures made here inside a rollback transaction
 * (helpers/productionFixture.ts), fiscal year 2112:
 * - a by-product at NRV 0 dilutes the average: sekam 500 kg worth 100.000 plus 1.000 kg of output
 *   at 0 -> average 66,666667; a sale of the 1.500 kg (delivery order + invoice) posts COGS 100.000
 *   and leaves stock_value 0 (before, the unvalued receipt skipped the average: 1.500 x 200);
 * - a picked batch @7.000 while the average is 6.000: the input is credited at its ledger value
 *   (6.000.000), the batch stays a back-link; the cancel takes every row
 *   back at its own value;
 * - two input lines of one item, the second taking the rest of the book: the credits are the
 *   ledger values (33.333,33 + 66.666,67, not 20.000 x 3,333333 = 66.666,66), and the output is
 *   debited exactly that total;
 * - the NRV 0 by-product partly sold (300 of 1.500 kg at the diluted average): cancelling or editing
 *   the run is refused with REVERSAL_NEEDS_TRUE_UP and nothing moves (taken back, the 0-value row
 *   would leave 200 kg worth 80.000 instead of 40.000) until the true-up of PR-6.5a / PR-6.12.
 * In every scenario the inventory amount of the run's journal equals Σ value_delta of its rows
 * (book = GL), and each ends with assertLedgerInvariant (warehouses included).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import { seedStock } from '../helpers/inventoryFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { submitProductionRunInTx, type SubmitProductionRunInput } from '../../services/productionRunSubmit';
import { cancelProductionRunInTx } from '../../services/productionRunCancel';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import { REVERSAL_NEEDS_TRUE_UP } from '../../services/inventory/inventoryLedger';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
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

const YEAR = 2112;

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

interface World extends ProductionWorld {
  sekam: { id: string; name: string };
}

async function inWorld(fn: (tx: Tx, world: World) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      systemAccounts.invalidateCache();
      try {
        const base = await createProductionWorld(tx, YEAR);
        const sekam = await tx.inventoryItem.create({
          data: { code: `IT-64E-SEKAM-${Date.now()}`, name: 'IT-6.4e SEKAM', unit: 'Kg', isActive: true, accountId: base.accounts.inventory.id },
        });
        const world = { ...base, sekam };
        await fn(tx, world);
        await assertLedgerInvariant(tx, [...Object.values(world.items).map((i) => i.id), sekam.id], { warehouses: true });
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

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);

let savepointSeq = 0;

/** The refusal `fn` throws, inside a savepoint so whatever it wrote before the refusal is rolled back as a route's transaction would be. */
async function refusalOf(tx: Tx, fn: () => Promise<unknown>): Promise<Error & { code?: string; status?: number }> {
  const name = `pvl_${++savepointSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    await fn();
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    return e as Error & { code?: string; status?: number };
  }
  throw new Error('expected a refusal');
}

/** `qty` at `avg` into warehouse A (seedStock), for an item outside the world's set or an avg with more decimals. */
function seedAt(tx: Tx, w: World, itemId: string, qty: number, avg: Decimal.Value) {
  return seedStock(tx, { itemId, warehouseId: w.warehouseA.id, qty, avg, date: worldDate(w, '01-02'), userId: w.userId });
}

function runBody(w: World, over: Partial<SubmitProductionRunInput>): SubmitProductionRunInput {
  return { date: worldDate(w), warehouseId: w.warehouseA.id, inputs: [], outputs: [], ...over };
}

async function submit(tx: Tx, w: World, body: SubmitProductionRunInput) {
  const run = await submitProductionRunInTx(tx, body, w.userId);
  expect(run).not.toBeNull();
  return run!;
}

/** The item's book: stock, stock_value and average as fixed strings. */
async function bookOf(tx: Tx, itemId: string) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  return { stock: item.currentStock.toFixed(3), value: item.stockValue.toFixed(2), average: item.averageCost.toFixed(6) };
}

/** The run's rows in posting order (movement number), with their signed value. */
async function rowsOf(tx: Tx, runId: string) {
  const rows = await tx.stockMovement.findMany({
    where: { referenceType: 'ProductionRun', referenceId: runId },
    orderBy: { movementNumber: 'asc' },
  });
  return rows.map((m) => ({
    itemId: m.itemId,
    type: m.movementType,
    quantity: m.quantity.toFixed(3),
    valueDelta: money(m.valueDelta.toString()),
    unitCost: m.unitCost.toFixed(6),
    sourceMovementId: m.sourceMovementId,
    isCancelled: m.isCancelled,
  }));
}

/** Book = GL for the run: the inventory amount of its journal (DR − CR) is Σ value_delta of its active rows. */
async function expectJournalMatchesRows(tx: Tx, w: World, runId: string, entryNumber: string) {
  const sum = await tx.stockMovement.aggregate({
    where: { referenceType: 'ProductionRun', referenceId: runId, isCancelled: false },
    _sum: { valueDelta: true },
  });
  const { lines } = await journalLinesByRole(tx, w, entryNumber);
  const inventory = lines.inventory ?? { debit: 0, credit: 0 };
  expect(money(new Decimal(inventory.debit).minus(inventory.credit))).toBe(money(sum._sum.valueDelta?.toString() ?? 0));
}

d('production on the value ledger (PR-6.4e)', () => {
  it('a by-product at NRV 0 dilutes the average; selling all of it posts COGS 100.000 and empties the book', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1_000, 6_000);
      await seedAt(tx, w, w.sekam.id, 500, 200);
      expect(await bookOf(tx, w.sekam.id)).toEqual({ stock: '500.000', value: '100000.00', average: '200.000000' });

      const run = await submit(tx, w, runBody(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1_000 }],
        outputs: [
          { itemId: w.items.beras.id, quantity: 600 },
          { itemId: w.sekam.id, quantity: 1_000, unitPrice: 0, isByProduct: true },
        ],
      }));

      // 100.000 over 1.500 kg: the unvalued kilos count in the average.
      expect(await bookOf(tx, w.sekam.id)).toEqual({ stock: '1500.000', value: '100000.00', average: '66.666667' });
      const sekamIn = (await rowsOf(tx, run.id)).find((r) => r.itemId === w.sekam.id)!;
      expect(sekamIn).toMatchObject({ type: 'In', quantity: '1000.000', valueDelta: '0.00', unitCost: '0.000000' });
      expect(await bookOf(tx, w.items.beras.id)).toEqual({ stock: '600.000', value: '6000000.00', average: '10000.000000' });
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 6_000_000, credit: 6_000_000 });
      expect(jv.lines.cogs).toBeUndefined();
      await expectJournalMatchesRows(tx, w, run.id, `JV-${run.runNumber}`);

      const customer = await tx.party.create({ data: { name: `IT-6.4e Customer ${Date.now()}`, partyType: 'Customer', isActive: true } });
      const day = worldDate(w, '03-20');
      const doc = await submitDeliveryOrderInTx(tx, {
        date: day,
        partyId: customer.id,
        items: [{ inventoryItemId: w.sekam.id, warehouseId: w.warehouseA.id, itemName: w.sekam.name, quantity: 1_500, unit: 'Kg' }],
      }, w.userId);
      const out = await tx.stockMovement.findUniqueOrThrow({ where: { id: doc.items[0]!.stockMovementId! } });
      expect(money(out.valueDelta.toString())).toBe('-100000.00');
      expect(await bookOf(tx, w.sekam.id)).toEqual({ stock: '0.000', value: '0.00', average: '66.666667' });

      const invoice = await submitSalesInvoiceInTx(tx, {
        date: day,
        partyId: customer.id,
        items: doc.items.map((line) => ({
          itemName: w.sekam.name, itemType: 'product' as const, inventoryItemId: w.sekam.id, deliveryOrderItemId: line.id,
          quantity: Number(line.quantity), unit: 'Kg', rate: 300,
        })),
      }, w.userId);
      const cogs = await journalLinesByRole(tx, w, `JV-COGS-${invoice.invoiceNumber}`);
      expect(cogs.lines.cogs).toEqual({ debit: 100_000, credit: 0 });
      expect(cogs.lines.inventory).toEqual({ debit: 0, credit: 100_000 });
    });
  });

  it('a picked batch @7.000 at an average of 6.000: credited at the ledger value; the cancel takes it back exactly', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1_000, 5_000);
      const { movementId: batch } = await seedWorldStock(tx, w, 'gkp', 1_000, 7_000);
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '2000.000', value: '12000000.00', average: '6000.000000' });

      const run = await submit(tx, w, runBody(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1_000, sourceMovementId: batch, batchUnitCost: 7_000 }],
        outputs: [
          { itemId: w.items.beras.id, quantity: 600 },
          { itemId: w.items.bekatul.id, quantity: 100, unitPrice: 2_000, isByProduct: true },
        ],
        costs: [{ description: 'Konversi', costSide: 'InputSide', basis: 'InputQty', rate: 300 }],
      }));

      const gkpOut = (await rowsOf(tx, run.id)).find((r) => r.itemId === w.items.gkp.id)!;
      expect(gkpOut).toMatchObject({ type: 'Out', valueDelta: '-6000000.00', unitCost: '6000.000000', sourceMovementId: batch });
      const line = await tx.productionRunItem.findFirstOrThrow({ where: { productionRunId: run.id, itemId: w.items.gkp.id } });
      // The batch cost column carries the ledger cost the input went out at (PR-6.9).
      expect(Number(line.batchUnitCost)).toBe(6_000);
      // The line's unit_price is the ledger cost the PDF and detail drawer show.
      expect(Number(line.unitPrice)).toBe(6_000);
      const stored = await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } });
      // (6.000.000 + 300.000 − 200.000) / 600, not (7.000.000 + 300.000 − 200.000) / 600.
      expect(Number(stored.computedHpp)).toBe(10166.666667);
      expect(Number(stored.totalMaterialCost)).toBe(6_000_000);
      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 6_300_000, credit: 6_000_000 });
      expect(jv.lines.conversion).toEqual({ debit: 0, credit: 300_000 });
      expect(jv.lines.cogs).toBeUndefined();
      await expectJournalMatchesRows(tx, w, run.id, `JV-${run.runNumber}`);
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '1000.000', value: '6000000.00', average: '6000.000000' });

      await cancelProductionRunInTx(tx, run.id, { userId: w.userId, reason: 'IT 6.4e batal' });
      expect((await rowsOf(tx, run.id)).every((r) => r.isCancelled)).toBe(true);
      expect((await journalLinesByRole(tx, w, `JV-${run.runNumber}`)).status).toBe('Cancelled');
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '2000.000', value: '12000000.00', average: '6000.000000' });
      expect(await bookOf(tx, w.items.beras.id)).toMatchObject({ stock: '0.000', value: '0.00' });
      expect(await bookOf(tx, w.items.bekatul.id)).toMatchObject({ stock: '0.000', value: '0.00' });
    });
  });

  it('two input lines of one item: the second takes the rest of the book, the output is debited the credits', async () => {
    await inWorld(async (tx, w) => {
      // 30.000 kg worth 100.000,00 (average 3,333333).
      await seedAt(tx, w, w.items.gkp.id, 10_000, '3.33');
      await seedAt(tx, w, w.items.gkp.id, 20_000, '3.335');
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '30000.000', value: '100000.00', average: '3.333333' });

      const run = await submit(tx, w, runBody(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 10_000 }, { itemId: w.items.gkp.id, quantity: 20_000 }],
        outputs: [{ itemId: w.items.beras.id, quantity: 20_000 }],
      }));

      const rows = await rowsOf(tx, run.id);
      expect(rows.filter((r) => r.itemId === w.items.gkp.id).map((r) => [r.quantity, r.valueDelta])).toEqual([
        ['10000.000', '-33333.33'],
        ['20000.000', '-66666.67'],
      ]);
      expect(rows.find((r) => r.itemId === w.items.beras.id)).toMatchObject({ type: 'In', valueDelta: '100000.00', unitCost: '5.000000' });
      // At stock 0 the average keeps the last one derived (66.666,67 / 20.000 after the first line).
      expect(await bookOf(tx, w.items.gkp.id)).toEqual({ stock: '0.000', value: '0.00', average: '3.333334' });
      expect(Number((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).computedHpp)).toBe(5);

      const jv = await journalLinesByRole(tx, w, `JV-${run.runNumber}`);
      expect(jv.lines.inventory).toEqual({ debit: 100_000, credit: 100_000 });
      expect(jv.lines.cogs).toBeUndefined();
      expect(jv.lines.conversion).toBeUndefined();
      await expectJournalMatchesRows(tx, w, run.id, `JV-${run.runNumber}`);
    });
  });

  it('a partly sold NRV 0 by-product: cancel and edit are refused with REVERSAL_NEEDS_TRUE_UP and nothing moves', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1_000, 6_000);
      await seedAt(tx, w, w.sekam.id, 500, 200);
      const body = runBody(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 1_000 }],
        outputs: [
          { itemId: w.items.beras.id, quantity: 600 },
          { itemId: w.sekam.id, quantity: 1_000, unitPrice: 0, isByProduct: true },
        ],
      });
      const run = await submit(tx, w, body);
      expect(await bookOf(tx, w.sekam.id)).toEqual({ stock: '1500.000', value: '100000.00', average: '66.666667' });

      const customer = await tx.party.create({ data: { name: `IT-6.4e Customer ${Date.now()}`, partyType: 'Customer', isActive: true } });
      await submitDeliveryOrderInTx(tx, {
        date: worldDate(w, '03-20'),
        partyId: customer.id,
        items: [{ inventoryItemId: w.sekam.id, warehouseId: w.warehouseA.id, itemName: w.sekam.name, quantity: 300, unit: 'Kg' }],
      }, w.userId);
      // round(100.000 x 300 / 1.500) out; taken back, the 0-value row would leave 200 kg at 80.000 (average 400).
      const before = await bookOf(tx, w.sekam.id);
      expect(before).toEqual({ stock: '1200.000', value: '80000.00', average: '66.666667' });
      const rowsBefore = await rowsOf(tx, run.id);

      const cancel = await refusalOf(tx, () => cancelProductionRunInTx(tx, run.id, { userId: w.userId, reason: 'IT 6.4e batal' }));
      expect(cancel).toMatchObject({ code: REVERSAL_NEEDS_TRUE_UP, status: 409 });
      expect(cancel.message).toMatch(/^Pembatalan ditolak: 'IT-6\.4e SEKAM'/);

      const edit = await refusalOf(tx, () => editProductionRunInTx(tx, run.id, { ...body, notes: 'IT 6.4e edit' }, w.userId));
      expect(edit).toMatchObject({ code: REVERSAL_NEEDS_TRUE_UP, status: 409 });
      expect(edit.message).toMatch(/^Edit ditolak: 'IT-6\.4e SEKAM'/);

      expect(await bookOf(tx, w.sekam.id)).toEqual(before);
      expect(await rowsOf(tx, run.id)).toEqual(rowsBefore);
      expect((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).isCancelled).toBe(false);
      expect((await journalLinesByRole(tx, w, `JV-${run.runNumber}`)).status).not.toBe('Cancelled');
    });
  });
});
