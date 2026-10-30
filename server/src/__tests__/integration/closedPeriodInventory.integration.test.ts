/**
 * Integration test: inventory, production and delivery note edits and cancels respect a closed
 * fiscal year (E1-R2).
 *
 * Each case posts its documents while year Y is open, closes Y, then tries the edit or cancel. It
 * must fail with 400 / BusinessError PERIOD_CLOSED and leave stock, movements, journals, ledger
 * entries and balances as they were. Route handlers and services run through the route harness,
 * whose `$transaction` is a savepoint, so a rejected call rolls back its own partial writes the way
 * production does. Everything runs in a rollback transaction in far-future years.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { BusinessError } from '../../utils/errors';
import { PERIOD_CLOSED } from '../../utils/periodGuard';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import { submitProductionRunInTx } from '../../services/productionRunSubmit';
import { cancelProductionRunInTx } from '../../services/productionRunCancel';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { editDeliveryOrderInTx, DELIVERY_ORDER_MONTH_CHANGE } from '../../services/deliveryOrderEdit';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';
import { submitStockTransferInTx, cancelStockTransferInTx } from '../../services/stockTransfer';
import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';
import { queueEditApproval } from '../../services/approvalEditRequests';
import { decideApproval } from '../../services/approvalDecision';
import movementsRouter from '../../routes/inventory/movements';
import stockOpnameRouter from '../../routes/stockOpname';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;
let warehouseId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
  const wh = await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!wh) throw new Error('No active warehouse.');
  warehouseId = wh.id;
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

/** The year whose documents are posted and then closed, and the open year after it. */
const Y = 2093;

async function years(tx: Tx): Promise<{ old: FiscalYear; next: FiscalYear }> {
  return { old: await createFiscalYear(tx, { year: Y }), next: await createFiscalYear(tx, { year: Y + 1 }) };
}

function close(tx: Tx, fy: FiscalYear) {
  return tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
}

/** A service call in its own savepoint, like the route transaction that wraps it in production. */
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

function expectPeriodClosed(r: RouteResult) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(PERIOD_CLOSED);
  expect(r.body.error).toMatch(/sudah ditutup/);
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** An active inventory item with `stock` on hand in the test warehouse. */
async function stockItem(tx: Tx, stock: number, averageCost: number) {
  const item = await tx.inventoryItem.create({
    data: { code: `IT-E1R2-${tag()}`, name: `Uji tutup buku ${tag()}`, unit: 'kg', currentStock: stock, averageCost, isActive: true },
  });
  await tx.inventoryStock.create({ data: { itemId: item.id, warehouseId, currentStock: stock } });
  return item;
}

function party(tx: Tx, partyType: 'Customer' | 'Supplier') {
  return tx.party.create({ data: { name: `IT-E1R2-${partyType}-${tag()}`, partyType, isActive: true } });
}

/** Stock, movements, journals, ledger entries and balances for a before/after compare. */
async function snapshot(tx: Tx, itemIds: string[], journalIds: string[]) {
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, currentStock: true, averageCost: true },
    orderBy: { id: 'asc' },
  });
  const stocks = await tx.inventoryStock.findMany({
    where: { itemId: { in: itemIds } },
    select: { itemId: true, warehouseId: true, currentStock: true },
    orderBy: [{ itemId: 'asc' }, { warehouseId: 'asc' }],
  });
  const movements = await tx.stockMovement.findMany({
    where: { itemId: { in: itemIds } },
    select: { id: true, isCancelled: true, date: true, fiscalYearId: true, journalEntryId: true },
    orderBy: { id: 'asc' },
  });
  const journals = await tx.journalEntry.findMany({
    where: { id: { in: journalIds } },
    select: { id: true, status: true, cancelledAt: true },
    orderBy: { id: 'asc' },
  });
  const ale = await tx.accountingLedgerEntry.findMany({
    where: { referenceId: { in: journalIds } },
    select: { id: true, isCancelled: true },
    orderBy: { id: 'asc' },
  });
  const lines = await tx.journalItem.findMany({ where: { journalEntryId: { in: journalIds } }, select: { accountId: true } });
  const balances = await tx.account.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.accountId))] } },
    select: { id: true, balance: true },
    orderBy: { id: 'asc' },
  });
  return {
    items: items.map((i) => ({ ...i, currentStock: i.currentStock.toString(), averageCost: i.averageCost.toString() })),
    stocks: stocks.map((s) => ({ ...s, currentStock: s.currentStock.toString() })),
    movements,
    journals,
    ale,
    balances: balances.map((b) => ({ id: b.id, balance: b.balance.toString() })),
  };
}

