/**
 * Integration test: a delivery note edit keeps the cost its goods went out at (E3-R8, owner
 * decision #9, PR-6.5b), on fixtures made here inside a rollback transaction
 * (helpers/salesFlowFixture.ts). Each note ships 100 kg at 10.000 before 1.000 kg at 12.000 come in,
 * so the average moves away from the note's cost:
 * - a header edit through PATCH (driver name) leaves the movement, its cost and the book as they
 *   are; PATCH of a cancelled note and in a locked period is refused;
 * - a PUT with the same lines keeps the movement; a PUT that moves the note to another day in the
 *   month re-posts the row on that day at the same value;
 * - 100 -> 120 kg after the dearer stock came in is refused (the row keeps its place in processing
 *   order); the extra on a new line goes out at the average now, and a cancel of that stock then
 *   trues the extra up so book = replay;
 * - with no stock in since the note, 100 -> 120 keeps one row, 120 -> 80 hands 40 back at the row's
 *   own unit value, and the invoice COGS is the line's movement value; GL = book;
 * - a removed line is reversed at its own value and a new line in another warehouse is posted at
 *   the average now, while the unchanged line keeps its row;
 * - a removed line and a lower quantity after a later sale are trued up as a cancel is: book =
 *   replay, the difference against COGS in a journal dated today;
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
import { sourceKeys } from '../../services/ledger/journalSource';
import { BusinessError } from '../../utils/errors';
import { replayItemValue } from '../../utils/weightedAverageReplay';
import { STOCK_INSUFFICIENT } from '../../services/inventory/stockLocks';
import { OUTBOUND_INCREASE_AFTER_INBOUND } from '../../services/inventory/inventoryLedger';

const state = vi.hoisted(() => ({ tx: null as Tx | null, today: null as string | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
// True-up rows and journals are dated today: keep them in the fixture year.
vi.mock('../../utils/businessDate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/businessDate')>();
  return { ...actual, businessToday: (...args: Parameters<typeof actual.businessToday>) => state.today ?? actual.businessToday(...args) };
});

import { prisma as appPrisma } from '../../lib/prisma';
import deliveryOrdersRouter from '../../routes/deliveryOrders';
import { editDeliveryOrderInTx } from '../../services/deliveryOrderEdit';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2115;
const DAY = `${YEAR}-04-07`;
const LATER = `${YEAR}-04-20`;
const TODAY = `${YEAR}-04-25`;

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
      state.today = TODAY;
      try {
        const w = await createSalesFlowWorld(tx, YEAR);
        await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id], { warehouses: true });
      } finally {
        state.tx = null;
        state.today = null;
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
  const dearer = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
  expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1900.000', value: '21000000.00', average: '11052.631579' });
  return { doc, rowId: doc.items[0]!.stockMovementId!, dearer };
}

/** The active journals of the value true-up of a row the edit took back, as [inventory debit, COGS credit]. */
async function trueUpOf(tx: Tx, w: SalesFlowWorld, movementId: string) {
  const journals = await tx.journalEntry.findMany({
    where: { sourceKey: sourceKeys.inventoryTrueUp(movementId), status: { not: 'Cancelled' } },
    include: { items: true },
  });
  return journals.map((j) => {
    const line = (accountId: string) => j.items.find((i) => i.accountId === accountId)!;
    return [j.date.toISOString().slice(0, 10), money(line(w.accounts.inventory.id).debit.toString()), money(line(w.accounts.cogs.id).credit.toString())];
  });
}

