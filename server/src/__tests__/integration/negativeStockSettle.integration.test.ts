/**
 * Integration test: negative stock settled when goods come in (E3-R9, PR-6.6), through the real
 * delivery order, sales invoice and goods receipt services on a fixture made inside a rollback
 * transaction (helpers/salesFlowFixture.ts):
 * - PRD acceptance: average 10.000 at stock 0, a delivery of 100 through the bypass, invoiced (COGS
 *   1.000.000), a receipt of 300 @12.000 -> one settlement journal DR COGS 200.000 / CR inventory,
 *   average 12.000, stock_value 2.400.000; the receipt's batch cost stays 12.000;
 * - crossing zero: 100 @10.000, delivery of 150, receipt 100 @12.000 -> COGS over both events
 *   150 x 10.000 + 50 x 2.000;
 * - an item that never had a cost (average 0) cannot go past zero through a delivery order: 400
 *   NEGATIVE_STOCK_NO_COST even for a holder of inventory.negative_stock, nothing is written;
 * - cancelling the settling receipt (with the bypass) takes the settlement back through its value
 *   true-up: the book returns to the 100 sold past zero at 10.000;
 * - a delivery past zero, a receipt that settles it, then the delivery cancelled: the settlement
 *   comes back through the true-up (+100.000) and the receipt keeps its whole value.
 * Book = GL (+ the value of notes not invoiced yet) after every step; every scenario ends with
 * assertLedgerInvariant (warehouses included). "Today" is the fixture year's day (businessToday
 * mocked). Fiscal year 2116.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import {
  bookOf, createSalesFlowWorld, deliver, glBalance, invoiceDelivery, receiveStock, type SalesFlowWorld,
} from '../helpers/salesFlowFixture';
import { systemAccounts } from '../../services/systemAccounts';
import { sourceKeys } from '../../services/ledger/journalSource';
import { NEGATIVE_STOCK_SETTLE_REFERENCE } from '../../services/inventory/inventoryValueMath';

const state = vi.hoisted(() => ({ tx: null as Tx | null, today: null as string | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../utils/businessDate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/businessDate')>();
  return { ...actual, businessToday: (...args: Parameters<typeof actual.businessToday>) => state.today ?? actual.businessToday(...args) };
});

import { prisma as appPrisma } from '../../lib/prisma';
import deliveryOrdersRouter from '../../routes/deliveryOrders';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { NEGATIVE_STOCK_NO_COST, batchUnitCosts } from '../../services/inventory/inventoryLedger';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2116;

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

async function inWorld(today: string, fn: (tx: Tx, w: SalesFlowWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      state.today = today;
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

const money = (v: Decimal.Value) => new Decimal(v.toString()).toFixed(2);
const BYPASS = { allowNegativeStock: true, negativeStockReason: 'uji stok minus E3-R9' };

/** A delivery order of the world's item through the bypass (the caller holds inventory.negative_stock). */
function deliverPastZero(tx: Tx, w: SalesFlowWorld, day: string, qty: number) {
  return submitDeliveryOrderInTx(tx, {
    date: day, partyId: w.customer.id, ...BYPASS,
    items: [{ inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: qty, unit: 'kg' }],
  } as Parameters<typeof submitDeliveryOrderInTx>[1], w.userId);
}

/** The value of delivery notes not invoiced yet: in the book's outflow, not yet in the GL (no journal). */
async function uninvoicedNoteValue(tx: Tx, w: SalesFlowWorld): Promise<Decimal> {
  const rows = await tx.stockMovement.findMany({
    // The note's own Out rows: a true-up row of a cancelled note carries its journal already.
    where: { itemId: w.item.id, referenceType: 'DeliveryOrder', movementType: 'Out', isCancelled: false },
    select: { valueDelta: true, referenceId: true },
  });
  const notes = await tx.deliveryOrder.findMany({ where: { id: { in: rows.map((r) => r.referenceId!) } }, select: { id: true, invoiceId: true } });
  const open = new Set(notes.filter((n) => !n.invoiceId).map((n) => n.id));
  return rows.filter((r) => open.has(r.referenceId!)).reduce((s, r) => s.minus(r.valueDelta.toString()), new Decimal(0));
}

