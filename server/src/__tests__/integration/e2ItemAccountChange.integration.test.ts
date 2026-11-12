/**
 * Integration test: the inventory account of an item and the revenue account of a service
 * (E2-R6, G-38).
 *
 * Fixture: fiscal year 2160 (this file's only year, plan §6.3) holding an 80 jt stock value
 * (8.000 x 10.000) on the item's account. Everything runs in a rollback transaction against the
 * route handlers.
 * - Changing the account of an item with stock is 400 ITEM_ACCOUNT_HAS_STOCK, for positive and
 *   negative stock and for stock that only sits in a warehouse; at stock 0 it is 200.
 * - The new account must be an ASSET detail account that is not a control account other than
 *   inventory: a group is ACCOUNT_GROUP, an expense ACCOUNT_ROOT_TYPE, an AR account ACCOUNT_CONTROL.
 * - Sending the same account again passes even with stock; clearing it (back to the Persediaan
 *   role account) is a change unless that is the account already in use.
 * - POST validates the account without a stock check.
 * - A service must sit on an active REVENUE detail account, on create and when the account changes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import itemsRouter from '../../routes/inventory/items';
import serviceItemsRouter from '../../routes/serviceItems';

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

const Y = 2160;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const numberUnder = (prefix: string) => `${prefix}.97${Date.now() % 100000}${++seq}`;

type RootType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

const account = (tx: Tx, rootType: RootType, accountNumber: string, extra: { isGroup?: boolean; isActive?: boolean; parentId?: string } = {}) =>
  tx.account.create({ data: { name: `IT-ITEM ${tag()}`, accountNumber, accountType: rootType, rootType, ...extra } });

/**
 * The inventory subtree this file owns inside its rollback (E3-R5 limits item accounts to it): a group
 * with the INVENTORY mapping on one child, so the result does not depend on the seed.
 */
async function inventorySubtree(tx: Tx) {
  await tx.systemAccountMapping.deleteMany({ where: { role: 'INVENTORY' } });
  const group = await account(tx, 'ASSET', numberUnder('1'), { isGroup: true });
  const mapped = await account(tx, 'ASSET', numberUnder('1'), { parentId: group.id });
  await tx.systemAccountMapping.create({ data: { role: 'INVENTORY', accountId: mapped.id } });
  return { group, mapped, child: () => account(tx, 'ASSET', numberUnder('1'), { parentId: group.id }) };
}