async function journalIdsOf(tx: Tx, documentNumber: string): Promise<string[]> {
  const rows = await tx.journalEntry.findMany({ where: { entryNumber: { startsWith: `JV-${documentNumber}` } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** POST /inventory/movements; returns the created movement. */
async function postMovement(tx: Tx, body: Record<string, unknown>) {
  const r = await callRoute(movementsRouter, 'post', '/', { body: { warehouseId, ...body }, userId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return tx.stockMovement.findUniqueOrThrow({ where: { id: r.body.id } });
}

d('closed fiscal year: stock movements', () => {
  it('rejects cancelling a 50 jt "Penyesuaian Stok -" of 20 Dec; stock, journal and balances unchanged', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const item = await stockItem(tx, 10_000, 10_000);
      const mov = await postMovement(tx, { itemId: item.id, movementType: 'AdjustmentOut', quantity: 5_000, unitCost: 10_000, date: `${Y}-12-20` });
      expect(Number(mov.totalValue)).toBe(50_000_000);
      expect(mov.journalEntryId).not.toBeNull();
      await close(tx, old);

      const before = await snapshot(tx, [item.id], [mov.journalEntryId!]);
      expectPeriodClosed(await callRoute(movementsRouter, 'put', '/:id/cancel', { params: { id: mov.id }, userId }));
      expect(await snapshot(tx, [item.id], [mov.journalEntryId!])).toEqual(before);
    });
  });

  it('rejects moving a 20 Dec movement of a closed year to 5 Jan', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const item = await stockItem(tx, 10_000, 10_000);
      const mov = await postMovement(tx, { itemId: item.id, movementType: 'AdjustmentOut', quantity: 5_000, unitCost: 10_000, date: `${Y}-12-20` });
      await close(tx, old);

      const before = await snapshot(tx, [item.id], [mov.journalEntryId!]);
      expectPeriodClosed(await callRoute(movementsRouter, 'put', '/:id', {
        params: { id: mov.id },
        body: { movementType: 'AdjustmentOut', quantity: 5_000, unitCost: 10_000, date: `${Y + 1}-01-05` },
        userId,
      }));
      expect(await snapshot(tx, [item.id], [mov.journalEntryId!])).toEqual(before);
    });
  });

  it('rejects moving an open-year movement into a closed year, also without a journal (unit cost 0)', async () => {
    await inRollback(async (tx) => {
      const { old, next } = await years(tx);
      const item = await stockItem(tx, 100, 0);
      const mov = await postMovement(tx, { itemId: item.id, movementType: 'AdjustmentIn', quantity: 10, unitCost: 0, date: `${Y + 1}-01-10` });
      expect(mov.journalEntryId).toBeNull();
      expect(mov.fiscalYearId).toBe(next.id);
      await close(tx, old);

      const before = await snapshot(tx, [item.id], []);
      expectPeriodClosed(await callRoute(movementsRouter, 'put', '/:id', {
        params: { id: mov.id },
        body: { movementType: 'AdjustmentIn', quantity: 10, unitCost: 0, date: `${Y}-12-20` },
        userId,
      }));
      expect(await snapshot(tx, [item.id], [])).toEqual(before);
    });
  });

  it('moves an open-year movement edited into the next year to that fiscal year', async () => {
    await inRollback(async (tx) => {
      const { old, next } = await years(tx);
      const item = await stockItem(tx, 100, 1_000);
      const mov = await postMovement(tx, { itemId: item.id, movementType: 'AdjustmentIn', quantity: 10, unitCost: 1_000, date: `${Y}-12-20` });
      expect(mov.fiscalYearId).toBe(old.id);

      const r = await callRoute(movementsRouter, 'put', '/:id', {
        params: { id: mov.id },
        body: { movementType: 'AdjustmentIn', quantity: 12, unitCost: 1_000, date: `${Y + 1}-01-05` },
        userId,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const edited = await tx.stockMovement.findUniqueOrThrow({ where: { id: mov.id } });
      expect(edited.fiscalYearId).toBe(next.id);
      const newJe = await tx.journalEntry.findUniqueOrThrow({ where: { id: edited.journalEntryId! } });
      expect(newJe.fiscalYearId).toBe(next.id);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: mov.journalEntryId! } })).status).toBe('Cancelled');
    });
  });
});

