/**
 * Integration test: manual stock movement cost and offset (E3-R4, PR-6.3a, owner decision #7).
 * - Stock Out is valued at the item's average, whatever unitCost the client sends (or none);
 * - Adjustment − without an offset debits the Inventory Variance account, and is refused while that
 *   role shares its account with the rounding account (INVENTORY_VARIANCE_UNSAFE);
 * - Stock In needs a unit cost above 0 and an offset; the offset may not be the opening balance
 *   equity, a group, an inactive account or an account in the inventory group;
 * - an edited Out is re-valued at the average after the reversal, also when the item holds stock
 *   without a movement behind it (the replay is skipped); cancel voids the journal;
 * - the journal is a SYSTEM_DOC journal through postJournal, and stored balances follow the ledger.
 *
 * Fixtures are created here (fiscal year 2106, own warehouse, item, accounts and the
 * INVENTORY_VARIANCE / ROUNDING_ACCOUNT mappings). Everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { seedStock } from '../helpers/inventoryFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import movementsRouter from '../../routes/inventory/movements';
import { INVENTORY_VARIANCE_UNSAFE } from '../../services/inventory/varianceAccount';
import { MANUAL_IN_ZERO_COST, OFFSET_REQUIRED } from '../../services/inventory/manualMovement';
import { ACCOUNT_CONTROL, ACCOUNT_GROUP, ACCOUNT_INACTIVE, STOCK_OFFSET_INVENTORY } from '../../services/ledger/accountGuard';

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
const Y = 2106;
const DAY = `${Y}-03-12`;

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type RootType = 'ASSET' | 'EQUITY' | 'EXPENSE';

function account(tx: Tx, rootType: RootType, name: string, extra: { parentId?: string; isGroup?: boolean; isActive?: boolean } = {}) {
  const code = `IT-E3R4-${tag()}`;
  return tx.account.create({ data: { name: `${name} ${code}`, accountNumber: code, accountType: rootType, rootType, ...extra } });
}

/** Points `role` at `accountId` only (inside the rollback). */
async function mapRole(tx: Tx, role: string, accountId: string) {
  await tx.systemAccountMapping.deleteMany({ where: { role } });
  await tx.systemAccountMapping.create({ data: { role, accountId, sortOrder: 0 } });
}

/**
 * Year Y, a warehouse, an actor with doc.cancel, an expense offset, and GKP: 10.000 kg at an
 * average of 6.000 in that warehouse, on its own inventory account. Inventory Variance and rounding
 * are mapped to two separate fixture leaves.
 */
async function setup(tx: Tx) {
  const fy = await createFiscalYear(tx, { year: Y });
  const actor = await createCapUser(tx, ['doc.cancel']);
  const wh = await tx.warehouse.create({ data: { code: `IT-E3R4-${tag()}`, name: `Gudang uji mutasi ${tag()}` } });
  const inventoryAccount = await account(tx, 'ASSET', 'Persediaan GKP');
  const offset = await account(tx, 'EXPENSE', 'Beban lain');
  const variance = await account(tx, 'EXPENSE', 'Selisih Persediaan');
  const rounding = await account(tx, 'EXPENSE', 'Pembulatan');
  await mapRole(tx, 'INVENTORY_VARIANCE', variance.id);
  await mapRole(tx, 'ROUNDING_ACCOUNT', rounding.id);
  const gkp = await tx.inventoryItem.create({
    data: { code: `IT-E3R4-${tag()}`, name: `GKP ${tag()}`, unit: 'Kg', isActive: true, accountId: inventoryAccount.id },
  });
  await seedStock(tx, { itemId: gkp.id, warehouseId: wh.id, qty: 10_000, avg: 6_000, fiscalYearId: fy.id, userId: actor.userId, date: new Date(DAY) });
  return { actor, warehouseId: wh.id, gkp, inventoryAccountId: inventoryAccount.id, offsetId: offset.id, varianceId: variance.id, roundingId: rounding.id };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const post = (s: Setup, body: Record<string, unknown>): Promise<RouteResult> =>
  callRoute(movementsRouter, 'post', '/', {
    body: { itemId: s.gkp.id, warehouseId: s.warehouseId, date: DAY, ...body },
    userId: s.actor.userId, role: s.actor.role,
  });

const edit = (s: Setup, id: string, body: Record<string, unknown>): Promise<RouteResult> =>
  callRoute(movementsRouter, 'put', '/:id', { params: { id }, body: { date: DAY, ...body }, userId: s.actor.userId, role: s.actor.role });

function expectCreated(r: RouteResult) {
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; journalEntryId: string | null };
}

