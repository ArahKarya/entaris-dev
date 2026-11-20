/**
 * Integration test: the item and warehouse master are locked while they carry stock (E3-R5).
 *
 * Fixture: fiscal year 2107 (this file's only year, plan §6.3). Every case runs in a rollback
 * transaction against the route handlers and owns its inventory account subtree and INVENTORY mapping.
 * - An item with 10.000 kg: its account, its unit and its active flag are locked (account 1.4.2 ->
 *   1.4.3, Kg -> Ton, deactivate), all 400 with a code; name and minimum stock still change.
 * - A submitted Surat Jalan not yet invoiced locks the account and the active flag of an item whose
 *   stock is already 0; once the Invoice picked it up, or the Surat Jalan is cancelled, it is free.
 * - An item with no stock and no movement can change unit; one with only a cancelled movement too.
 * - A revenue account (4.1) or an asset account outside the inventory group is 400.
 * - DELETE runs under the item lock and still refuses an item with an active movement.
 * - A warehouse holding 5 ton, or negative stock, cannot be deactivated; neither can the default
 *   warehouse; an empty one can, and other edits of a stocked warehouse pass.
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
import warehousesRouter from '../../routes/warehouses';
import { findInactiveMasterWithStock } from '../../services/inventory/itemMasterGuard';
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

const Y = 2107;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const numberUnder = (prefix: string) => `${prefix}.96${Date.now() % 100000}${++seq}`;

type RootType = 'ASSET' | 'REVENUE';
const account = (tx: Tx, rootType: RootType, accountNumber: string, extra: { isGroup?: boolean; parentId?: string } = {}) =>
  tx.account.create({ data: { name: `IT-IMG ${tag()}`, accountNumber, accountType: rootType, rootType, ...extra } });

/** A group with the INVENTORY mapping on one child (the 1.4 / 1.4.0 shape), owned by the rollback. */
async function inventorySubtree(tx: Tx) {
  await tx.systemAccountMapping.deleteMany({ where: { role: 'INVENTORY' } });
  const group = await account(tx, 'ASSET', numberUnder('1'), { isGroup: true });
  const mapped = await account(tx, 'ASSET', numberUnder('1'), { parentId: group.id });
  await tx.systemAccountMapping.create({ data: { role: 'INVENTORY', accountId: mapped.id } });
  return { group, mapped, child: () => account(tx, 'ASSET', numberUnder('1'), { parentId: group.id }) };
}

async function fiscalYear(tx: Tx) {
  return (
    (await tx.fiscalYear.findFirst({ where: { startDate: new Date(`${Y}-01-01`) } })) ??
    (await tx.fiscalYear.create({
      data: { name: `IT-IMG-${Y}-${tag()}`, startDate: new Date(`${Y}-01-01`), endDate: new Date(`${Y}-12-31`) },
    }))
  );
}

async function warehouse(tx: Tx, extra: { isDefault?: boolean } = {}) {
  return tx.warehouse.create({ data: { code: `IT-IMG-${tag()}`, name: 'Gudang uji', ...extra } });
}

/** An item holding `stock` kg in a new warehouse (item total and warehouse row agree). */
async function stockedItem(tx: Tx, accountId: string | null, stock: number, wh?: { id: string }) {
  const w = wh ?? (await warehouse(tx));
  const item = await tx.inventoryItem.create({
    data: { code: `IT-IMG-${tag()}`, name: 'Bekatul (uji)', unit: 'Kg', accountId },
  });
  if (stock !== 0) {
    const fy = await fiscalYear(tx);
    await seedStock(tx, { itemId: item.id, warehouseId: w.id, qty: stock, avg: 1000, date: `${Y}-01-02`, fiscalYearId: fy.id });
  }
  return { item, wh: w };
}

async function movement(tx: Tx, itemId: string, warehouseId: string, opts: { cancelled?: boolean } = {}) {
  const fy = await fiscalYear(tx);
  const owner = await createCapUser(tx, []);
  return tx.stockMovement.create({
    data: {
      movementNumber: `IT-IMG-SM-${tag()}`, date: new Date(`${Y}-03-01`), itemId, warehouseId, movementType: 'In',
      quantity: 10, unitCost: 1000, totalValue: 10_000, fiscalYearId: fy.id, createdById: owner.userId, isCancelled: !!opts.cancelled,
    },
  });
}

