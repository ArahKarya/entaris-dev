/**
 * Integration test: the stock count server side (E3-R11, PR-6.8a), on fixtures made here inside a
 * rollback transaction (helpers/salesFlowFixture.ts: goods in through the real STT service, goods
 * out through the real delivery order service). The four PRD acceptances:
 * - the form opened at GKP 10.000, then 2.000 left (a delivery stands in for the production run:
 *   any posted outflow moves the stock the same way); the GKP line is unchanged and not sent: no
 *   GKP line, no variance;
 * - a GKP line sent with expected 10.000 while the stock is 8.000: 409 OPNAME_STOCK_CHANGED naming
 *   the line, nothing stored; sent again with 8.000 it posts the deficit at the ledger's cost;
 * - a count dated 30 Jun entered after a 2 Jul receipt of 2.000 (the year end of the PRD example
 *   moved to a month end: one fixture year), physical 8.000: variance 0; a deficit on that date
 *   is dated 30 Jun;
 * - no warehouse: 400 (and a unit cost on a line: 400, owner decision #8).
 * Plus: GET /system-stock as of a day; a cancel takes the count back and a second cancel moves
 * nothing; a surplus cancelled after goods of the item went out at a blended average gets the
 * value true-up against COGS (trueUp 'replay', PR-6.5a's rule, opted into here); a legacy count
 * without a warehouse still cancels.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2117.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import { bookOf, createSalesFlowWorld, deliver, glBalance, receiveStock, type SalesFlowWorld } from '../helpers/salesFlowFixture';
import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { systemAccounts } from '../../services/systemAccounts';
import { sourceKeys } from '../../services/ledger/journalSource';

const state = vi.hoisted(() => ({ tx: null as Tx | null, today: null as string | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
// "Today" (the day of a cancel's true-up journal, owner decision #3) is a day of the fixture year.
vi.mock('../../utils/businessDate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/businessDate')>();
  return { ...actual, businessToday: (...args: Parameters<typeof actual.businessToday>) => state.today ?? actual.businessToday(...args) };
});

import stockOpnameRouter, { OPNAME_STOCK_CHANGED } from '../../routes/stockOpname';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2117;
const day = (md: string) => `${YEAR}-${md}`;

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
  /** A second item on the same inventory account. */
  bran: { id: string; name: string };
}

async function inWorld(fn: (tx: Tx, w: World) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      state.today = day('09-15');
      try {
        const base = await createSalesFlowWorld(tx, YEAR);
        const variance = await tx.account.create({
          data: { name: 'IT-OA Selisih Persediaan', accountNumber: `IT-OA-VAR-${Date.now().toString(36)}`, accountType: 'EXPENSE', rootType: 'EXPENSE' },
        });
        await tx.systemAccountMapping.deleteMany({ where: { role: 'INVENTORY_VARIANCE' } });
        await tx.systemAccountMapping.create({ data: { role: 'INVENTORY_VARIANCE', accountId: variance.id } });
        systemAccounts.invalidateCache();
        const bran = await tx.inventoryItem.create({
          data: { code: `OA-BKT-${Date.now().toString(36)}`, name: 'Bekatul OA', unit: 'kg', isActive: true, accountId: base.accounts.inventory.id },
        });
        const w = { ...base, variance, bran: { id: bran.id, name: bran.name } };
        await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id, w.bran.id], { warehouses: true });
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

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);

/** Goods of the second item in through the real STT service (the journal of receiveStock). */
async function receiveBran(tx: Tx, w: World, qty: number, avg: number, on: string) {
  await submitGoodsReceiptInTx(tx, {
    date: on,
    partyId: w.supplier.id,
    items: [{ inventoryItemId: w.bran.id, warehouseId: w.warehouseA.id, itemName: w.bran.name, quantity: qty, unit: 'kg', lockedUnitCost: avg }],
  }, w.userId);
}

interface CountLine { itemId: string; actualStock: number; expectedSystemStock?: number; unitCost?: number }

function postCount(w: World, on: string, items: CountLine[], opts: { noWarehouse?: boolean } = {}) {
  const warehouseId = opts.noWarehouse ? undefined : w.warehouseA.id;
  return callRoute(stockOpnameRouter, 'post', '/', { userId: w.userId, body: { date: on, warehouseId, items } });
}

