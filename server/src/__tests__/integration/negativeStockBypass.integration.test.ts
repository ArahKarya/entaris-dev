/**
 * Integration test: the negative-stock bypass needs inventory.negative_stock on every path that
 * accepts it (E3-R1), not only doc.cancel or ownership of an approval request:
 * - goods receipt cancel: STT of 10.000 kg, 8.000 kg leave by a manual "Penyesuaian Stok -"
 *   (no sourceMovementId, so the consumed-batch guard does not fire). A forced cancel by a doc.cancel
 *   holder is 403 and changes nothing; with inventory.negative_stock the stock check passes and the
 *   value ledger takes the receipt back with its true-up (PR-6.5a; all at one cost, so 0): stock −8.000;
 * - production run cancel: the same through the body and through ?allowNegativeStock=true (the
 *   output went out since, so with the capability the value ledger refuses it too, until PR-6.12);
 * - production run resubmit with the bypass: 403 and the request stays in NeedsRevision without the
 *   capability, Pending with it.
 *
 * Fixtures are created here (fiscal year 2193, own warehouse, items and supplier). Route handlers
 * run through the route harness; everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { mapProductionLeafAccounts } from '../helpers/productionFixture';
import { systemAccounts } from '../../services/systemAccounts';
import { REVERSAL_NEEDS_TRUE_UP } from '../../services/inventory/inventoryLedger';

const state = vi.hoisted(() => ({ tx: null as Tx | null, today: null as string | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
// "Today" of a cancel's value true-up journal (owner decision #3): the fixture day when set.
vi.mock('../../utils/businessDate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/businessDate')>();
  return { ...actual, businessToday: (...args: Parameters<typeof actual.businessToday>) => state.today ?? actual.businessToday(...args) };
});

import { invalidatePermissionCache } from '../../services/permissionService';
import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { submitProductionRunInTx } from '../../services/productionRunSubmit';
import goodsReceiptsRouter from '../../routes/goodsReceipts';
import productionRunsRouter from '../../routes/inventory/productionRuns';
import movementsRouter from '../../routes/inventory/movements';
import approvalsRouter from '../../routes/approvals';
import { seedStock } from '../helpers/inventoryFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

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

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        // This database may map COGS to a group account, which production posting refuses.
        await mapProductionLeafAccounts(tx);
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** Unique fixture year of this file (plan §5.2). */
const Y = 2193;
const REASON = 'Stok fisik sudah dihitung ulang';
const FORBIDDEN = { error: 'Anda tidak berwenang bypass validasi stok.', code: 'NEGATIVE_STOCK_FORBIDDEN' };

type Actor = { userId: string; role: string };

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Fiscal year Y, an own warehouse and the two actors: doc.cancel only, and doc.cancel + bypass. */
async function setup(tx: Tx) {
  await createFiscalYear(tx, { year: Y });
  const wh = await tx.warehouse.create({ data: { code: `IT-E3R1-${tag()}`, name: `Gudang uji stok minus ${tag()}` } });
  const clerk = await createCapUser(tx, ['doc.cancel']);
  const admin = await createCapUser(tx, ['doc.cancel', 'inventory.negative_stock']);
  return { warehouseId: wh.id, clerk, admin };
}

async function stockItem(tx: Tx, warehouseId: string, stock: number, averageCost: number) {
  const item = await tx.inventoryItem.create({
    data: { code: `IT-E3R1-${tag()}`, name: `Uji stok minus ${tag()}`, unit: 'kg', isActive: true },
  });
  if (stock > 0) await seedStock(tx, { itemId: item.id, warehouseId, qty: stock, avg: averageCost, date: `${Y}-01-02` });
  else await tx.inventoryStock.create({ data: { itemId: item.id, warehouseId, currentStock: 0 } }); // an empty row to read back
  return item;
}

/**
 * A manual "Penyesuaian Stok -" through the movements route: no sourceMovementId. It is valued at
 * the average; its own expense offset keeps the test off the INVENTORY_VARIANCE mapping.
 */
