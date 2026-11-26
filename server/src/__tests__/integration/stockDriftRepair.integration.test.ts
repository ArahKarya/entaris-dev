/**
 * Integration test: item vs warehouse drift repair (owner decision #18, PR-6.3d).
 * GKP holds 1.000 kg at 5.000 in warehouse A plus 100 kg on the item total that no warehouse holds
 * (a legacy movement without a warehouse): drift 100 kg, value 500.000.
 * - the dry-run list shows the drift, its value and the movement without a warehouse;
 * - `assign` A: the warehouse row rises, the item total and the GL stay, drift 0, one audit row;
 * - `writeoff`: an Adjustment − without a warehouse at the average, DR Inventory Variance 500.000 /
 *   CR the item's inventory account 500.000 (SYSTEM_DOC), drift 0; the row is locked per row;
 * - a split plan, an item without a cost (no journal), a negative drift assigned out of a warehouse;
 * - refused: Inventory Variance mapped to the rounding account, a stale plan, an unknown warehouse.
 *
 * Fixtures are created here (fiscal year 2129, own warehouses, item, accounts and the
 * INVENTORY_VARIANCE / ROUNDING_ACCOUNT mappings). Everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { seedStock, seedUnplacedStock } from '../helpers/inventoryFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import movementsRouter from '../../routes/inventory/movements';
import { INVENTORY_VARIANCE_UNSAFE } from '../../services/inventory/varianceAccount';
import { MOVEMENT_DOCUMENT_LOCKED, STOCK_DRIFT_REFERENCE } from '../../services/documentMovementLock';
import { parseDriftPlanCsv } from '../../services/inventory/stockDriftPlan';
import { applyStockDriftPlan, findStockDrift, STOCK_DRIFT_AUDIT_ACTION } from '../../services/inventory/stockDriftRepair';

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
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** Unique fixture year of this file (plan step 6 §6.3). */
const Y = 2129;
const DAY = `${Y}-06-15`;

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function account(tx: Tx, rootType: 'ASSET' | 'EXPENSE', name: string) {
  const code = `IT-E3DR-${tag()}`;
  return tx.account.create({ data: { name: `${name} ${code}`, accountNumber: code, accountType: rootType, rootType } });
}

/** Points `role` at `accountId` only (inside the rollback). */
async function mapRole(tx: Tx, role: string, accountId: string) {
  await tx.systemAccountMapping.deleteMany({ where: { role } });
  await tx.systemAccountMapping.create({ data: { role, accountId, sortOrder: 0 } });
}

async function newItem(tx: Tx, label: string, accountId: string) {
  return tx.inventoryItem.create({ data: { code: `IT-E3DR-${tag()}`, name: `${label} ${tag()}`, unit: 'Kg', isActive: true, accountId } });
}

/** Year Y, warehouses A and B, an actor with doc.cancel, and GKP: 1.000 kg in A plus 100 kg in no warehouse, both at 5.000. */
async function setup(tx: Tx) {
  const fy = await createFiscalYear(tx, { year: Y });
  const actor = await createCapUser(tx, ['doc.cancel']);
  const whA = await tx.warehouse.create({ data: { code: `IT-E3DR-A-${tag()}`, name: `Gudang A ${tag()}` } });
  const whB = await tx.warehouse.create({ data: { code: `IT-E3DR-B-${tag()}`, name: `Gudang B ${tag()}` } });
  const inventoryAccount = await account(tx, 'ASSET', 'Persediaan GKP');
  const variance = await account(tx, 'EXPENSE', 'Selisih Persediaan');
  const rounding = await account(tx, 'EXPENSE', 'Pembulatan');
  await mapRole(tx, 'INVENTORY_VARIANCE', variance.id);
  await mapRole(tx, 'ROUNDING_ACCOUNT', rounding.id);
  const gkp = await newItem(tx, 'GKP', inventoryAccount.id);
  const seed = { fiscalYearId: fy.id, userId: actor.userId, date: DAY };
  await seedStock(tx, { itemId: gkp.id, warehouseId: whA.id, qty: 1_000, avg: 5_000, ...seed });
  await seedUnplacedStock(tx, { itemId: gkp.id, qty: 100, avg: 5_000, ...seed });
  return { actor, whA, whB, gkp, inventoryAccountId: inventoryAccount.id, varianceId: variance.id, roundingId: rounding.id, seed };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const HEADER = 'item_id,drift,action,warehouse_code,quantity';
function plan(...rows: string[]) {
  const parsed = parseDriftPlanCsv([HEADER, ...rows].join('\n'));
  expect(parsed.errors).toEqual([]);
  return parsed.items;
}

const apply = (tx: Tx, items: ReturnType<typeof plan>) => applyStockDriftPlan(tx, items, { approvedBy: 'Akuntan Uji', day: DAY });

const driftOf = async (tx: Tx, itemId: string) => (await findStockDrift(tx, { itemIds: [itemId] }))[0];

async function stockOf(tx: Tx, s: Setup) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } });
  const rows = await tx.inventoryStock.findMany({ where: { itemId: s.gkp.id } });
  const at = (warehouseId: string) => Number(rows.find((r) => r.warehouseId === warehouseId)?.currentStock ?? 0);
  return { total: Number(item.currentStock), average: Number(item.averageCost), a: at(s.whA.id), b: at(s.whB.id) };
}