/** A submitted Surat Jalan naming the item; `invoiced` links it to an Invoice. */
async function suratJalan(tx: Tx, itemId: string, warehouseId: string, opts: { status?: 'Submitted' | 'Cancelled'; invoiced?: boolean } = {}) {
  const fy = await fiscalYear(tx);
  const owner = await createCapUser(tx, []);
  const customer = await tx.party.create({ data: { name: `IT-IMG Customer ${tag()}`, partyType: 'Customer' } });
  let invoiceId: string | undefined;
  if (opts.invoiced) {
    const inv = await tx.salesInvoice.create({
      data: {
        invoiceNumber: `IT-IMG-INV-${tag()}`, date: new Date(`${Y}-04-01`), partyId: customer.id, grandTotal: 1000, outstanding: 1000,
        fiscalYearId: fy.id, createdBy: owner.userId,
      },
    });
    invoiceId = inv.id;
  }
  return tx.deliveryOrder.create({
    data: {
      doNumber: `IT-IMG-DO-${tag()}`, date: new Date(`${Y}-04-01`), partyId: customer.id, fiscalYearId: fy.id, createdBy: owner.userId,
      status: opts.status ?? 'Submitted', invoiceId,
      items: { create: [{ inventoryItemId: itemId, warehouseId, itemName: 'Bekatul (uji)', quantity: 1, unit: 'Kg' }] },
    },
  });
}

const putItem = (id: string, body: Record<string, unknown>) => callRoute(itemsRouter, 'put', '/:id', { params: { id }, body });
const deleteItem = (id: string) => callRoute(itemsRouter, 'delete', '/:id', { params: { id } });
const putWarehouse = (id: string, body: Record<string, unknown>) => callRoute(warehousesRouter, 'put', '/:id', { params: { id }, body });
const reload = (tx: Tx, id: string) => tx.inventoryItem.findUniqueOrThrow({ where: { id } });