async function systemStock(w: World, on: string) {
  const res = await callRoute(stockOpnameRouter, 'get', '/system-stock', { query: { warehouseId: w.warehouseA.id, date: on } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows = res.body.items as { itemId: string; systemStock: number }[];
  return (itemId: string) => rows.find((r) => r.itemId === itemId)?.systemStock;
}

async function cancelCount(tx: Tx, id: string) {
  const { userId, role } = await createCapUser(tx, ['doc.cancel']);
  return callRoute(stockOpnameRouter, 'put', '/:id/cancel', { params: { id }, userId, role });
}

const countRows = (tx: Tx, opnameId: string) =>
  tx.stockMovement.findMany({ where: { referenceType: 'StockOpname', referenceId: opnameId }, orderBy: { createdAt: 'asc' } });

d('stock count as of its date (E3-R11, PR-6.8a)', () => {
  it('an unchanged line is not sent: 2.000 left after the form loaded 10.000, the GKP stock and book are untouched', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 10_000, avg: 6_000, day: day('03-02') });
      await receiveBran(tx, w, 50, 2_000, day('03-02'));
      const shown = await systemStock(w, day('03-10'));
      expect([shown(w.item.id), shown(w.bran.id)]).toEqual([10_000, 50]);

      await deliver(tx, w, day('03-10'), [{ qty: 2_000 }]);
      const res = await postCount(w, day('03-10'), [{ itemId: w.bran.id, actualStock: 45, expectedSystemStock: shown(w.bran.id) }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const lines = await tx.stockOpnameItem.findMany({ where: { stockOpnameId: res.body.id } });
      expect(lines.map((l) => [l.itemId, l.systemStock.toFixed(3), l.actualStock.toFixed(3), l.difference.toFixed(3), l.warehouseId]))
        .toEqual([[w.bran.id, '50.000', '45.000', '-5.000', w.warehouseA.id]]);
      expect((await countRows(tx, res.body.id)).map((r) => [r.itemId, r.movementType, money(r.valueDelta.toString())]))
        .toEqual([[w.bran.id, 'AdjustmentOut', '-10000.00']]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '8000.000', value: '48000000.00', average: '6000.000000' });
      // The count's journal went through postJournal: a system document of the deficit, against the variance leaf.
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${res.body.opnameNumber}` }, include: { items: true } });
      expect(je.sourceType).toBe('SYSTEM_DOC');
      expect(je.items.map((l) => [l.accountId, money(l.debit.toString()), money(l.credit.toString())]).sort()).toEqual([
        [w.accounts.inventory.id, '0.00', '10000.00'], [w.variance.id, '10000.00', '0.00'],
      ].sort());
      // Inventory GL = book of both items (48.000.000 + 90.000) + the 12.000.000 of the delivery,
      // which leaves the GL only when it is invoiced.
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('60090000.00');
    });
  });

  it('a changed line with expected 10.000 while the stock is 8.000 is refused 409 and stores nothing; with 8.000 it posts', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 10_000, avg: 6_000, day: day('03-02') });
      await deliver(tx, w, day('03-10'), [{ qty: 2_000 }]);

      const refused = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 7_900, expectedSystemStock: 10_000 }]);
      expect([refused.status, refused.body.code]).toEqual([409, OPNAME_STOCK_CHANGED]);
      expect(refused.body.items).toEqual([{ itemId: w.item.id, itemName: w.item.name, expectedSystemStock: '10000', systemStock: '8000' }]);
      expect(await tx.stockOpname.count({ where: { fiscalYearId: w.fyId } })).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '8000.000', value: '48000000.00', average: '6000.000000' });

      const res = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 7_900, expectedSystemStock: 8_000 }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [row] = await countRows(tx, res.body.id);
      expect([row!.movementType, row!.quantity.toFixed(3), money(row!.valueDelta.toString()), row!.offsetAccountId])
        .toEqual(['AdjustmentOut', '100.000', '-600000.00', w.variance.id]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '7900.000', value: '47400000.00', average: '6000.000000' });
      // Book + the unbilled delivery (12.000.000): the count moved the GL by exactly its deficit.
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('59400000.00');
      expect(money(await glBalance(tx, w.variance.id))).toBe('600000.00');
    });
  });

  it('a count dated 30 Jun entered after a 2 Jul receipt of 2.000 sees 8.000: physical 8.000 is variance 0; a deficit is dated 30 Jun', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 8_000, avg: 6_000, day: day('06-10') });
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 2_000, avg: 6_000, day: day('07-02') });
      const shown = await systemStock(w, day('06-30'));
      expect(shown(w.item.id)).toBe(8_000);
      expect((await systemStock(w, day('07-02')))(w.item.id)).toBe(10_000);

      const even = await postCount(w, day('06-30'), [{ itemId: w.item.id, actualStock: 8_000, expectedSystemStock: 8_000 }]);
      expect(even.status, JSON.stringify(even.body)).toBe(201);
      const line = await tx.stockOpnameItem.findFirstOrThrow({ where: { stockOpnameId: even.body.id } });
      expect([line.systemStock.toFixed(3), line.difference.toFixed(3), line.movementId]).toEqual(['8000.000', '0.000', null]);
      expect(await countRows(tx, even.body.id)).toEqual([]);
      expect(await tx.journalEntry.count({ where: { entryNumber: `JV-${even.body.opnameNumber}` } })).toBe(0);

      const short = await postCount(w, day('06-30'), [{ itemId: w.item.id, actualStock: 7_500, expectedSystemStock: 8_000 }]);
      expect(short.status, JSON.stringify(short.body)).toBe(201);
      const [row] = await countRows(tx, short.body.id);
      expect([row!.movementType, row!.quantity.toFixed(3), row!.date.toISOString().slice(0, 10)]).toEqual(['AdjustmentOut', '500.000', day('06-30')]);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '9500.000', value: '57000000.00', average: '6000.000000' });
      expect((await systemStock(w, day('06-30')))(w.item.id)).toBe(7_500);
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('57000000.00');
    });
  });

  it('refuses a count without a warehouse or with a unit cost on a line (400), storing nothing', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 6_000, day: day('03-02') });
      const noWarehouse = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 90, expectedSystemStock: 100 }], { noWarehouse: true });
      expect(noWarehouse.status).toBe(400);
      expect(noWarehouse.body.error).toMatch(/Gudang opname wajib dipilih/);
      const withCost = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 100, expectedSystemStock: 100, unitCost: 7_000 }]);
      expect(withCost.status).toBe(400);
      expect(withCost.body.error).toMatch(/Nilai satuan tidak dapat diubah lewat stok opname/);
      const noExpected = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 90 }]);
      expect(noExpected.status).toBe(400);
      expect(await tx.stockOpname.count({ where: { fiscalYearId: w.fyId } })).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '100.000', value: '600000.00', average: '6000.000000' });
    });
  });

  it('a cancel takes the count back through the value ledger; a second cancel moves nothing', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 6_000, day: day('03-02') });
      const res = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 130, expectedSystemStock: 100 }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '130.000', value: '780000.00', average: '6000.000000' });

      const first = await cancelCount(tx, res.body.id);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const second = await cancelCount(tx, res.body.id);
      expect(second.status).toBe(400);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '100.000', value: '600000.00', average: '6000.000000' });
      expect(await tx.stockMovement.count({ where: { referenceType: 'StockOpname', referenceId: res.body.id, isCancelled: false } })).toBe(0);
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('600000.00');
      expect(money(await glBalance(tx, w.variance.id))).toBe('0.00');
    });
  });

  it('a surplus cancelled after goods went out at a blended average replays the item: true-up -29.347,83 against COGS', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 6_000, day: day('03-02') });
      const res = await postCount(w, day('03-10'), [{ itemId: w.item.id, actualStock: 130, expectedSystemStock: 100 }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 9_000, day: day('03-12') });
      await deliver(tx, w, day('03-14'), [{ qty: 150 }]);
      // 230 kg 1.680.000 -> 150 out: 1.095.652,17; 80 kg 584.347,83 left (average re-derived from the value).
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '80.000', value: '584347.83', average: '7304.347875' });

      const cancel = await cancelCount(tx, res.body.id);
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      // Without the surplus: 200 kg at 7.500, 150 out = 1.125.000, 50 kg 375.000 left.
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '50.000', value: '375000.00', average: '7500.000000' });
      const surplus = (await countRows(tx, res.body.id)).find((r) => r.movementType === 'AdjustmentIn')!;
      const trueUp = await tx.stockMovement.findFirstOrThrow({ where: { movementType: 'Revaluation', adjustsMovementId: surplus.id } });
      expect([money(trueUp.valueDelta.toString()), trueUp.date.toISOString().slice(0, 10)]).toEqual(['-29347.83', day('09-15')]);
      const je = await tx.journalEntry.findFirstOrThrow({ where: { sourceKey: sourceKeys.inventoryTrueUp(surplus.id) }, include: { items: true } });
      expect(je.items.map((l) => [l.accountId, money(l.debit.toString()), money(l.credit.toString())]).sort()).toEqual([
        [w.accounts.cogs.id, '29347.83', '0.00'], [w.accounts.inventory.id, '0.00', '29347.83'],
      ].sort());
      // The count's own journal is void: the variance account is back to 0.
      expect(money(await glBalance(tx, w.variance.id))).toBe('0.00');
    });
  });

  it('a legacy count without a warehouse (before E3-R11) still cancels', async () => {
    await inWorld(async (tx, w) => {
      const so = await tx.stockOpname.create({
        data: {
          opnameNumber: `IT-OA-SO-${Date.now().toString(36)}`, date: new Date(day('03-10')), status: 'Submitted',
          fiscalYearId: w.fyId, createdById: w.userId, submittedAt: new Date(day('03-10')), warehouseId: null,
          items: { create: [{ itemId: w.item.id, systemStock: 0, actualStock: 0, difference: 0 }] },
        },
      });
      const res = await cancelCount(tx, so.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: so.id } })).status).toBe('Cancelled');
    });
  });
});
