/**
 * Integration test: the stock count and sales return paths on the value ledger (E3-R6, E3-R7,
 * PR-6.4c2), on fixtures made here inside a rollback transaction (helpers/salesFlowFixture.ts):
 * - a restocked return blends into the average: 100 kg returned at the 10.000 the delivery took
 *   onto 1.000 kg @12.000 -> average 11.818,181818, stock_value 13.000.000 = GL; its cancel takes
 *   it back exactly, and after a later sale replays the item for its true-up (PR-6.5a);
 * - three returns of a third of a note line never take back more than its COGS: 3.333,33 +
 *   3.333,33 + 3.333,34 = 10.000,00;
 * - a count deficit leaves at the ledger's cost (330.000 for 30 kg at 11.000), not the typed unit
 *   cost, the typed cost then revalues the counted stock (Revaluation +480.000) with the same net
 *   variance as before the ledger (150.000); a surplus comes in at the line cost; cancel restores
 *   the book exactly;
 * - with no stock on hand a revaluation goes to COGS whole (postRevaluation), and a count that
 *   leaves no stock but types a cost other than the average is refused
 *   (OPNAME_REVALUATION_NO_STOCK), storing nothing;
 * - a return that lists one invoice line twice is refused (SALES_RETURN_DUPLICATE_LINE): the value
 *   cap of later returns reads each return item's own In;
 * - a count whose journal holds a revaluation but which owns no Revaluation row (before the value
 *   ledger) cannot be cancelled: OPNAME_LEGACY_REVALUATION.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2130.
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
import { postRevaluation } from '../../services/inventory/inventoryLedger';
import { systemAccounts } from '../../services/systemAccounts';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import stockOpnameRouter, { OPNAME_LEGACY_REVALUATION, OPNAME_REVALUATION_NO_STOCK } from '../../routes/stockOpname';
import { SALES_RETURN_DUPLICATE_LINE, submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { cancelSalesReturnInTx } from '../../services/salesReturnCancel';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2130;
const DAY = `${YEAR}-05-04`;
const LATER = `${YEAR}-05-18`;

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

interface World extends SalesFlowWorld {
  /** Leaf mapped to INVENTORY_VARIANCE inside the transaction (a database may share it with rounding). */
  variance: { id: string };
}

async function inWorld(fn: (tx: Tx, w: World) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        const base = await createSalesFlowWorld(tx, YEAR);
        const variance = await tx.account.create({
          data: { name: 'IT-OR Selisih Persediaan', accountNumber: `IT-OR-VAR-${Date.now().toString(36)}`, accountType: 'EXPENSE', rootType: 'EXPENSE' },
        });
        await tx.systemAccountMapping.deleteMany({ where: { role: 'INVENTORY_VARIANCE' } });
        await tx.systemAccountMapping.create({ data: { role: 'INVENTORY_VARIANCE', accountId: variance.id } });
        systemAccounts.invalidateCache();
        const w = { ...base, variance };
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

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);

/** Delivered and invoiced through the real services; returns the invoice line of the note's only line. */
async function sell(tx: Tx, w: World, qty: number, day = DAY) {
  const doc = await deliver(tx, w, day, [{ qty }]);
  const invoice = await invoiceDelivery(tx, w, day, doc, { rate: 15_000 });
  const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
  return { doc, invoice, line };
}

function returnGoods(tx: Tx, w: World, sale: Awaited<ReturnType<typeof sell>>, qty: number) {
  return submitSalesReturnInTx(tx, {
    salesInvoiceId: sale.invoice.id, date: DAY,
    items: [{ salesInvoiceItemId: sale.line.id, quantity: qty, restock: true, warehouseId: w.warehouseA.id }],
  }, w.userId);
}

async function returnRow(tx: Tx, returnId: string) {
  const item = await tx.salesReturnItem.findFirstOrThrow({ where: { salesReturnId: returnId } });
  return tx.stockMovement.findUniqueOrThrow({ where: { id: item.stockMovementId! } });
}