/** 100 kg @10.000; a note of 40 + 10 kg; 50 kg @12.000 come in; another note sells 50 kg at 11.000. */
async function soldAfterTheNote(tx: Tx, w: SalesFlowWorld) {
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
  const doc = await deliver(tx, w, DAY, [{ qty: 40 }, { qty: 10 }]);
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 50, avg: 12_000, day: DAY });
  await deliver(tx, w, DAY, [{ qty: 50 }]);
  expect(await bookOf(tx, w.item.id)).toEqual({ stock: '50.000', value: '550000.00', average: '11000.000000' });
  return { doc, kept: doc.items[0]!.stockMovementId!, edited: doc.items[1]!.stockMovementId! };
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

  it('100 -> 120 after dearer stock is refused; the extra on a new line goes out at the average now and a cancel of that stock trues it up', async () => {
    await inWorld(async (tx, w) => {
      const { doc, rowId, dearer } = await shippedBeforeDearerStock(tx, w);
      const before = await activeRows(tx, doc.id);
      const err = await refusal(inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 120 }]), w.userId)));
      expect(err.code).toBe(OUTBOUND_INCREASE_AFTER_INBOUND);
      expect(await activeRows(tx, doc.id)).toEqual(before);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1900.000', value: '21000000.00', average: '11052.631579' });

      const split = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 100 }, { qty: 20 }]), w.userId));
      expect(split.items[0]!.stockMovementId).toBe(rowId);
      // The kept row stays at 1.000.000; the extra 20 at round(21.000.000 x 20 / 1.900, 2) = 221.052,63.
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 3))).toEqual([['100.000', '-1000000.00'], ['20.000', '-221052.63']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1880.000', value: '20778947.37', average: '11052.631580' });

      // Without the dearer stock the history is 1.000 @10.000 less 100 less 20: 880 kg at 8.800.000.
      await inRouteTx((t) => cancelGoodsReceiptInTx(t, dearer.goodsReceiptId, w.userId));
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '880.000', value: '8800000.00' });
      expect(money((await replayItemValue(tx, w.item.id)).value)).toBe('8800000.00');
    });
  });

  it('with no stock in since the note, 100 -> 120 keeps one row, 120 -> 80 hands 40 back at the row\'s value; COGS = the line value', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 10_000, day: DAY });
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 100 }]);
      const up = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 120 }]), w.userId));
      // 1.100.000 kept + 20 at the average now (11.000) = 1.320.000.
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 4))).toEqual([['120.000', '-1320000.00', '11000.000000']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1880.000', value: '20680000.00', average: '11000.000000' });

      const down = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 80 }]), w.userId));
      expect(down.items[0]!.stockMovementId).not.toBe(up.items[0]!.stockMovementId);
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 4))).toEqual([['80.000', '-880000.00', '11000.000000']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1920.000', value: '21120000.00', average: '11000.000000' });

      await invoiceDelivery(tx, w, DAY, down, { rate: 15_000 });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('880000.00');
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('21120000.00');
    });
  });

  it('a removed line after a later sale is trued up as a cancel: book = replay, the difference against COGS today', async () => {
    await inWorld(async (tx, w) => {
      const { doc, kept, edited } = await soldAfterTheNote(tx, w);
      const result = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 40 }]), w.userId));
      expect(result.items.map((l) => l.stockMovementId)).toEqual([kept]);
      // Without the 10 kg: 60 @10.000, then 50 @12.000 -> 110 kg at 1.200.000, the sale of 50 takes
      // 545.454,55 -> 60 kg at 654.545,45; the exact hand-back leaves 650.000, so 4.545,45 comes back.
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '60.000', value: '654545.45' });
      expect(money((await replayItemValue(tx, w.item.id)).value)).toBe('654545.45');
      expect(await trueUpOf(tx, w, edited)).toEqual([[TODAY, '4545.45', '4545.45']]);
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('-4545.45');
    });
  });

  it('a lower quantity after a later sale is trued up the same way', async () => {
    await inWorld(async (tx, w) => {
      const { doc, edited } = await soldAfterTheNote(tx, w);
      await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 40 }, { qty: 5 }]), w.userId));
      // 5 back at the row's 10.000 (600.000); with 5 kg less out, the sale takes 50 of 105 kg at
      // 1.150.000 = 547.619,05 instead of 550.000, so 2.380,95 comes back: 55 kg at 602.380,95.
      // The note owns the true-up row (a Revaluation adjusting the row taken back) besides its lines.
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 3))).toEqual([['40.000', '-400000.00'], ['5.000', '-50000.00'], ['0.000', '2380.95']]);
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '55.000', value: '602380.95' });
      expect(money((await replayItemValue(tx, w.item.id)).value)).toBe('602380.95');
      expect(await trueUpOf(tx, w, edited)).toEqual([[TODAY, '2380.95', '2380.95']]);

      // A later edit keeps that row: only the lines are re-planned, and the unchanged book stays.
      await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(w, DAY, [{ qty: 40 }, { qty: 5 }], { driverName: 'Budi' }), w.userId));
      expect((await activeRows(tx, doc.id)).map((r) => r.slice(1, 3))).toEqual([['40.000', '-400000.00'], ['5.000', '-50000.00'], ['0.000', '2380.95']]);
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '55.000', value: '602380.95' });
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