/** Active ledger rows on an account as the sum debit − credit. */
async function ledgerNet(tx: Tx, accountId: string): Promise<number> {
  const sums = await tx.accountingLedgerEntry.aggregate({ where: { accountId, isCancelled: false }, _sum: { debit: true, credit: true } });
  return new Decimal(sums._sum.debit?.toString() ?? 0).minus(sums._sum.credit?.toString() ?? 0).toNumber();
}

async function auditRows(tx: Tx, itemId: string) {
  return tx.auditLog.findMany({ where: { action: STOCK_DRIFT_AUDIT_ACTION, entityId: itemId } });
}

d('stock drift report', () => {
  it('lists the drift, its value and the movement without a warehouse', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const row = await driftOf(tx, s.gkp.id);
      expect(row).toMatchObject({ code: s.gkp.code, unwarehousedMovements: 1, warehouses: `${s.whA.code}:1000.000` });
      expect([row.itemQty, row.warehouseQty, row.drift, row.driftValue, row.unwarehousedNetQty].map(String)).toEqual(['1100', '1000', '100', '500000', '100']);
    });
  });

  it('does not count value-only Revaluation rows (no warehouse, quantity 0) as movements without a warehouse', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      for (const [n, referenceType] of [['VB', 'ValuationBaseline'], ['RV', 'PurchaseInvoice']] as const) {
        await tx.stockMovement.create({
          data: {
            movementNumber: `IT-E3DR-${n}-${tag()}`, date: new Date(`${DAY}T00:00:00.000Z`), itemId: s.gkp.id, warehouseId: null,
            movementType: 'Revaluation', quantity: 0, totalValue: 25_000, valueDelta: -25_000, referenceType,
            fiscalYearId: s.seed.fiscalYearId, createdById: s.actor.userId,
          },
        });
      }
      const row = await driftOf(tx, s.gkp.id);
      expect(row).toMatchObject({ unwarehousedMovements: 1 });
      expect(String(row.unwarehousedNetQty)).toBe('100');
    });
  });
});