async function adjustOut(tx: Tx, who: Actor, warehouseId: string, itemId: string, quantity: number, unitCost: number) {
  const code = `IT-E3R1-${tag()}`;
  const offset = await tx.account.create({ data: { name: `Lawan ${code}`, accountNumber: code, accountType: 'EXPENSE', rootType: 'EXPENSE' } });
  const r = await callRoute(movementsRouter, 'post', '/', {
    body: { warehouseId, itemId, movementType: 'AdjustmentOut', quantity, unitCost, date: `${Y}-03-12`, offsetAccountId: offset.id },
    userId: who.userId,
    role: who.role,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: r.body.id } });
  expect(mov.sourceMovementId).toBeNull();
}

/** Item-level and warehouse-level stock of `itemId`. */
async function stockOf(tx: Tx, itemId: string, warehouseId: string) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { currentStock: true } });
  const wh = await tx.inventoryStock.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId, warehouseId } }, select: { currentStock: true } });
  return { item: Number(item.currentStock), warehouse: Number(wh.currentStock) };
}

function expectForbidden(r: RouteResult) {
  expect(r.status, JSON.stringify(r.body)).toBe(403);
  expect(r.body).toEqual(FORBIDDEN);
}

d('goods receipt cancel with the negative-stock bypass', () => {
  it('needs inventory.negative_stock; doc.cancel alone changes nothing', async () => {
    await inRollback(async (tx) => {
      const { warehouseId, clerk, admin } = await setup(tx);
      const item = await stockItem(tx, warehouseId, 0, 0);
      const supplier = await tx.party.create({ data: { name: `IT-E3R1-Supplier-${tag()}`, partyType: 'Supplier', isActive: true } });
      const stt = await submitGoodsReceiptInTx(
        tx,
        {
          date: `${Y}-03-10`,
          partyId: supplier.id,
          items: [{ inventoryItemId: item.id, warehouseId, itemName: item.name, quantity: 10_000, unit: 'kg', lockedUnitCost: 5_000 }],
        },
        clerk.userId,
      );
      await adjustOut(tx, clerk, warehouseId, item.id, 8_000, 5_000);
      expect(await stockOf(tx, item.id, warehouseId)).toEqual({ item: 2_000, warehouse: 2_000 });

      const cancel = (who: Actor) => callRoute(goodsReceiptsRouter, 'post', '/:id/cancel', {
        params: { id: stt.id },
        body: { allowNegativeStock: true, negativeStockReason: REASON },
        userId: who.userId,
        role: who.role,
      });

      expectForbidden(await cancel(clerk));
      expect(await stockOf(tx, item.id, warehouseId)).toEqual({ item: 2_000, warehouse: 2_000 });
      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } })).status).not.toBe('Cancelled');

      // Without the bypass the doc.cancel holder gets the insufficient-stock refusal, as before.
      const plain = await callRoute(goodsReceiptsRouter, 'post', '/:id/cancel', { params: { id: stt.id }, body: {}, userId: clerk.userId, role: clerk.role });
      expect(plain.status).toBe(400);
      expect(plain.body.code).toBe('GR_CANCEL_INSUFFICIENT_STOCK');

      // The bypass passes the stock check. 8.000 kg of the receipt went out since, so the value
      // ledger replays the item (PR-6.5a): without the receipt the item never had a cost, so the
      // 8.000 went out at average 0. The true-up brings their 40.000.000 back from COGS (one
      // journal on the day of the cancel) and the stock goes to −8.000 at value 0.
      state.today = `${Y}-03-20`;
      const forced = await cancel(admin).finally(() => { state.today = null; });
      expect(forced.status, JSON.stringify(forced.body)).toBe(200);
      expect(await stockOf(tx, item.id, warehouseId)).toEqual({ item: -8_000, warehouse: -8_000 });
      expect((await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).stockValue.toFixed(2)).toBe('0.00');
      const trueUp = await tx.stockMovement.findFirstOrThrow({ where: { itemId: item.id, movementType: 'Revaluation', isCancelled: false } });
      expect(trueUp.valueDelta.toFixed(2)).toBe('40000000.00');
      expect(trueUp.journalEntryId).not.toBeNull();
      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } })).status).toBe('Cancelled');
    });
  });
});