function expectRefused(r: RouteResult, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(code);
}

/** Active ledger rows of a journal as [accountId, debit, credit]. */
async function ledgerOf(tx: Tx, journalEntryId: string) {
  const rows = await tx.accountingLedgerEntry.findMany({ where: { referenceId: journalEntryId, isCancelled: false }, orderBy: { debit: 'desc' } });
  return rows.map((r) => [r.accountId, Number(r.debit), Number(r.credit)]);
}

/** Stored balance of each account equals its active ledger rows (debit − credit; all fixture accounts are debit-normal or expense). */
async function expectBalancesMatchLedger(tx: Tx, accountIds: string[]) {
  for (const accountId of accountIds) {
    const acc = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
    const sums = await tx.accountingLedgerEntry.aggregate({ where: { accountId, isCancelled: false }, _sum: { debit: true, credit: true } });
    const net = new Decimal(sums._sum.debit?.toString() ?? 0).minus(sums._sum.credit?.toString() ?? 0);
    expect(new Decimal(acc.balance.toString()).toFixed(2), acc.accountNumber).toBe(net.toFixed(2));
  }
}

d('manual Stock Out is valued at the average', () => {
  it.each([
    ['a client cost of 5.000', { unitCost: 5_000 }],
    ['no client cost', {}],
  ])('Out 1.000 kg with %s credits inventory 6.000.000 through a SYSTEM_DOC journal', async (_label, extra) => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const created = expectCreated(await post(s, { movementType: 'Out', quantity: 1_000, offsetAccountId: s.offsetId, ...extra }));
      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: created.id } });
      expect(Number(mov.unitCost)).toBe(6_000);
      expect(Number(mov.totalValue)).toBe(6_000_000);
      expect(await ledgerOf(tx, mov.journalEntryId!)).toEqual([[s.offsetId, 6_000_000, 0], [s.inventoryAccountId, 0, 6_000_000]]);
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: mov.journalEntryId! } });
      expect(je.sourceType).toBe('SYSTEM_DOC');
      await expectBalancesMatchLedger(tx, [s.offsetId, s.inventoryAccountId]);
    });
  });

  it('Adjustment − without an offset debits Inventory Variance', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const created = expectCreated(await post(s, { movementType: 'AdjustmentOut', quantity: 100 }));
      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: created.id } });
      expect(mov.offsetAccountId).toBe(s.varianceId);
      expect(await ledgerOf(tx, mov.journalEntryId!)).toEqual([[s.varianceId, 600_000, 0], [s.inventoryAccountId, 0, 600_000]]);
    });
  });

  it('is refused while Inventory Variance shares its account with rounding; stock stays put', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await mapRole(tx, 'ROUNDING_ACCOUNT', s.varianceId);
      expectRefused(await post(s, { movementType: 'AdjustmentOut', quantity: 100 }), INVENTORY_VARIANCE_UNSAFE);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } })).currentStock)).toBe(10_000);
      // An explicit offset does not need the variance account.
      expectCreated(await post(s, { movementType: 'AdjustmentOut', quantity: 100, offsetAccountId: s.offsetId }));
    });
  });
});