d('item master while it carries stock (E3-R5)', () => {
  it('refuses a new account, a new unit and deactivation for an item holding 10.000 kg, and leaves it alone', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const from = await sub.child();
      const to = await sub.child();
      const { item } = await stockedItem(tx, from.id, 10_000);

      const account = await putItem(item.id, { accountId: to.id });
      expect(account.status, JSON.stringify(account.body)).toBe(400);
      expect(account.body.code).toBe('ITEM_ACCOUNT_HAS_STOCK');

      const unit = await putItem(item.id, { unit: 'Ton' });
      expect(unit.status, JSON.stringify(unit.body)).toBe(400);
      expect(unit.body.code).toBe('ITEM_UNIT_IN_USE');

      const off = await putItem(item.id, { isActive: false });
      expect(off.status, JSON.stringify(off.body)).toBe(400);
      expect(off.body.code).toBe('ITEM_HAS_STOCK');

      const after = await reload(tx, item.id);
      expect(after).toMatchObject({ accountId: from.id, unit: 'Kg', isActive: true });
    });
  });

  it('still lets name, category and minimum stock change, and the same unit or account through', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item } = await stockedItem(tx, own.id, 10_000);

      const r = await putItem(item.id, { name: 'Bekatul halus', category: 'Produk samping', minimumStock: 50, unit: 'Kg', accountId: own.id, isActive: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ name: 'Bekatul halus', unit: 'Kg' });
    });
  });

  it('counts negative stock and stock that only sits in a warehouse', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item: negative } = await stockedItem(tx, own.id, -5);
      const r1 = await putItem(negative.id, { isActive: false });
      expect(r1.body.code).toBe('ITEM_HAS_STOCK');

      const { item: inWarehouse } = await stockedItem(tx, own.id, 0);
      const wh = await warehouse(tx);
      await tx.inventoryStock.create({ data: { itemId: inWarehouse.id, warehouseId: wh.id, currentStock: 3 } });
      const r2 = await putItem(inWarehouse.id, { isActive: false });
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('ITEM_HAS_STOCK');
    });
  });

  it('lets an item with no stock and no active movement change unit, and be deactivated and reactivated', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item, wh } = await stockedItem(tx, own.id, 0);
      await movement(tx, item.id, wh.id, { cancelled: true });

      const unit = await putItem(item.id, { unit: 'Ton' });
      expect(unit.status, JSON.stringify(unit.body)).toBe(200);
      const off = await putItem(item.id, { isActive: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect((await reload(tx, item.id)).isActive).toBe(false);
      const on = await putItem(item.id, { isActive: true });
      expect(on.status).toBe(200);
    });
  });

  it('refuses a unit change for an item with an active movement even when its stock is 0', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item, wh } = await stockedItem(tx, own.id, 0);
      await movement(tx, item.id, wh.id);

      const r = await putItem(item.id, { unit: 'Ton' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ITEM_UNIT_IN_USE');
    });
  });

  it('refuses to deactivate or move an item at stock 0 while a Surat Jalan is not invoiced', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const from = await sub.child();
      const to = await sub.child();
      const { item, wh } = await stockedItem(tx, from.id, 0);
      const sj = await suratJalan(tx, item.id, wh.id);

      const off = await putItem(item.id, { isActive: false });
      expect(off.status, JSON.stringify(off.body)).toBe(400);
      expect(off.body.code).toBe('ITEM_HAS_STOCK');
      const acc = await putItem(item.id, { accountId: to.id });
      expect(acc.status).toBe(400);
      expect(acc.body.code).toBe('ITEM_ACCOUNT_HAS_STOCK');

      // Cancelled: nothing is owed on it any more.
      await tx.deliveryOrder.update({ where: { id: sj.id }, data: { status: 'Cancelled' } });
      expect((await putItem(item.id, { accountId: to.id })).status).toBe(200);
      expect((await putItem(item.id, { isActive: false })).status).toBe(200);
    });
  });

  it('frees an item once the Invoice has picked its Surat Jalan up', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item, wh } = await stockedItem(tx, own.id, 0);
      await suratJalan(tx, item.id, wh.id, { invoiced: true });

      const r = await putItem(item.id, { isActive: false });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });
  });

  it('accepts only accounts inside the inventory group: a revenue account is 400, so is an asset outside it', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item } = await stockedItem(tx, own.id, 0);
      const revenue = await account(tx, 'REVENUE', numberUnder('4'));
      const outside = await account(tx, 'ASSET', numberUnder('1'));

      const r1 = await putItem(item.id, { accountId: revenue.id });
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('ACCOUNT_ROOT_TYPE');
      const r2 = await putItem(item.id, { accountId: outside.id });
      expect(r2.status, JSON.stringify(r2.body)).toBe(400);
      expect(r2.body.code).toBe('ITEM_ACCOUNT_NOT_INVENTORY');
      expect((await reload(tx, item.id)).accountId).toBe(own.id);

      const created = await callRoute(itemsRouter, 'post', '/', { body: { code: `IT-IMG-${tag()}`, name: 'Uji', unit: 'kg', accountId: outside.id } });
      expect(created.body.code).toBe('ITEM_ACCOUNT_NOT_INVENTORY');
      const ok = await callRoute(itemsRouter, 'post', '/', { body: { code: `IT-IMG-${tag()}`, name: 'Uji', unit: 'kg', accountId: sub.mapped.id } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });
  });

  it('keeps an existing item on an account outside the group editable as long as the account is not changed', async () => {
    await inRollback(async (tx) => {
      await inventorySubtree(tx);
      const legacy = await account(tx, 'ASSET', numberUnder('1'));
      const { item } = await stockedItem(tx, legacy.id, 10_000);
      const r = await putItem(item.id, { accountId: legacy.id, name: 'Nama baru' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });
  });

  it('deletes an item without activity, and refuses one with an active movement', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item: used, wh } = await stockedItem(tx, own.id, 0);
      await movement(tx, used.id, wh.id);
      const refused = await deleteItem(used.id);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/mutasi stok aktif/);
      expect(await tx.inventoryItem.count({ where: { id: used.id } })).toBe(1);

      const { item: clean } = await stockedItem(tx, own.id, 0);
      await movement(tx, clean.id, wh.id, { cancelled: true });
      expect((await deleteItem(clean.id)).status).toBe(200);
      expect(await tx.inventoryItem.count({ where: { id: clean.id } })).toBe(0);

      expect((await deleteItem('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });
  });

  it('refuses to delete an item whose stock has no active movement behind it', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const own = await sub.child();
      const { item } = await stockedItem(tx, own.id, 120);
      // Legacy stock: the seeded opening movement is cancelled, so none is active behind the 120 kg.
      await tx.stockMovement.updateMany({ where: { itemId: item.id }, data: { isCancelled: true } });
      const refused = await deleteItem(item.id);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('ITEM_HAS_STOCK');
      expect(await tx.inventoryItem.count({ where: { id: item.id } })).toBe(1);
      expect(await tx.inventoryStock.count({ where: { itemId: item.id } })).toBe(1);
    });
  });
});