d('production run cancel with the negative-stock bypass', () => {
  /** A posted run whose 60 kg output was mostly used: 50 kg left by a manual adjustment. */
  async function usedRun(tx: Tx, warehouseId: string, who: Actor) {
    const input = await stockItem(tx, warehouseId, 1_000, 5_000);
    const output = await stockItem(tx, warehouseId, 0, 0);
    const run = await submitProductionRunInTx(
      tx,
      { date: `${Y}-03-10`, warehouseId, inputs: [{ itemId: input.id, quantity: 100 }], outputs: [{ itemId: output.id, quantity: 60, unitPrice: 9_000 }] },
      who.userId,
    );
    if (!run) throw new Error('Production run was not created.');
    await adjustOut(tx, who, warehouseId, output.id, 50, 9_000);
    expect(await stockOf(tx, output.id, warehouseId)).toEqual({ item: 10, warehouse: 10 });
    return { run, output };
  }

  it('refuses the bypass from the body or the query to a doc.cancel holder', async () => {
    await inRollback(async (tx) => {
      const { warehouseId, clerk } = await setup(tx);
      const { run, output } = await usedRun(tx, warehouseId, clerk);

      expectForbidden(await callRoute(productionRunsRouter, 'put', '/:id/cancel', {
        params: { id: run.id }, body: { allowNegativeStock: true, negativeStockReason: REASON }, userId: clerk.userId, role: clerk.role,
      }));
      expectForbidden(await callRoute(productionRunsRouter, 'put', '/:id/cancel', {
        params: { id: run.id }, query: { allowNegativeStock: 'true' }, body: { negativeStockReason: REASON }, userId: clerk.userId, role: clerk.role,
      }));

      expect((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).isCancelled).toBe(false);
      expect(await stockOf(tx, output.id, warehouseId)).toEqual({ item: 10, warehouse: 10 });
    });
  });

  it('lets a holder of inventory.negative_stock past the stock check; the value ledger then refuses', async () => {
    await inRollback(async (tx) => {
      const { warehouseId, clerk, admin } = await setup(tx);
      const { run, output } = await usedRun(tx, warehouseId, clerk);

      // 50 kg of the output went out since: on the value ledger taking its value back needs a value
      // true-up (PR-6.12), so the cancel is refused until then and nothing changes.
      const r = await callRoute(productionRunsRouter, 'put', '/:id/cancel', {
        params: { id: run.id }, query: { allowNegativeStock: 'true' }, body: { negativeStockReason: REASON }, userId: admin.userId, role: admin.role,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe(REVERSAL_NEEDS_TRUE_UP);
      expect((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).isCancelled).toBe(false);
      expect(await stockOf(tx, output.id, warehouseId)).toEqual({ item: 10, warehouse: 10 });
    });
  });
});

d('production run resubmit with the negative-stock bypass', () => {
  it('stays in NeedsRevision without inventory.negative_stock; goes to Pending with it', async () => {
    await inRollback(async (tx) => {
      const { warehouseId } = await setup(tx);
      const staff = await createCapUser(tx, []);
      const approver = await createCapUser(tx, ['approval.decide']);
      const supervisor = await createCapUser(tx, ['approval.view_all', 'inventory.negative_stock']);
      const input = await stockItem(tx, warehouseId, 0, 0);
      const output = await stockItem(tx, warehouseId, 0, 0);
      const req = await tx.approvalRequest.create({
        data: {
          documentType: 'ProductionRun',
          status: 'NeedsRevision',
          amount: 999,
          payload: { old: true },
          requestedBy: staff.userId,
          rejectedBy: approver.userId,
          decidedAt: new Date(`${Y}-03-11T03:00:00Z`),
        },
      });
      const payload = {
        date: `${Y}-03-12`,
        warehouseId,
        inputs: [{ itemId: input.id, quantity: 100 }],
        outputs: [{ itemId: output.id, quantity: 60 }],
        allowNegativeStock: true,
        negativeStockReason: REASON,
      };
      const resubmit = (who: Actor) => callRoute(approvalsRouter, 'put', '/requests/:id/resubmit', {
        params: { id: req.id }, body: { payload }, userId: who.userId, role: who.role,
      });

      expectForbidden(await resubmit(staff));
      const kept = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(kept.status).toBe('NeedsRevision');
      expect(kept.payload).toEqual({ old: true });
      expect(Number(kept.amount)).toBe(999);

      const ok = await resubmit(supervisor);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const row = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(row.status).toBe('Pending');
      expect(row.payload).toEqual(payload);
    });
  });
});