d('manual Stock In needs a cost and an offset', () => {
  it('In 100 kg at cost 0 or without a cost is refused', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      expectRefused(await post(s, { movementType: 'In', quantity: 100, unitCost: 0, offsetAccountId: s.offsetId }), MANUAL_IN_ZERO_COST);
      expectRefused(await post(s, { movementType: 'AdjustmentIn', quantity: 100, offsetAccountId: s.offsetId }), MANUAL_IN_ZERO_COST);
    });
  });

  it('In without an offset (an old AIRA payload) is refused', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      expectRefused(await post(s, { movementType: 'In', quantity: 100, unitCost: 7_000 }), OFFSET_REQUIRED);
    });
  });

  it('refuses the opening equity, a group, an inactive account and an account in the inventory group as offset', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const openingEquity = await account(tx, 'EQUITY', 'Ekuitas Saldo Awal');
      await mapRole(tx, 'OPENING_EQUITY', openingEquity.id);
      const group = await account(tx, 'EXPENSE', 'Kelompok beban', { isGroup: true });
      const inactive = await account(tx, 'EXPENSE', 'Beban lama', { isActive: false });
      const inventoryGroup = await account(tx, 'ASSET', 'Kelompok persediaan', { isGroup: true });
      const mappedInventory = await account(tx, 'ASSET', 'Persediaan umum', { parentId: inventoryGroup.id });
      await mapRole(tx, 'INVENTORY', mappedInventory.id);
      const sibling = await account(tx, 'ASSET', 'Persediaan lain', { parentId: inventoryGroup.id });

      const inbound = (offsetAccountId: string) => post(s, { movementType: 'In', quantity: 100, unitCost: 7_000, offsetAccountId });
      expectRefused(await inbound(openingEquity.id), ACCOUNT_CONTROL);
      expectRefused(await inbound(group.id), ACCOUNT_GROUP);
      expectRefused(await inbound(inactive.id), ACCOUNT_INACTIVE);
      expectRefused(await inbound(mappedInventory.id), ACCOUNT_CONTROL);
      expectRefused(await inbound(sibling.id), STOCK_OFFSET_INVENTORY);
      expectRefused(await inbound(s.inventoryAccountId), ACCOUNT_CONTROL);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } })).currentStock)).toBe(10_000);

      const ok = expectCreated(await inbound(s.offsetId));
      expect(await ledgerOf(tx, ok.journalEntryId!)).toEqual([[s.inventoryAccountId, 700_000, 0], [s.offsetId, 0, 700_000]]);
    });
  });

  it('GET of a legacy row posted against the opening equity flags its offset as no longer allowed', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const openingEquity = await account(tx, 'EQUITY', 'Ekuitas Saldo Awal');
      await mapRole(tx, 'OPENING_EQUITY', openingEquity.id);
      const ok = expectCreated(await post(s, { movementType: 'Out', quantity: 10, offsetAccountId: s.offsetId }));
      const get = () => callRoute(movementsRouter, 'get', '/:id', { params: { id: ok.id }, userId: s.actor.userId, role: s.actor.role });
      expect((await get()).body.offsetAllowed).toBe(true);
      // Before E3-R4 a manual row without an offset was stored against 3.1.
      await tx.stockMovement.update({ where: { id: ok.id }, data: { offsetAccountId: openingEquity.id } });
      const r = await get();
      expect(r.status).toBe(200);
      expect(r.body.offsetAllowed).toBe(false);
      expect(r.body.offsetAccount.id).toBe(openingEquity.id);
    });
  });

  it('a warehouse that is inactive is refused', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await tx.warehouse.update({ where: { id: s.warehouseId }, data: { isActive: false } });
      const r = await post(s, { movementType: 'In', quantity: 100, unitCost: 7_000, offsetAccountId: s.offsetId });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toBe('Gudang tidak aktif.');
    });
  });
});