d('closed fiscal year: stock opname', () => {
  it('rejects cancelling an opname of 20 Dec', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const item = await stockItem(tx, 100, 5_000);
      // Draft opnames block a new one; none should exist in a test database, but stay safe.
      if (await tx.stockOpname.findFirst({ where: { status: 'Draft' } })) return;
      const r = await callRoute(stockOpnameRouter, 'post', '/', {
        body: { date: `${Y}-12-20`, warehouseId, items: [{ itemId: item.id, actualStock: 90 }] },
        userId,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const so = await tx.stockOpname.findUniqueOrThrow({ where: { id: r.body.id } });
      const jeIds = await journalIdsOf(tx, so.opnameNumber);
      expect(jeIds.length).toBeGreaterThan(0);
      await close(tx, old);

      const before = await snapshot(tx, [item.id], jeIds);
      expectPeriodClosed(await callRoute(stockOpnameRouter, 'put', '/:id/cancel', { params: { id: so.id }, userId }));
      expect(await snapshot(tx, [item.id], jeIds)).toEqual(before);
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: so.id } })).status).not.toBe('Cancelled');
    });
  });
});

d('closed fiscal year: production runs', () => {
  async function run(tx: Tx, date: string) {
    const input = await stockItem(tx, 1_000, 5_000);
    const output = await stockItem(tx, 0, 0);
    const pr = await submitProductionRunInTx(
      tx,
      { date, warehouseId, inputs: [{ itemId: input.id, quantity: 100 }], outputs: [{ itemId: output.id, quantity: 60, unitPrice: 9_000 }] },
      userId,
    );
    if (!pr) throw new Error('Production run was not created.');
    return { pr, itemIds: [input.id, output.id], body: { date, warehouseId, inputs: [{ itemId: input.id, quantity: 80 }], outputs: [{ itemId: output.id, quantity: 50, unitPrice: 9_000 }] } };
  }

  it('rejects cancelling a run of 20 Dec', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const { pr, itemIds } = await run(tx, `${Y}-12-20`);
      const jeIds = await journalIdsOf(tx, pr.runNumber);
      expect(jeIds.length).toBeGreaterThan(0);
      await close(tx, old);

      const before = await snapshot(tx, itemIds, jeIds);
      expect(await codeOf(inRouteTx((t) => cancelProductionRunInTx(t, pr.id)))).toBe(PERIOD_CLOSED);
      expect(await snapshot(tx, itemIds, jeIds)).toEqual(before);
      expect((await tx.productionRun.findUniqueOrThrow({ where: { id: pr.id } })).isCancelled).toBe(false);
    });
  });

  it('rejects editing a run of 20 Dec, and moving it to 5 Jan', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const { pr, itemIds, body } = await run(tx, `${Y}-12-20`);
      const jeIds = await journalIdsOf(tx, pr.runNumber);
      await close(tx, old);

      const before = await snapshot(tx, itemIds, jeIds);
      expect(await codeOf(inRouteTx((t) => editProductionRunInTx(t, pr.id, body, userId)))).toBe(PERIOD_CLOSED);
      expect(await codeOf(inRouteTx((t) => editProductionRunInTx(t, pr.id, { ...body, date: `${Y + 1}-01-05` }, userId)))).toBe(PERIOD_CLOSED);
      expect(await snapshot(tx, itemIds, jeIds)).toEqual(before);
    });
  });

  it('refuses to queue an edit of a closed-year run, and an approved edit fails with PERIOD_CLOSED while the request stays Pending', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const { pr, itemIds, body } = await run(tx, `${Y}-12-20`);
      const jeIds = await journalIdsOf(tx, pr.runNumber);
      // Queued while the year was still open.
      const request = await tx.approvalRequest.create({
        data: {
          documentType: 'ProductionRunEdit',
          documentId: pr.id,
          documentNumber: pr.runNumber,
          amount: 80,
          payload: body,
          requestedBy: userId,
          status: 'Pending',
        },
      });
      await close(tx, old);

      const queued = await queueEditApproval(appPrisma, { documentType: 'ProductionRunEdit', targetId: pr.id, body, rawBody: body, userId });
      expect(queued).toMatchObject({ ok: false, status: 400, code: PERIOD_CLOSED });
      expect(await tx.approvalRequest.count({ where: { documentType: 'ProductionRunEdit', documentId: pr.id } })).toBe(1);

      const before = await snapshot(tx, itemIds, jeIds);
      const decided = await decideApproval({ requestId: request.id, action: 'approve', actorUserId: userId });
      expect(decided).toMatchObject({ ok: false, code: PERIOD_CLOSED });
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('Pending');
      expect(await snapshot(tx, itemIds, jeIds)).toEqual(before);
    });
  });
});