async function count(tx: Tx, w: World, line: { actualStock: number; unitCost?: number }) {
  const res = await callRoute(stockOpnameRouter, 'post', '/', {
    userId: w.userId,
    body: { date: DAY, warehouseId: w.warehouseA.id, items: [{ itemId: w.item.id, ...line }] },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; opnameNumber: string };
}

/** The cancel route behind requireCap('doc.cancel'), as a user whose role holds exactly that capability. */
async function cancelCount(tx: Tx, id: string) {
  const { userId, role } = await createCapUser(tx, ['doc.cancel']);
  return callRoute(stockOpnameRouter, 'put', '/:id/cancel', { params: { id }, userId, role });
}

/** The lines of JV-<opname> on the item's inventory, variance and COGS accounts, as signed debit − credit. */
async function opnameJournal(tx: Tx, w: World, opnameNumber: string) {
  const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${opnameNumber}` }, include: { items: true } });
  const net = (accountId: string) => money(je.items
    .filter((l) => l.accountId === accountId)
    .reduce((s, l) => s.plus(l.debit.toString()).minus(l.credit.toString()), new Decimal(0)));
  return { inventory: net(w.accounts.inventory.id), variance: net(w.variance.id), cogs: net(w.accounts.cogs.id) };
}

/** 100 kg @10.000 and 50 kg @13.000 into warehouse A: 150 kg, 1.650.000,00, average 11.000. */
async function stockForCount(tx: Tx, w: World) {
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 50, avg: 13_000, day: DAY });
  expect(await bookOf(tx, w.item.id)).toEqual({ stock: '150.000', value: '1650000.00', average: '11000.000000' });
}

d('sales returns on the value ledger (PR-6.4c2)', () => {
  it('a return of 100 kg at 10.000 onto 1.000 kg @12.000 blends: average 11.818,181818, stock_value 13.000.000 = GL; cancel takes it back', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 100 }]);
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const invoice = await invoiceDelivery(tx, w, DAY, doc, { rate: 15_000 });
      const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1000.000', value: '12000000.00', average: '12000.000000' });

      const ret = await returnGoods(tx, w, { doc, invoice, line }, 100);
      const row = await returnRow(tx, ret!.id);
      expect([row.movementType, money(row.valueDelta.toString()), row.unitCost.toFixed(6), row.offsetAccountId])
        .toEqual(['In', '1000000.00', '10000.000000', w.accounts.cogs.id]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1100.000', value: '13000000.00', average: '11818.181818' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('13000000.00');
      // The invoice's COGS of 1.000.000 is reversed in full.
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('0.00');

      await cancelSalesReturnInTx(tx, ret!.id, { cancelledById: w.userId, cancelReason: 'test' });
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: row.id } })).isCancelled).toBe(true);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1000.000', value: '12000000.00', average: '12000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('12000000.00');
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('1000000.00');
    });
  });

  it('three returns of a third of a note line add up to its COGS: 3.333,33 + 3.333,33 + 3.333,34', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 3, avg: '3333.333333', day: DAY });
      const sale = await sell(tx, w, 3);
      const out = await tx.stockMovement.findUniqueOrThrow({ where: { id: sale.doc.items[0]!.stockMovementId! } });
      expect(money(out.valueDelta.toString())).toBe('-10000.00');

      const values: string[] = [];
      for (let i = 0; i < 3; i++) {
        const ret = await returnGoods(tx, w, sale, 1);
        values.push(money((await returnRow(tx, ret!.id)).valueDelta.toString()));
      }
      expect(values).toEqual(['3333.33', '3333.33', '3333.34']);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '3.000', value: '10000.00', average: '3333.333333' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('10000.00');
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('0.00');
    });
  });

  it('a return listing one invoice line twice is refused (SALES_RETURN_DUPLICATE_LINE) and changes nothing', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const sale = await sell(tx, w, 100);
      const before = await bookOf(tx, w.item.id);
      const twice = { salesInvoiceItemId: sale.line.id, quantity: 50, restock: true, warehouseId: w.warehouseA.id };

      expect(await codeOf(inRouteTx((t) => submitSalesReturnInTx(t, {
        salesInvoiceId: sale.invoice.id, date: DAY, items: [twice, twice],
      }, w.userId)))).toBe(SALES_RETURN_DUPLICATE_LINE);
      expect(await tx.salesReturn.count({ where: { salesInvoiceId: sale.invoice.id } })).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual(before);

      // One line of 100 is linked to its own In and takes the whole COGS back.
      const ret = await returnGoods(tx, w, sale, 100);
      expect(money((await returnRow(tx, ret!.id)).valueDelta.toString())).toBe('1000000.00');
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('0.00');
    });
  });

  it('a return cancel after goods of the item went out replays the item (PR-6.5a): one cost, so true-up 0', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const sale = await sell(tx, w, 100);
      const ret = await returnGoods(tx, w, sale, 40);
      await deliver(tx, w, LATER, [{ qty: 50 }]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '890.000', value: '10680000.00', average: '12000.000000' });

      await inRouteTx((t) => cancelSalesReturnInTx(t, ret!.id, { cancelledById: w.userId, cancelReason: 'test' }));
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '850.000', value: '10200000.00', average: '12000.000000' });
      expect(await tx.stockMovement.count({ where: { itemId: w.item.id, movementType: 'Revaluation', isCancelled: false } })).toBe(0);
      expect((await tx.salesReturn.findUniqueOrThrow({ where: { id: ret!.id } })).status).toBe('Cancelled');
    });
  });
});

d('stock count on the value ledger (PR-6.4c2)', () => {
  it('a deficit leaves at the ledger cost, the typed cost revalues the counted stock; cancel restores the book', async () => {
    await inWorld(async (tx, w) => {
      await stockForCount(tx, w);
      const so = await count(tx, w, { actualStock: 120, unitCost: 15_000 });

      const rows = await tx.stockMovement.findMany({ where: { referenceType: 'StockOpname', referenceId: so.id }, orderBy: { valueDelta: 'asc' } });
      expect(rows.map((r) => [r.movementType, r.quantity.toFixed(3), money(r.valueDelta.toString()), r.warehouseId]))
        .toEqual([['AdjustmentOut', '30.000', '-330000.00', w.warehouseA.id], ['Revaluation', '0.000', '480000.00', null]]);
      const line = await tx.stockOpnameItem.findFirstOrThrow({ where: { stockOpnameId: so.id } });
      expect([line.unitCost.toFixed(6), money(line.totalValue.toString())]).toEqual(['11000.000000', '330000.00']);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '120.000', value: '1800000.00', average: '15000.000000' });
      // Inventory +150.000 net; the variance account takes the same 150.000 as the old revaluation
      // on 150 kg (600.000) less the deficit at the typed cost (450.000).
      expect(await opnameJournal(tx, w, so.opnameNumber)).toEqual({ inventory: '150000.00', variance: '-150000.00', cogs: '0.00' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1800000.00');

      const res = await cancelCount(tx, so.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await tx.stockMovement.count({ where: { referenceType: 'StockOpname', referenceId: so.id, isCancelled: false } })).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '150.000', value: '1650000.00', average: '11000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1650000.00');
      expect(money(await glBalance(tx, w.variance.id))).toBe('0.00');
    });
  });

  it('a surplus comes in at the line cost and blends; cancel takes it back', async () => {
    await inWorld(async (tx, w) => {
      await stockForCount(tx, w);
      const so = await count(tx, w, { actualStock: 160 });
      const row = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: 'StockOpname', referenceId: so.id } });
      expect([row.movementType, money(row.valueDelta.toString())]).toEqual(['AdjustmentIn', '110000.00']);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '160.000', value: '1760000.00', average: '11000.000000' });
      expect(await opnameJournal(tx, w, so.opnameNumber)).toEqual({ inventory: '110000.00', variance: '-110000.00', cogs: '0.00' });

      expect((await cancelCount(tx, so.id)).status).toBe(200);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '150.000', value: '1650000.00', average: '11000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1650000.00');
    });
  });

  it('with no stock on hand a revaluation goes to COGS whole; a count to 0 with a typed cost is refused', async () => {
    await inWorld(async (tx, w) => {
      await stockForCount(tx, w);
      const refused = await callRoute(stockOpnameRouter, 'post', '/', {
        userId: w.userId,
        body: { date: DAY, warehouseId: w.warehouseA.id, items: [{ itemId: w.item.id, actualStock: 0, unitCost: 15_000 }] },
      });
      expect([refused.status, (refused.body as { code?: string }).code]).toEqual([400, OPNAME_REVALUATION_NO_STOCK]);
      expect(await tx.stockOpname.count({ where: { fiscalYearId: w.fyId } })).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '150.000', value: '1650000.00', average: '11000.000000' });

      const so = await count(tx, w, { actualStock: 0 });
      const rows = await tx.stockMovement.findMany({ where: { referenceType: 'StockOpname', referenceId: so.id } });
      expect(rows.map((r) => [r.movementType, money(r.valueDelta.toString())])).toEqual([['AdjustmentOut', '-1650000.00']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '0.000', value: '0.00', average: '11000.000000' });
      expect(await opnameJournal(tx, w, so.opnameNumber)).toEqual({ inventory: '-1650000.00', variance: '1650000.00', cogs: '0.00' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('0.00');

      const rev = await postRevaluation(tx, {
        itemId: w.item.id, delta: '25000.50', date: new Date(LATER), fiscalYearId: w.fyId, createdById: w.userId,
        referenceType: 'StockOpname', referenceId: so.id, referenceNumber: so.opnameNumber,
      });
      expect([money(rev.valueDelta), money(rev.toCogs)]).toEqual(['0.00', '25000.50']);
      expect([rev.movement.movementType, money(rev.movement.valueDelta.toString()), rev.movement.quantity.toFixed(3), rev.movement.warehouseId])
        .toEqual(['Revaluation', '0.00', '0.000', null]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '0.000', value: '0.00', average: '11000.000000' });
    });
  });

  it('a revaluation stock can absorb moves stock_value; a decrease larger than the value sends the rest to COGS', async () => {
    await inWorld(async (tx, w) => {
      await stockForCount(tx, w);
      const base = { itemId: w.item.id, date: new Date(DAY), fiscalYearId: w.fyId, createdById: w.userId, referenceType: 'StockOpname' };
      const up = await postRevaluation(tx, { ...base, delta: 150_000 });
      expect([money(up.valueDelta), money(up.toCogs), up.averageCostAfter.toFixed(6)]).toEqual(['150000.00', '0.00', '12000.000000']);
      const down = await postRevaluation(tx, { ...base, delta: -2_000_000 });
      expect([money(down.valueDelta), money(down.toCogs)]).toEqual(['-1800000.00', '-200000.00']);
      // Never clamped: the book reaches 0 and the rest of the decrease is the caller's COGS line.
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '150.000', value: '0.00', average: '0.000000' });
    });
  });

  it('a count with a journaled revaluation but no Revaluation row (before the ledger) cannot be cancelled', async () => {
    await inWorld(async (tx, w) => {
      await stockForCount(tx, w);
      const so = await count(tx, w, { actualStock: 150, unitCost: 12_000 });
      const rev = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: 'StockOpname', referenceId: so.id, movementType: 'Revaluation' } });
      expect(money(rev.valueDelta.toString())).toBe('150000.00');
      // Legacy shape: the value went into the average directly, no row records it.
      await tx.stockMovement.update({ where: { id: rev.id }, data: { referenceType: 'ValuationBaseline', referenceId: null } });
      const before = await bookOf(tx, w.item.id);

      const res = await cancelCount(tx, so.id);
      expect([res.status, res.body.code]).toEqual([409, OPNAME_LEGACY_REVALUATION]);
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: so.id } })).status).toBe('Submitted');
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1800000.00');
    });
  });
});