/** GL of the item's inventory account = stock_value + the value of notes not invoiced yet. */
async function expectBookEqualsGl(tx: Tx, w: SalesFlowWorld): Promise<void> {
  const book = await bookOf(tx, w.item.id);
  const gl = await glBalance(tx, w.accounts.inventory.id);
  expect(money(gl)).toBe(money(new Decimal(book.value).plus(await uninvoicedNoteValue(tx, w))));
}

function journalsByKey(tx: Tx, sourceKey: string) {
  return tx.journalEntry.findMany({ where: { sourceKey, status: { not: 'Cancelled' } }, include: { items: true } });
}

/** Average 10.000 at stock 0: 100 received and the same 100 delivered and invoiced. */
async function averageAtZero(tx: Tx, w: SalesFlowWorld, avg: number, day: string): Promise<void> {
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg, day });
  const note = await deliver(tx, w, day, [{ qty: 100 }]);
  await invoiceDelivery(tx, w, day, note, { rate: avg * 2 });
  expect(await bookOf(tx, w.item.id)).toEqual({ stock: '0.000', value: '0.00', average: new Decimal(avg).toFixed(6) });
}

d('negative stock settled on inbound (E3-R9)', () => {
  it('PRD: average 10.000, stock 0, delivery 100 invoiced, receipt 300 @12.000 -> DR COGS 200.000, average 12.000, stock_value 2.400.000', async () => {
    await inWorld(`${YEAR}-03-20`, async (tx, w) => {
      await averageAtZero(tx, w, 10_000, `${YEAR}-03-02`);
      const minus = await deliverPastZero(tx, w, `${YEAR}-03-03`, 100);
      await invoiceDelivery(tx, w, `${YEAR}-03-03`, minus, { rate: 15_000 });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '-100.000', value: '-1000000.00' });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('2000000.00');
      await expectBookEqualsGl(tx, w);

      const receipt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 300, avg: 12_000, day: `${YEAR}-03-04` });
      expect(money(receipt.value)).toBe('3600000.00');

      const [journal, ...more] = await journalsByKey(tx, sourceKeys.inventoryNegativeSettle(receipt.movementId));
      expect(more).toHaveLength(0);
      expect(journal.entryNumber).toMatch(/^JV-\d{6}-/);
      expect(journal.sourceType).toBe('SYSTEM_DOC');
      expect(journal.date.toISOString().slice(0, 10)).toBe(`${YEAR}-03-04`);
      const line = (accountId: string) => journal.items.find((i) => i.accountId === accountId)!;
      expect(money(line(w.accounts.cogs.id).debit)).toBe('200000.00');
      expect(money(line(w.accounts.inventory.id).credit)).toBe('200000.00');

      const row = await tx.stockMovement.findFirstOrThrow({ where: { adjustsMovementId: receipt.movementId, movementType: 'Revaluation' } });
      expect(row).toMatchObject({
        referenceType: NEGATIVE_STOCK_SETTLE_REFERENCE, referenceId: receipt.movementId, warehouseId: null, journalEntryId: journal.id, isCancelled: false,
      });
      expect(money(row.valueDelta)).toBe('-200000.00');

      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '200.000', value: '2400000.00', average: '12000.000000' });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('2200000.00');
      await expectBookEqualsGl(tx, w);

      // The settlement re-values the goods sold before the receipt, not the receipt's batch.
      const inbound = await tx.stockMovement.findUniqueOrThrow({ where: { id: receipt.movementId } });
      expect((await batchUnitCosts(tx, [inbound])).get(inbound.id)!.toFixed(6)).toBe('12000.000000');
    });
  });

  it('crossing zero: 100 @10.000, delivery 150, receipt 100 @12.000 -> COGS 150 x 10.000 + 50 x 2.000', async () => {
    await inWorld(`${YEAR}-04-20`, async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: `${YEAR}-04-01` });
      const note = await deliverPastZero(tx, w, `${YEAR}-04-02`, 150);
      await invoiceDelivery(tx, w, `${YEAR}-04-02`, note, { rate: 15_000 });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '-50.000', value: '-500000.00' });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('1500000.00');

      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 12_000, day: `${YEAR}-04-03` });

      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe(money(150 * 10_000 + 50 * 2_000));
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '50.000', value: '600000.00', average: '12000.000000' });
      await expectBookEqualsGl(tx, w);
    });
  });

  it('an item with average 0 cannot go past zero: 400 NEGATIVE_STOCK_NO_COST even with inventory.negative_stock', async () => {
    await inWorld(`${YEAR}-05-20`, async (tx, w) => {
      const holder = await createCapUser(tx, ['inventory.negative_stock']);
      const res = await callRoute(deliveryOrdersRouter, 'post', '/', {
        body: {
          date: `${YEAR}-05-02`, partyId: w.customer.id, ...BYPASS,
          items: [{ inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: 10, unit: 'kg' }],
        },
        userId: holder.userId, role: holder.role,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe(NEGATIVE_STOCK_NO_COST);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '0.000', value: '0.00', average: '0.000000' });
      expect(await tx.stockMovement.count({ where: { itemId: w.item.id } })).toBe(0);
      expect(await tx.deliveryOrder.count({ where: { partyId: w.customer.id } })).toBe(0);
    });
  });

  it('cancelling the settling receipt takes the settlement back: book back to the 100 sold past zero at 10.000', async () => {
    await inWorld(`${YEAR}-06-20`, async (tx, w) => {
      await averageAtZero(tx, w, 10_000, `${YEAR}-06-01`);
      const minus = await deliverPastZero(tx, w, `${YEAR}-06-02`, 100);
      await invoiceDelivery(tx, w, `${YEAR}-06-02`, minus, { rate: 15_000 });
      const receipt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 300, avg: 12_000, day: `${YEAR}-06-03` });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '200.000', value: '2400000.00' });

      await inRouteTx((t) => cancelGoodsReceiptInTx(t, receipt.goodsReceiptId, w.userId, BYPASS));

      // The true-up of the cancel is minus the settlement: DR inventory 200.000 / CR COGS.
      const [trueUp] = await journalsByKey(tx, sourceKeys.inventoryTrueUp(receipt.movementId));
      const line = (accountId: string) => trueUp.items.find((i) => i.accountId === accountId)!;
      expect(money(line(w.accounts.inventory.id).debit)).toBe('200000.00');
      expect(money(line(w.accounts.cogs.id).credit)).toBe('200000.00');
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '-100.000', value: '-1000000.00' });
      // COGS of the two invoices only: the settlement and its take-back net to 0.
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('2000000.00');
      await expectBookEqualsGl(tx, w);
    });
  });

  it('delivery past zero, receipt settles it, delivery cancelled -> the settlement comes back (+100.000), stock 100 at 1.000.000', async () => {
    await inWorld(`${YEAR}-07-20`, async (tx, w) => {
      await averageAtZero(tx, w, 9_000, `${YEAR}-07-01`);
      const minus = await deliverPastZero(tx, w, `${YEAR}-07-02`, 100);
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '-100.000', value: '-900000.00' });
      await expectBookEqualsGl(tx, w);

      const receipt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: `${YEAR}-07-03` });
      const [settle] = await journalsByKey(tx, sourceKeys.inventoryNegativeSettle(receipt.movementId));
      expect(money(settle.items.find((i) => i.accountId === w.accounts.cogs.id)!.debit)).toBe('100000.00');
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '0.000', value: '0.00' });
      await expectBookEqualsGl(tx, w);

      const minusRow = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: 'DeliveryOrder', referenceId: minus.id } });
      await inRouteTx((t) => cancelDeliveryOrderInTx(t, minus.id, w.userId));

      const [trueUp] = await journalsByKey(tx, sourceKeys.inventoryTrueUp(minusRow.id));
      expect(money(trueUp.items.find((i) => i.accountId === w.accounts.inventory.id)!.debit)).toBe('100000.00');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });
      // COGS of the first invoice only (900.000): the note past zero was never billed.
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('900000.00');
      await expectBookEqualsGl(tx, w);
    });
  });
});
