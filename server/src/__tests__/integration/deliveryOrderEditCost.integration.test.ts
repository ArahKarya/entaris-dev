/**
 * Integration test: a delivery note edit keeps the cost its goods went out at (E3-R8, owner
 * decision #9, PR-6.5b), on fixtures made here inside a rollback transaction
 * (helpers/salesFlowFixture.ts). Each note ships 100 kg at 10.000 before 1.000 kg at 12.000 come in,
 * so the average moves away from the note's cost:
 * - a header edit through PATCH (driver name) leaves the movement, its cost and the book as they
 *   are; PATCH of a cancelled note and in a locked period is refused;
 * - a PUT with the same lines keeps the movement; a PUT that moves the note to another day in the
 *   month re-posts the row on that day at the same value;
 * - 100 -> 120 kg takes only the extra 20 out at the average now, 120 -> 80 hands 40 back at the
 *   row's own unit value, and the invoice COGS is the line's movement value; GL = book;
 * - a removed line is reversed at its own value and a new line in another warehouse is posted at
 *   the average now, while the unchanged line keeps its row;
 * - the stock check of a higher quantity counts what the note already holds.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2115.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import {
  bookOf, createSalesFlowWorld, deliver, glBalance, invoiceDelivery, receiveStock, type SalesFlowWorld,
} from '../helpers/salesFlowFixture';
import { systemAccounts } from '../../services/systemAccounts';
import { BusinessError } from '../../utils/errors';
import { STOCK_INSUFFICIENT } from '../../services/inventory/stockLocks';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import deliveryOrdersRouter from '../../routes/deliveryOrders';
import { editDeliveryOrderInTx } from '../../services/deliveryOrderEdit';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2115;
const DAY = `${YEAR}-04-07`;
const LATER = `${YEAR}-04-20`;

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

async function inWorld(fn: (tx: Tx, w: SalesFlowWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        const w = await createSalesFlowWorld(tx, YEAR);
        await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id], { warehouses: true });
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

/** Runs fn in a savepoint of the test transaction: a refusal leaves no partial writes. */
function inRouteTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appPrisma.$transaction(fn as (tx: unknown) => Promise<T>) as Promise<T>;
}

async function refusal(p: Promise<unknown>): Promise<BusinessError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);

/** 1.000 kg @10.000 in warehouse A, a note of 100 kg (1.000.000), then 1.000 kg @12.000 come in. */
async function shippedBeforeDearerStock(tx: Tx, w: SalesFlowWorld) {
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 10_000, day: DAY });
  const doc = await deliver(tx, w, DAY, [{ qty: 100 }]);
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
  expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1900.000', value: '21000000.00', average: '11052.631579' });
  return { doc, rowId: doc.items[0]!.stockMovementId! };
}

/** The note's active movements as [id, quantity, value_delta, unit_cost, day]. */
async function activeRows(tx: Tx, doId: string) {
  const rows = await tx.stockMovement.findMany({
    where: { referenceType: 'DeliveryOrder', referenceId: doId, isCancelled: false }, orderBy: { movementNumber: 'asc' },
  });
  return rows.map((r) => [r.id, r.quantity.toFixed(3), money(r.valueDelta.toString()), r.unitCost.toFixed(6), r.date.toISOString().slice(0, 10)]);
}

const body = (w: SalesFlowWorld, date: string, lines: { qty: number; warehouseId?: string }[], header: { driverName?: string } = {}) => ({
  date, partyId: w.customer.id, ...header,
  items: lines.map((l) => ({
    inventoryItemId: w.item.id, warehouseId: l.warehouseId ?? w.warehouseA.id, itemName: w.item.name, quantity: l.qty, unit: 'kg',
  })),
});