d('stock drift repair', () => {
  it('assign A: the warehouse row rises, the item total, average and GL stay, drift 0', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const journalsBefore = await tx.journalEntry.count();
      const result = await apply(tx, plan(`${s.gkp.id},100.000,assign,${s.whA.code},`));
      expect(result.items).toMatchObject([{ itemId: s.gkp.id, movementId: null, journalEntryId: null }]);
      expect(await stockOf(tx, s)).toEqual({ total: 1_100, average: 5_000, a: 1_100, b: 0 });
      expect(await driftOf(tx, s.gkp.id)).toBeUndefined();
      expect(await tx.journalEntry.count()).toBe(journalsBefore);
      expect(await ledgerNet(tx, s.inventoryAccountId)).toBe(0);
      const audit = await auditRows(tx, s.gkp.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ via: 'repair', viaMeta: { script: STOCK_DRIFT_AUDIT_ACTION, approvedBy: 'Akuntan Uji' } });
      expect(audit[0].newValues).toMatchObject({ assigned: [{ warehouseCode: s.whA.code, quantity: '100' }], writtenOff: '0' });
    });
  });

  it('writeoff: Adjustment − at the average, DR Inventory Variance / CR inventory 500.000, drift 0', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const result = await apply(tx, plan(`${s.gkp.id},100,writeoff,,`));
      expect(await stockOf(tx, s)).toEqual({ total: 1_000, average: 5_000, a: 1_000, b: 0 });
      expect(await driftOf(tx, s.gkp.id)).toBeUndefined();

      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: result.items[0].movementId! } });
      expect(mov).toMatchObject({ movementType: 'AdjustmentOut', warehouseId: null, referenceType: STOCK_DRIFT_REFERENCE, offsetAccountId: s.varianceId });
      expect([Number(mov.quantity), Number(mov.unitCost), Number(mov.totalValue)]).toEqual([100, 5_000, 500_000]);
      expect(mov.date.toISOString().slice(0, 10)).toBe(DAY);
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: mov.journalEntryId! } });
      expect(je.sourceType).toBe('SYSTEM_DOC');
      expect(await ledgerNet(tx, s.inventoryAccountId)).toBe(-500_000);
      expect(await ledgerNet(tx, s.varianceId)).toBe(500_000);
      for (const id of [s.inventoryAccountId, s.varianceId]) {
        const acc = await tx.account.findUniqueOrThrow({ where: { id } });
        expect(Number(acc.balance), acc.accountNumber).toBe(await ledgerNet(tx, id));
      }
      expect((await auditRows(tx, s.gkp.id))[0].newValues).toMatchObject({ writtenOff: '100', writeOffValue: '500000.00', movementId: mov.id });

      // Undoing it per row would bring the drift back: the manual movement routes refuse.
      for (const [method, path, body] of [['put', '/:id', { date: DAY, movementType: 'AdjustmentOut', quantity: 50 }], ['put', '/:id/cancel', {}]] as const) {
        const r = await callRoute(movementsRouter, method, path, { params: { id: mov.id }, body, userId: s.actor.userId, role: s.actor.role });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.code).toBe(MOVEMENT_DOCUMENT_LOCKED);
      }
    });
  });

  it('splits an item: 30 assigned to B, 70 written off', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const result = await apply(tx, plan(`${s.gkp.id},100,assign,${s.whB.code},30`, `${s.gkp.id},100,writeoff,,70`));
      expect(await stockOf(tx, s)).toEqual({ total: 1_030, average: 5_000, a: 1_000, b: 30 });
      expect(result.items[0].writeOffValue.toNumber()).toBe(350_000);
      expect(await ledgerNet(tx, s.varianceId)).toBe(350_000);
      expect(await auditRows(tx, s.gkp.id)).toHaveLength(1);
    });
  });

  it('writes off an item without a cost without a journal, even while Inventory Variance is unsafe', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await mapRole(tx, 'ROUNDING_ACCOUNT', s.varianceId);
      const bran = await newItem(tx, 'Bekatul', s.inventoryAccountId);
      await seedUnplacedStock(tx, { itemId: bran.id, qty: 812, avg: 0, ...s.seed });
      const result = await apply(tx, plan(`${bran.id},812,writeoff,,`));
      expect(result.items[0]).toMatchObject({ journalEntryId: null });
      expect(result.items[0].writeOffValue.toNumber()).toBe(0);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: bran.id } })).currentStock)).toBe(0);
    });
  });

  it('takes a warehouse excess over the item total back out with a negative assign', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const rice = await newItem(tx, 'Beras', s.inventoryAccountId);
      await seedStock(tx, { itemId: rice.id, warehouseId: s.whA.id, qty: 50, avg: 9_000, ...s.seed });
      // A legacy path took 10 kg off the item total only.
      await tx.inventoryItem.update({ where: { id: rice.id }, data: { currentStock: { decrement: 10 } } });
      expect((await driftOf(tx, rice.id)).drift.toString()).toBe('-10');
      await apply(tx, plan(`${rice.id},-10,assign,${s.whA.code},`));
      expect(Number((await tx.inventoryStock.findFirstOrThrow({ where: { itemId: rice.id, warehouseId: s.whA.id } })).currentStock)).toBe(40);
      expect(await driftOf(tx, rice.id)).toBeUndefined();
    });
  });
});

d('stock drift repair refusals', () => {
  it('refuses a write-off while Inventory Variance shares its account with rounding; stock stays put', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await mapRole(tx, 'ROUNDING_ACCOUNT', s.varianceId);
      await expect(apply(tx, plan(`${s.gkp.id},100,writeoff,,`))).rejects.toMatchObject({ code: INVENTORY_VARIANCE_UNSAFE });
      expect(await stockOf(tx, s)).toEqual({ total: 1_100, average: 5_000, a: 1_000, b: 0 });
      expect(await auditRows(tx, s.gkp.id)).toHaveLength(0);
    });
  });

  it('refuses a stale plan and an unknown warehouse before writing anything', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await expect(apply(tx, plan(`${s.gkp.id},90,writeoff,,`))).rejects.toThrow(/stale.*drift is 100 now, the plan was made for 90/);
      await expect(apply(tx, plan(`${s.gkp.id},100,assign,NO-SUCH-WH,`))).rejects.toThrow(/Unknown warehouse_code: NO-SUCH-WH/);
      expect(await stockOf(tx, s)).toEqual({ total: 1_100, average: 5_000, a: 1_000, b: 0 });
    });
  });

  it('a plan for an item that no longer drifts is stale', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const items = plan(`${s.gkp.id},100,assign,${s.whA.code},`);
      await apply(tx, items);
      await expect(apply(tx, items)).rejects.toThrow(/no drift any more/);
      expect(await stockOf(tx, s)).toEqual({ total: 1_100, average: 5_000, a: 1_100, b: 0 });
    });
  });
});