d('edit and cancel of a manual movement', () => {
  it('an edited Out is re-valued at the average after the reversal; the old journal is voided', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      // In 1.000 @ 12.000: the average becomes (10.000 x 6.000 + 1.000 x 12.000) / 11.000 = 6.545,45.
      const inbound = expectCreated(await post(s, { movementType: 'In', quantity: 1_000, unitCost: 12_000, offsetAccountId: s.offsetId }));
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } })).averageCost)).toBe(6_545.45);

      // Turning that In into an Out of 100 reverses the In first: valued at 6.000, not 6.545,45 or 12.000.
      const r = await edit(s, inbound.id, { movementType: 'Out', quantity: 100, unitCost: 12_000, offsetAccountId: s.offsetId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: inbound.id } });
      expect(Number(mov.unitCost)).toBe(6_000);
      expect(Number(mov.totalValue)).toBe(600_000);
      expect(await ledgerOf(tx, mov.journalEntryId!)).toEqual([[s.offsetId, 600_000, 0], [s.inventoryAccountId, 0, 600_000]]);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: inbound.journalEntryId! } })).status).toBe('Cancelled');
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } });
      expect(Number(item.currentStock)).toBe(9_900);
      expect(Number(item.averageCost)).toBe(6_000);
      await expectBalancesMatchLedger(tx, [s.offsetId, s.inventoryAccountId]);
    });
  });

  /** 10.000 kg more at the same average with no movement behind it (legacy opening stock): the replay cannot explain the stock. */
  async function addStockWithoutMovement(tx: Tx, s: Setup) {
    await tx.inventoryItem.update({ where: { id: s.gkp.id }, data: { currentStock: { increment: 10_000 } } });
    await tx.inventoryStock.update({
      where: { itemId_warehouseId: { itemId: s.gkp.id, warehouseId: s.warehouseId } },
      data: { currentStock: { increment: 10_000 } },
    });
  }

  it('an In edited to an Out on stock without a movement behind it is valued at the average after the reversal', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await addStockWithoutMovement(tx, s);
      // In 1.000 @ 12.000 on 20.000 kg @ 6.000: the average becomes 132.000.000 / 21.000 = 6.285,71.
      const inbound = expectCreated(await post(s, { movementType: 'In', quantity: 1_000, unitCost: 12_000, offsetAccountId: s.offsetId }));
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } })).averageCost)).toBe(6_285.71);

      // The replay is skipped (residual 10.000), so the In is taken out of the average at its own cost: 6.000, not 6.285,71.
      const r = await edit(s, inbound.id, { movementType: 'Out', quantity: 100, offsetAccountId: s.offsetId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: inbound.id } });
      expect(Number(mov.unitCost)).toBe(6_000);
      expect(await ledgerOf(tx, mov.journalEntryId!)).toEqual([[s.offsetId, 600_000, 0], [s.inventoryAccountId, 0, 600_000]]);
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } });
      expect(Number(item.currentStock)).toBe(19_900);
      expect(Number(item.averageCost)).toBe(6_000);
    });
  });

  it('an In whose cost is edited on stock without a movement behind it is re-weighted at the new cost', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      await addStockWithoutMovement(tx, s);
      const inbound = expectCreated(await post(s, { movementType: 'In', quantity: 1_000, unitCost: 12_000, offsetAccountId: s.offsetId }));
      const r = await edit(s, inbound.id, { movementType: 'In', quantity: 1_000, unitCost: 9_000, offsetAccountId: s.offsetId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // (20.000 x 6.000 + 1.000 x 9.000) / 21.000 = 6.142,86; the old 12.000 is gone from the average.
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } });
      expect(Number(item.currentStock)).toBe(21_000);
      expect(Number(item.averageCost)).toBe(6_142.86);
      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: inbound.id } });
      expect(await ledgerOf(tx, mov.journalEntryId!)).toEqual([[s.inventoryAccountId, 9_000_000, 0], [s.offsetId, 0, 9_000_000]]);
      await expectBalancesMatchLedger(tx, [s.offsetId, s.inventoryAccountId]);
    });
  });

  it('an edited Out keeps the average when an Out is reversed', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const out = expectCreated(await post(s, { movementType: 'Out', quantity: 100, offsetAccountId: s.offsetId }));
      const r = await edit(s, out.id, { movementType: 'AdjustmentOut', quantity: 250, unitCost: 1 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const mov = await tx.stockMovement.findUniqueOrThrow({ where: { id: out.id } });
      expect(Number(mov.totalValue)).toBe(1_500_000);
      expect(mov.offsetAccountId).toBe(s.varianceId);
      expect(await ledgerOf(tx, mov.journalEntryId!)).toEqual([[s.varianceId, 1_500_000, 0], [s.inventoryAccountId, 0, 1_500_000]]);
    });
  });

  it('cancel puts the stock back and voids the journal; stored balances follow', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const out = expectCreated(await post(s, { movementType: 'Out', quantity: 1_000, offsetAccountId: s.offsetId }));
      const r = await callRoute(movementsRouter, 'put', '/:id/cancel', { params: { id: out.id }, userId: s.actor.userId, role: s.actor.role });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: out.journalEntryId! } })).status).toBe('Cancelled');
      expect(await ledgerOf(tx, out.journalEntryId!)).toEqual([]);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: s.gkp.id } })).currentStock)).toBe(10_000);
      await expectBalancesMatchLedger(tx, [s.offsetId, s.inventoryAccountId]);
    });
  });
});