/** An item on `accountId` holding `stock` units at 10.000, with the matching value in the ledger. */
async function itemWithStock(tx: Tx, accountId: string, stock: number) {
  const fy =
    (await tx.fiscalYear.findFirst({ where: { startDate: new Date(`${Y}-01-01`) } })) ??
    (await tx.fiscalYear.create({
      data: { name: `IT-ITEM-${Y}-${tag()}`, startDate: new Date(`${Y}-01-01`), endDate: new Date(`${Y}-12-31`) },
    }));
  const owner = await createCapUser(tx, []);
  const item = await tx.inventoryItem.create({
    data: { code: `IT-ITEM-${tag()}`, name: 'Gabah (uji)', unit: 'kg', accountId, currentStock: stock, averageCost: 10_000 },
  });
  if (stock > 0) {
    const je = await tx.journalEntry.create({
      data: { entryNumber: `IT-ITEM-${tag()}`, date: new Date(`${Y}-03-01`), narration: 'IT-ITEM stock', status: 'Submitted', fiscalYearId: fy.id, createdBy: owner.userId, submittedAt: new Date() },
    });
    await tx.accountingLedgerEntry.create({
      data: { date: new Date(`${Y}-03-01`), accountId, debit: stock * 10_000, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
    });
  }
  return item;
}

const putItem = (id: string, body: Record<string, unknown>) => callRoute(itemsRouter, 'put', '/:id', { params: { id }, body });
const postItem = (body: Record<string, unknown>) => callRoute(itemsRouter, 'post', '/', { body });
const accountOf = async (tx: Tx, id: string) => (await tx.inventoryItem.findUniqueOrThrow({ where: { id } })).accountId;

d('item inventory account (E2-R6)', () => {
  it('refuses to change the account of an item holding 8.000 units, and leaves the item alone', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const from = await sub.child();
      const to = await sub.child();
      const item = await itemWithStock(tx, from.id, 8000);

      const r = await putItem(item.id, { accountId: to.id, name: 'Nama baru' });

      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('ITEM_ACCOUNT_HAS_STOCK');
      expect(await accountOf(tx, item.id)).toBe(from.id);
      expect((await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).name).toBe('Gabah (uji)');
    });
  });

  it('changes the account of an item with no stock', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const from = await sub.child();
      const to = await sub.child();
      const item = await itemWithStock(tx, from.id, 0);

      const r = await putItem(item.id, { accountId: to.id });

      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.account.id).toBe(to.id);
    });
  });

  it('counts negative stock and stock that only sits in a warehouse as stock', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const from = await sub.child();
      const to = await sub.child();
      const negative = await itemWithStock(tx, from.id, 0);
      await tx.inventoryItem.update({ where: { id: negative.id }, data: { currentStock: -5 } });
      const r1 = await putItem(negative.id, { accountId: to.id });
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('ITEM_ACCOUNT_HAS_STOCK');

      const inWarehouse = await itemWithStock(tx, from.id, 0);
      const wh = await tx.warehouse.create({ data: { code: `IT-WH-${tag()}`, name: 'Gudang uji' } });
      await tx.inventoryStock.create({ data: { itemId: inWarehouse.id, warehouseId: wh.id, currentStock: 3 } });
      const r2 = await putItem(inWarehouse.id, { accountId: to.id });
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('ITEM_ACCOUNT_HAS_STOCK');
    });
  });

  it('accepts only an active ASSET detail account that is not another control account', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const from = await sub.child();
      const item = await itemWithStock(tx, from.id, 0);
      const group = await account(tx, 'ASSET', numberUnder('1'), { isGroup: true });
      const expense = await account(tx, 'EXPENSE', numberUnder('6'));
      const inactive = await account(tx, 'ASSET', numberUnder('1'), { isActive: false });
      const ar = await account(tx, 'ASSET', numberUnder('1'));
      await tx.systemAccountMapping.create({ data: { role: 'AR', accountId: ar.id, sortOrder: 99 } });
      const ppnIn = await account(tx, 'ASSET', numberUnder('1'));
      await tx.systemAccountMapping.create({ data: { role: 'TAX_INPUT', accountId: ppnIn.id, sortOrder: 99 } });

      for (const [bad, code] of [
        [group, 'ACCOUNT_GROUP'],
        [expense, 'ACCOUNT_ROOT_TYPE'],
        [inactive, 'ACCOUNT_INACTIVE'],
        [ar, 'ACCOUNT_CONTROL'],
        [ppnIn, 'ACCOUNT_CONTROL'],
      ] as const) {
        const r = await putItem(item.id, { accountId: bad.id });
        expect(r.status, `${code}: ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe(code);
      }
      expect(await accountOf(tx, item.id)).toBe(from.id);
    });
  });

  it('lets the same account through with stock, and treats clearing it as a change', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const mapped = sub.mapped;
      const own = await sub.child();

      const withOwn = await itemWithStock(tx, own.id, 8000);
      const same = await putItem(withOwn.id, { accountId: own.id, minimumStock: 5 });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      const cleared = await putItem(withOwn.id, { accountId: null });
      expect(cleared.status).toBe(400);
      expect(cleared.body.code).toBe('ITEM_ACCOUNT_HAS_STOCK');

      // An item on the default account may name that account explicitly: nothing moves.
      const onDefault = await itemWithStock(tx, mapped.id, 8000);
      await tx.inventoryItem.update({ where: { id: onDefault.id }, data: { accountId: null } });
      const explicit = await putItem(onDefault.id, { accountId: mapped.id });
      expect(explicit.status, JSON.stringify(explicit.body)).toBe(200);
    });
  });

  it('validates the account on create without looking at stock', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const asset = await sub.child();
      const expense = await account(tx, 'EXPENSE', numberUnder('6'));
      const bad = await postItem({ code: `IT-ITEM-${tag()}`, name: 'Uji', unit: 'kg', accountId: expense.id });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('ACCOUNT_ROOT_TYPE');
      const ok = await postItem({ code: `IT-ITEM-${tag()}`, name: 'Uji', unit: 'kg', accountId: asset.id });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });
  });

  it('answers 404 for an item that does not exist', async () => {
    await inRollback(async () => {
      const r = await putItem('00000000-0000-4000-8000-000000000000', { name: 'x' });
      expect(r.status).toBe(404);
    });
  });
});

d('service revenue account (E2-R6)', () => {
  const postService = (body: Record<string, unknown>) => callRoute(serviceItemsRouter, 'post', '/', { body });
  const patchService = (id: string, body: Record<string, unknown>) => callRoute(serviceItemsRouter, 'patch', '/:id', { params: { id }, body });

  it('requires an active REVENUE detail account, on create and when the account changes', async () => {
    await inRollback(async (tx) => {
      const revenue = await account(tx, 'REVENUE', numberUnder('4'));
      const otherRevenue = await account(tx, 'REVENUE', numberUnder('4'));
      const asset = await account(tx, 'ASSET', numberUnder('1'));
      const group = await account(tx, 'REVENUE', numberUnder('4'), { isGroup: true });
      const inactive = await account(tx, 'REVENUE', numberUnder('4'), { isActive: false });
      const payload = (accountId: string) => ({ code: `IT-SVC-${tag()}`, name: 'Jasa uji', accountId });

      for (const [bad, code] of [[asset, 'ACCOUNT_ROOT_TYPE'], [group, 'ACCOUNT_GROUP'], [inactive, 'ACCOUNT_INACTIVE']] as const) {
        const r = await postService(payload(bad.id));
        expect(r.status, code).toBe(400);
        expect(r.body.code).toBe(code);
      }
      const created = await postService(payload(revenue.id));
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const bad = await patchService(created.body.id, { accountId: asset.id });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('ACCOUNT_ROOT_TYPE');
      const ok = await patchService(created.body.id, { accountId: otherRevenue.id });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.account.id).toBe(otherRevenue.id);
    });
  });

  it('does not block other edits of a service whose stored account no longer qualifies', async () => {
    await inRollback(async (tx) => {
      const asset = await account(tx, 'ASSET', numberUnder('1'));
      const svc = await tx.serviceItem.create({ data: { code: `IT-SVC-${tag()}`, name: 'Lama', accountId: asset.id } });
      const r = await patchService(svc.id, { name: 'Nama baru', accountId: asset.id });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });
  });
});