d('closed fiscal year: delivery notes', () => {
  async function deliveryOrder(tx: Tx, date: string) {
    const item = await stockItem(tx, 10_000, 9_000);
    const customer = await party(tx, 'Customer');
    const lines = (quantity: number) => [{ inventoryItemId: item.id, warehouseId, itemName: item.name, quantity, unit: 'kg' }];
    const doc = await submitDeliveryOrderInTx(tx, { date, partyId: customer.id, items: lines(10_000) }, userId);
    return { doc, itemIds: [item.id], body: (d: string, quantity = 8_000) => ({ date: d, partyId: customer.id, items: lines(quantity) }) };
  }

  it('rejects editing a note of 28 Dec to 2 Jan, and cancelling it', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const { doc, itemIds, body } = await deliveryOrder(tx, `${Y}-12-28`);
      await close(tx, old);

      const before = await snapshot(tx, itemIds, []);
      expect(await codeOf(inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(`${Y + 1}-01-02`), userId)))).toBe(PERIOD_CLOSED);
      expect(await codeOf(inRouteTx((t) => cancelDeliveryOrderInTx(t, doc.id)))).toBe(PERIOD_CLOSED);
      expect(await snapshot(tx, itemIds, [])).toEqual(before);
      expect((await tx.deliveryOrder.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('Submitted');
    });
  });

  it('rejects moving a note to another month while both years are open', async () => {
    await inRollback(async (tx) => {
      await years(tx);
      const { doc, body } = await deliveryOrder(tx, `${Y}-12-28`);
      expect(await codeOf(inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(`${Y + 1}-01-02`), userId)))).toBe(DELIVERY_ORDER_MONTH_CHANGE);
      expect(await codeOf(inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(`${Y}-11-30`), userId)))).toBe(DELIVERY_ORDER_MONTH_CHANGE);
    });
  });

  it('an edit within the month sets the header fiscal year from the date', async () => {
    await inRollback(async (tx) => {
      const { old, next } = await years(tx);
      const { doc, body } = await deliveryOrder(tx, `${Y}-12-28`);
      // A stale fiscal year left by an older cross-year edit.
      await tx.deliveryOrder.update({ where: { id: doc.id }, data: { fiscalYearId: next.id } });

      await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, body(`${Y}-12-30`), userId));
      const edited = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: doc.id } });
      expect(edited.fiscalYearId).toBe(old.id);
    });
  });
});

d('closed fiscal year: stock transfers and goods receipts', () => {
  it('rejects cancelling a stock transfer of 20 Dec', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const item = await stockItem(tx, 1_000, 5_000);
      const dest = await tx.warehouse.create({ data: { code: `IT-E1R2-${tag()}`, name: 'Gudang uji tutup buku' } });
      const transfer = await submitStockTransferInTx(
        tx,
        { date: `${Y}-12-20`, fromWarehouseId: warehouseId, toWarehouseId: dest.id, items: [{ itemId: item.id, quantity: 400 }] },
        userId,
      );
      await close(tx, old);

      const before = await snapshot(tx, [item.id], []);
      expect(await codeOf(inRouteTx((t) => cancelStockTransferInTx(t, transfer.id)))).toBe(PERIOD_CLOSED);
      expect(await snapshot(tx, [item.id], [])).toEqual(before);
    });
  });

  it('rejects cancelling a goods receipt of 20 Dec; no cancel journal is posted', async () => {
    await inRollback(async (tx) => {
      const { old } = await years(tx);
      const item = await stockItem(tx, 0, 0);
      const supplier = await party(tx, 'Supplier');
      const stt = await submitGoodsReceiptInTx(
        tx,
        {
          date: `${Y}-12-20`,
          partyId: supplier.id,
          items: [{ inventoryItemId: item.id, warehouseId, itemName: item.name, quantity: 1_000, unit: 'kg', lockedUnitCost: 5_000 }],
        },
        userId,
      );
      const jeIds = await journalIdsOf(tx, stt.sttNumber);
      expect(jeIds.length).toBe(1);
      await close(tx, old);

      const before = await snapshot(tx, [item.id], jeIds);
      expect(await codeOf(inRouteTx((t) => cancelGoodsReceiptInTx(t, stt.id, userId)))).toBe(PERIOD_CLOSED);
      expect(await snapshot(tx, [item.id], jeIds)).toEqual(before);
      expect(await journalIdsOf(tx, stt.sttNumber)).toEqual(jeIds);
    });
  });
});