d('delivery note edit keeps the original cost', () => {
  it('PATCH of the driver name keeps the movement, its cost and the book', async () => {
    await inWorld(async (tx, w) => {
      const { doc, rowId } = await shippedBeforeDearerStock(tx, w);
      const r = await callRoute(deliveryOrdersRouter, 'patch', '/:id', {
        params: { id: doc.id }, body: { driverName: 'Budi' }, userId: w.userId,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const note = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: doc.id } });
      expect([note.driverName, note.status]).toEqual(['Budi', 'Submitted']);
      expect(await activeRows(tx, doc.id)).toEqual([[rowId, '100.000', '-1000000.00', '10000.000000', DAY]]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1900.000', value: '21000000.00', average: '11052.631579' });
    });
  });

  it('PATCH is refused for a cancelled note and in a locked period', async () => {
    await inWorld(async (tx, w) => {
      const { doc } = await shippedBeforeDearerStock(tx, w);
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${YEAR}-04-30`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      const locked = await callRoute(deliveryOrdersRouter, 'patch', '/:id', { params: { id: doc.id }, body: { driverName: 'Budi' }, userId: w.userId });
      expect(locked.status).toBe(400);
      expect(locked.body.code).toBe('PERIOD_LOCKED');
      await tx.$executeRaw`DELETE FROM period_lock WHERE id = 1`;

      await cancelDeliveryOrderInTx(tx, doc.id, w.userId);
      const cancelled = await callRoute(deliveryOrdersRouter, 'patch', '/:id', { params: { id: doc.id }, body: { driverName: 'Budi' }, userId: w.userId });
      expect(cancelled.status).toBe(400);
      expect((await tx.deliveryOrder.findUniqueOrThrow({ where: { id: doc.id } })).driverName).toBeNull();
    });
  });

  it('PUT with the same lines keeps the movement; moving the day re-posts it at the same value', async () => {
    await inWorld(async (tx, w) => {
      const { doc, rowId } = await shippedBeforeDearerStock(tx, w);
      await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 100 }], { driverName: 'Budi' }), w.userId));
      expect(await activeRows(tx, doc.id)).toEqual([[rowId, '100.000', '-1000000.00', '10000.000000', DAY]]);
      expect((await tx.deliveryOrderItem.findFirstOrThrow({ where: { deliveryOrderId: doc.id } })).stockMovementId).toBe(rowId);

      const moved = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, LATER, [{ qty: 100 }]), w.userId));
      const newRowId = moved.items[0]!.stockMovementId!;
      expect(newRowId).not.toBe(rowId);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: rowId } })).isCancelled).toBe(true);
      expect(await activeRows(tx, doc.id)).toEqual([[newRowId, '100.000', '-1000000.00', '10000.000000', LATER]]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1900.000', value: '21000000.00', average: '11052.631579' });
    });
  });

  it('100 -> 120 takes the extra 20 at the average now, 120 -> 80 hands 40 back at the row\'s value; COGS = the line value', async () => {
    await inWorld(async (tx, w) => {
      const { doc } = await shippedBeforeDearerStock(tx, w);
      const up = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 120 }]), w.userId));
      // 1.000.000 kept + round(21.000.000 x 20 / 1.900, 2) = 221.052,63.
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 4))).toEqual([['120.000', '-1221052.63', '10175.438583']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1880.000', value: '20778947.37', average: '11052.631580' });

      const down = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 80 }]), w.userId));
      expect(down.items[0]!.stockMovementId).not.toBe(up.items[0]!.stockMovementId);
      // 40 back at round(1.221.052,63 x 40 / 120, 2) = 407.017,54: the row keeps 814.035,09.
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 4))).toEqual([['80.000', '-814035.09', '10175.438625']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1920.000', value: '21185964.91', average: '11034.356724' });

      await invoiceDelivery(tx, w, DAY, down, { rate: 15_000 });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('814035.09');
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('21185964.91');
    });
  });

  it('a removed line goes back at its own value, a new line in another warehouse at the average now', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 10_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 100 }, { qty: 50 }]);
      const [kept, removed] = doc.items.map((l) => l.stockMovementId!);
      await receiveStock(tx, w, { warehouseId: w.warehouseB.id, qty: 500, avg: 12_000, day: DAY });
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1350.000', value: '14500000.00', average: '10740.740741' });

      const edited = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [
        { qty: 100 }, { qty: 30, warehouseId: w.warehouseB.id },
      ]), w.userId));
      expect(edited.items.map((l) => l.stockMovementId)[0]).toBe(kept);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: removed! } })).isCancelled).toBe(true);
      // 50 back at 500.000 (1.400 kg, 15.000.000), then 30 out at round(15.000.000 x 30 / 1.400, 2) = 321.428,57.
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 3)).sort()).toEqual([['100.000', '-1000000.00'], ['30.000', '-321428.57']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1370.000', value: '14678571.43', average: '10714.285715' });
      const stocks = await tx.inventoryStock.findMany({ where: { itemId: w.item.id }, orderBy: { currentStock: 'desc' } });
      expect(stocks.map((s) => s.currentStock.toFixed(3))).toEqual(['900.000', '470.000']);
    });
  });

  it('the stock check of a higher quantity counts what the note already holds; nothing changes when short', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 100 }]);
      const before = await activeRows(tx, doc.id);

      const err = await refusal(inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 120 }]), w.userId)));
      expect(err.code).toBe(STOCK_INSUFFICIENT);
      expect(err.message).toContain('Tersedia: 100 kg, dibutuhkan: 120 kg');
      expect(await activeRows(tx, doc.id)).toEqual(before);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '0.000', value: '0.00', average: '10000.000000' });
    });
  });
});