d('warehouse master while it carries stock (E3-R5)', () => {
  it('refuses to deactivate a warehouse holding 5 ton, and leaves it active', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const { wh } = await stockedItem(tx, (await sub.child()).id, 5000);

      const r = await putWarehouse(wh.id, { isActive: false });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('WAREHOUSE_HAS_STOCK');
      expect((await tx.warehouse.findUniqueOrThrow({ where: { id: wh.id } })).isActive).toBe(true);
    });
  });

  it('counts negative stock, and still lets other fields of a stocked warehouse change', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const { wh } = await stockedItem(tx, (await sub.child()).id, -2);
      expect((await putWarehouse(wh.id, { isActive: false })).body.code).toBe('WAREHOUSE_HAS_STOCK');

      const rename = await putWarehouse(wh.id, { name: 'Gudang Utara', isActive: true });
      expect(rename.status, JSON.stringify(rename.body)).toBe(200);
      expect(rename.body.name).toBe('Gudang Utara');
    });
  });

  it('refuses the default warehouse, and deactivates an empty one', async () => {
    await inRollback(async (tx) => {
      await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      const def = await warehouse(tx, { isDefault: true });
      const r = await putWarehouse(def.id, { isActive: false });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('WAREHOUSE_IS_DEFAULT');
      const both = await putWarehouse(def.id, { isActive: false, isDefault: false });
      expect(both.body.code).toBe('WAREHOUSE_IS_DEFAULT');

      const empty = await warehouse(tx);
      const off = await putWarehouse(empty.id, { isActive: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.isActive).toBe(false);
      expect((await putWarehouse(empty.id, { isActive: true })).status).toBe(200);
    });
  });

  it('does not let the default warehouse be unticked, so a second call cannot deactivate it', async () => {
    await inRollback(async (tx) => {
      await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      const def = await warehouse(tx, { isDefault: true });
      const other = await warehouse(tx);
      const r = await putWarehouse(def.id, { isDefault: false });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('WAREHOUSE_IS_DEFAULT');
      expect((await tx.warehouse.findUniqueOrThrow({ where: { id: def.id } })).isDefault).toBe(true);
      // The default moves by naming another warehouse as the default.
      expect((await putWarehouse(other.id, { isDefault: true })).status).toBe(200);
      expect((await tx.warehouse.findUniqueOrThrow({ where: { id: def.id } })).isDefault).toBe(false);
    });
  });

  it('keeps the default warehouse active in both orders: no inactive default through PUT or POST', async () => {
    await inRollback(async (tx) => {
      await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      const def = await warehouse(tx, { isDefault: true });
      const other = await warehouse(tx);

      expect((await putWarehouse(other.id, { isActive: false })).status).toBe(200);
      const r = await putWarehouse(other.id, { isDefault: true });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('WAREHOUSE_IS_DEFAULT');
      const both = await putWarehouse(other.id, { isActive: true, isDefault: true });
      expect(both.status, JSON.stringify(both.body)).toBe(200);
      expect((await tx.warehouse.findUniqueOrThrow({ where: { id: def.id } })).isDefault).toBe(false);

      // An edit that omits isActive/isDefault leaves them as they are.
      const renamed = await putWarehouse(other.id, { name: 'Gudang Selatan' });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(renamed.body).toMatchObject({ isActive: true, isDefault: true });

      const created = await callRoute(warehousesRouter, 'post', '/', { body: { code: `IT-IMG-${tag()}`, name: 'Gudang baru', isActive: false, isDefault: true } });
      expect(created.status).toBe(400);
      expect(created.body.code).toBe('WAREHOUSE_IS_DEFAULT');
      expect(await tx.warehouse.count({ where: { isDefault: true, isActive: true } })).toBe(1);
    });
  });

  it('lists rows switched off earlier that still hold stock (the read-only report)', async () => {
    await inRollback(async (tx) => {
      const sub = await inventorySubtree(tx);
      const { item, wh } = await stockedItem(tx, (await sub.child()).id, 5000);
      await tx.inventoryItem.update({ where: { id: item.id }, data: { isActive: false } });
      await tx.warehouse.update({ where: { id: wh.id }, data: { isActive: false } });

      const findings = await findInactiveMasterWithStock(tx);
      expect(findings.find((f) => f.kind === 'item' && f.id === item.id)).toMatchObject({ quantity: '5000', uninvoicedDeliveries: 0 });
      expect(findings.find((f) => f.kind === 'warehouse' && f.id === wh.id)).toMatchObject({ quantity: '5000' });
    });
  });
});
