/**
 * Integration test: row locks and per-warehouse aggregate stock checks (E3-R3, plan step 6 PR-6.2a).
 *
 * Races (committed fixtures in fiscal year 2103, deleted after; pattern of
 * fixedAssetDepreciationRace.integration.test.ts). The item and its offset account are the test's
 * own, so nothing global is written or remapped:
 * - warehouse A holds 5 t; two Stok Keluar of 4 t at once: one 201, one 400 STOCK_INSUFFICIENT, 1 t left;
 * - 10 t at 10.000; two Stok Masuk of 10 t at 12.000 and 8.000 at once: average 10.000 (no lost update);
 * - a document that only references the item (KEY SHARE) and a posting do not wait for each other;
 * - two transfers of the same two items in opposite line order, several at once: all 201, no deadlock.
 *
 * Aggregate and per-warehouse checks (rollback transaction, same year):
 * - STT cancel with two lines of one item, 600 + 600, when the warehouse holds 1.000 -> 400;
 * - transfer with two lines of one item, 600 + 600, from 1.000 -> 400 STOCK_INSUFFICIENT;
 * - edit or cancel of a Stok Masuk already used up at its warehouse -> 400 even while another
 *   warehouse holds the item; an edit to Penyesuaian Stok - is checked like Stok Keluar;
 * - stock opname adds no empty warehouse row for a counted item without a difference;
 * - stock opname cancel whose surplus already left its warehouse -> 400, and the cancel claims the
 *   opname first (a second cancel cannot reverse twice) once the Out is taken back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { seedStock } from '../helpers/inventoryFixture';

const state = vi.hoisted(() => ({
  client: null as PrismaClient | null,
  /** Set: route transactions run in this rollback transaction (savepoint per route). */
  tx: null as Tx | null,
  /** Runs once, at the end of the next committed route transaction, before it commits. */
  beforeCommit: null as null | (() => Promise<void>),
  seq: 0,
}));

vi.mock('../../lib/prisma', () => ({
  prisma: new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const tx = state.tx;
      if (tx) {
        if (key !== '$transaction') return (tx as unknown as Record<string, unknown>)[key];
        return async (fn: (t: Tx) => Promise<unknown>) => {
          const name = `stock_locks_${++state.seq}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
          try {
            const result = await fn(tx);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (e) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
            throw e;
          }
        };
      }
      const client = state.client;
      if (!client) throw new Error('stockLocksRace test: no client');
      if (key === '$transaction') {
        return (fn: (t: Tx) => Promise<unknown>, opts?: { timeout?: number }) =>
          client.$transaction(async (t) => {
            const result = await fn(t as Tx);
            const hook = state.beforeCommit;
            state.beforeCommit = null;
            if (hook) await hook();
            return result;
          }, opts);
      }
      const value = (client as unknown as Record<string, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value;
    },
  }),
}));

import movementsRouter from '../../routes/inventory/movements';
import stockOpnameRouter from '../../routes/stockOpname';
import goodsReceiptsRouter from '../../routes/goodsReceipts';
import stockTransfersRouter from '../../routes/stockTransfers';
import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { invalidatePermissionCache } from '../../services/permissionService';
import { STOCK_INSUFFICIENT } from '../../services/inventory/stockLocks';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  state.client = prisma;
});

afterAll(async () => {
  state.client = null;
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

/** Unique fixture year of this file (plan step 6 §6.3). */
const Y = 2103;
const DAY = new Date(`${Y}-03-10`);
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

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

/** Starts `p` and reports whether it settled within `ms`; the racing request must be waiting. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

/** Fiscal year Y, two warehouses, the test's own inventory and offset accounts, and an actor. */
async function setup(db: Tx) {
  const fy = await createFiscalYear(db, { year: Y });
  const warehouse = (n: string) => db.warehouse.create({ data: { code: `IT-E3R3-${n}-${tag()}`, name: `Gudang uji kunci ${n} ${tag()}` } });
  const whA = await warehouse('A');
  const whB = await warehouse('B');
  const account = (rootType: 'ASSET' | 'EQUITY', name: string) => db.account.create({
    data: { name: `IT-E3R3 ${name}`, accountNumber: `IT-E3R3-${tag()}`, accountType: rootType, rootType },
  });
  const inventoryAccount = await account('ASSET', 'Persediaan');
  const offsetAccount = await account('EQUITY', 'Lawan');
  const actor = await createCapUser(db, ['doc.cancel']);
  return { fy, whA: whA.id, whB: whB.id, inventoryAccountId: inventoryAccount.id, offsetAccountId: offsetAccount.id, actor };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function item(db: Tx, s: Setup, name: string) {
  return db.inventoryItem.create({
    data: { code: `IT-E3R3-${tag()}`, name: `Uji kunci ${name} ${tag()}`, unit: 'kg', isActive: true, accountId: s.inventoryAccountId },
  });
}

const seed = (db: Tx, s: Setup, itemId: string, warehouseId: string, qty: number, avg: number) =>
  seedStock(db, { itemId, warehouseId, qty, avg, fiscalYearId: s.fy.id, userId: s.actor.userId, date: DAY });

function postMovement(s: Setup, body: Record<string, unknown>): Promise<RouteResult> {
  return callRoute(movementsRouter, 'post', '/', {
    body: { date: `${Y}-03-12`, offsetAccountId: s.offsetAccountId, ...body },
    userId: s.actor.userId,
    role: s.actor.role,
  });
}

function postTransfer(s: Setup, from: string, to: string, items: { itemId: string; quantity: number }[]): Promise<RouteResult> {
  return callRoute(stockTransfersRouter, 'post', '/', {
    body: { date: `${Y}-03-12`, fromWarehouseId: from, toWarehouseId: to, items },
    userId: s.actor.userId,
    role: s.actor.role,
  });
}

async function stockOf(db: Tx, itemId: string, warehouseId: string) {
  const it = await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { currentStock: true, averageCost: true } });
  const wh = await db.inventoryStock.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } }, select: { currentStock: true } });
  return { item: Number(it.currentStock), warehouse: Number(wh?.currentStock ?? 0), avg: Number(it.averageCost) };
}

/** Committed fixture for one race; `cleanup` deletes everything it and the routes wrote. */
async function committedSetup() {
  const db = prisma as unknown as Tx;
  const s = await setup(db);
  const itemIds: string[] = [];
  const cleanup = async () => {
    state.beforeCommit = null;
    await prisma.stockMovement.deleteMany({ where: { fiscalYearId: s.fy.id } });
    // Transfer lines go with their transfer (cascade).
    await prisma.stockTransfer.deleteMany({ where: { fiscalYearId: s.fy.id } });
    await prisma.accountingLedgerEntry.deleteMany({ where: { fiscalYearId: s.fy.id } });
    await prisma.journalItem.deleteMany({ where: { journalEntry: { fiscalYearId: s.fy.id } } });
    await prisma.journalEntry.deleteMany({ where: { fiscalYearId: s.fy.id } });
    await prisma.inventoryStock.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.inventoryStock.deleteMany({ where: { warehouseId: { in: [s.whA, s.whB] } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: [s.whA, s.whB] } } });
    await prisma.account.deleteMany({ where: { id: { in: [s.inventoryAccountId, s.offsetAccountId] } } });
    await prisma.fiscalYear.delete({ where: { id: s.fy.id } });
    await prisma.user.delete({ where: { id: s.actor.userId } });
    // Capabilities go with the role (cascade).
    await prisma.role.delete({ where: { key: s.actor.role } });
    invalidatePermissionCache();
  };
  const newItem = async (name: string) => {
    const it = await item(db, s, name);
    itemIds.push(it.id);
    return it;
  };
  return { s, db, newItem, cleanup };
}

/** Holds the next committed route transaction before its commit until `release` runs. */
function holdNextCommit() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let applied!: () => void;
  const reached = new Promise<void>((r) => { applied = r; });
  state.beforeCommit = async () => {
    applied();
    await held;
  };
  return { reached, release };
}

d('concurrent postings of one item wait for each other (committed fixtures)', () => {
  it('two Stok Keluar of 4 t from 5 t at once: one passes, the other is refused, 1 t is left', async () => {
    const f = await committedSetup();
    try {
      const gabah = await f.newItem('gabah');
      await seed(f.db, f.s, gabah.id, f.s.whA, 5000, 6000);
      const out = () => postMovement(f.s, { itemId: gabah.id, warehouseId: f.s.whA, movementType: 'Out', quantity: 4000 });

      const hold = holdNextCommit();
      const first = out();
      await hold.reached;
      const second = out();
      expect(await stillPending(second)).toBe(true);
      hold.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(b.status, JSON.stringify(b.body)).toBe(400);
      expect(b.body.code).toBe(STOCK_INSUFFICIENT);
      expect(await stockOf(f.db, gabah.id, f.s.whA)).toMatchObject({ item: 1000, warehouse: 1000 });
    } finally {
      await f.cleanup();
    }
  });

  it('two Stok Masuk at 12.000 and 8.000 over 10 t at 10.000 at once: the average is 10.000', async () => {
    const f = await committedSetup();
    try {
      const beras = await f.newItem('beras');
      await seed(f.db, f.s, beras.id, f.s.whA, 10_000, 10_000);
      const inbound = (unitCost: number) =>
        postMovement(f.s, { itemId: beras.id, warehouseId: f.s.whA, movementType: 'In', quantity: 10_000, unitCost });

      const hold = holdNextCommit();
      const first = inbound(12_000);
      await hold.reached;
      const second = inbound(8_000);
      expect(await stillPending(second)).toBe(true);
      hold.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      expect(await stockOf(f.db, beras.id, f.s.whA)).toEqual({ item: 30_000, warehouse: 30_000, avg: 10_000 });
    } finally {
      await f.cleanup();
    }
  });

  it('a document that only references the item (FK check, KEY SHARE) neither waits for nor blocks a posting', async () => {
    const f = await committedSetup();
    try {
      const gabah = await f.newItem('referensi');
      await seed(f.db, f.s, gabah.id, f.s.whA, 5000, 6000);
      const out = () => postMovement(f.s, { itemId: gabah.id, warehouseId: f.s.whA, movementType: 'Out', quantity: 1000 });
      const keyShare = (t: Tx) => t.$queryRaw`SELECT id FROM inventory_items WHERE id = ${gabah.id} FOR KEY SHARE`;

      // A document line inserted in an open transaction holds KEY SHARE on the item until it commits.
      let releaseDoc!: () => void;
      const docHeld = new Promise<void>((r) => { releaseDoc = r; });
      let docLocked!: () => void;
      const docReached = new Promise<void>((r) => { docLocked = r; });
      const doc = prisma.$transaction(async (t) => {
        await keyShare(t as Tx);
        docLocked();
        await docHeld;
      }, { timeout: 30000 });
      await docReached;
      const posted = out();
      expect(await stillPending(posted, 1000)).toBe(false);
      releaseDoc();
      await doc;
      expect((await posted).status).toBe(201);

      // And a posting holding the item rows does not make a document line wait.
      const hold = holdNextCommit();
      const second = out();
      await hold.reached;
      const docWhilePosting = prisma.$transaction(async (t) => {
        await t.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`);
        return keyShare(t as Tx);
      });
      await expect(docWhilePosting).resolves.toHaveLength(1);
      hold.release();
      expect((await second).status).toBe(201);
      expect(await stockOf(f.db, gabah.id, f.s.whA)).toMatchObject({ item: 3000, warehouse: 3000 });
    } finally {
      await f.cleanup();
    }
  });

  it('transfers of the same two items in opposite line order, at once, all go through (no deadlock)', async () => {
    const f = await committedSetup();
    try {
      const x = await f.newItem('x');
      const y = await f.newItem('y');
      for (const wh of [f.s.whA, f.s.whB]) {
        await seed(f.db, f.s, x.id, wh, 1000, 5000);
        await seed(f.db, f.s, y.id, wh, 1000, 7000);
      }
      const results = await Promise.all([
        postTransfer(f.s, f.s.whA, f.s.whB, [{ itemId: x.id, quantity: 10 }, { itemId: y.id, quantity: 10 }]),
        postTransfer(f.s, f.s.whB, f.s.whA, [{ itemId: y.id, quantity: 20 }, { itemId: x.id, quantity: 20 }]),
        postTransfer(f.s, f.s.whA, f.s.whB, [{ itemId: y.id, quantity: 30 }, { itemId: x.id, quantity: 30 }]),
        postTransfer(f.s, f.s.whB, f.s.whA, [{ itemId: x.id, quantity: 40 }, { itemId: y.id, quantity: 40 }]),
      ]);
      expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual([201, 201, 201, 201]);
      // A -> B: 10 + 30; B -> A: 20 + 40.
      for (const it of [x, y]) {
        expect(await stockOf(f.db, it.id, f.s.whA)).toMatchObject({ item: 2000, warehouse: 1020 });
        expect((await stockOf(f.db, it.id, f.s.whB)).warehouse).toBe(980);
      }
    } finally {
      await f.cleanup();
    }
  });
});

d('aggregate stock checks per warehouse', () => {
  it('STT cancel with two lines of one item, 600 + 600, when the warehouse holds 1.000: refused', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const gabah = await item(tx, s, 'gabah');
      const supplier = await tx.party.create({ data: { name: `IT-E3R3-Supplier-${tag()}`, partyType: 'Supplier', isActive: true } });
      const line = { inventoryItemId: gabah.id, warehouseId: s.whA, itemName: gabah.name, quantity: 600, unit: 'kg', lockedUnitCost: 6000 };
      const stt = await submitGoodsReceiptInTx(tx, { date: `${Y}-03-10`, partyId: supplier.id, items: [line, line] }, s.actor.userId);
      const out = await postMovement(s, { itemId: gabah.id, warehouseId: s.whA, movementType: 'AdjustmentOut', quantity: 200, unitCost: 6000 });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1000, warehouse: 1000 });

      const r = await callRoute(goodsReceiptsRouter, 'post', '/:id/cancel', { params: { id: stt.id }, body: {}, userId: s.actor.userId, role: s.actor.role });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('GR_CANCEL_INSUFFICIENT_STOCK');
      expect(r.body.error).toContain('tersedia 1000, perlu 1200');
      const whName = (await tx.warehouse.findUniqueOrThrow({ where: { id: s.whA } })).name;
      expect(r.body.error).toContain(`stok '${gabah.name}' di ${whName} tidak mencukupi`);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1000, warehouse: 1000 });
      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } })).status).toBe('Submitted');
    });
  });

  it('transfer with two lines of one item, 600 + 600, from 1.000: refused and nothing is written', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const gabah = await item(tx, s, 'gabah');
      await seed(tx, s, gabah.id, s.whA, 1000, 6000);
      const r = await postTransfer(s, s.whA, s.whB, [{ itemId: gabah.id, quantity: 600 }, { itemId: gabah.id, quantity: 600 }]);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe(STOCK_INSUFFICIENT);
      expect(r.body.error).toContain('dibutuhkan 1.200 kg');
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ warehouse: 1000 });
      expect(await tx.stockTransfer.count({ where: { fiscalYearId: s.fy.id } })).toBe(0);
    });
  });

  it('a Stok Masuk used up at its warehouse cannot be edited down or cancelled, although another warehouse holds the item', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const gabah = await item(tx, s, 'gabah');
      await seed(tx, s, gabah.id, s.whB, 1000, 6000);
      const inbound = await postMovement(s, { itemId: gabah.id, warehouseId: s.whA, movementType: 'In', quantity: 500, unitCost: 6000 });
      expect(inbound.status, JSON.stringify(inbound.body)).toBe(201);
      const out = await postMovement(s, { itemId: gabah.id, warehouseId: s.whA, movementType: 'Out', quantity: 500, unitCost: 6000 });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      // Item total 1.000 (all in B), A empty: reversing the 500 at A would drive A negative.
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1000, warehouse: 0 });

      const id = inbound.body.id as string;
      const edit = await callRoute(movementsRouter, 'put', '/:id', {
        params: { id }, body: { movementType: 'In', quantity: 100, unitCost: 6000, date: `${Y}-03-12` }, userId: s.actor.userId, role: s.actor.role,
      });
      expect(edit.status, JSON.stringify(edit.body)).toBe(400);
      expect(edit.body.code).toBe(STOCK_INSUFFICIENT);
      expect(edit.body.error).toContain('tidak cukup untuk pembalikan');
      const cancel = await callRoute(movementsRouter, 'put', '/:id/cancel', { params: { id }, userId: s.actor.userId, role: s.actor.role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(400);
      expect(cancel.body.code).toBe(STOCK_INSUFFICIENT);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1000, warehouse: 0 });
    });
  });

  it('an edit into Penyesuaian Stok - is checked at the warehouse like Stok Keluar', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const gabah = await item(tx, s, 'gabah');
      await seed(tx, s, gabah.id, s.whA, 300, 6000);
      await seed(tx, s, gabah.id, s.whB, 1000, 6000);
      const out = await postMovement(s, { itemId: gabah.id, warehouseId: s.whA, movementType: 'Out', quantity: 100, unitCost: 6000 });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      const edit = (quantity: number) => callRoute(movementsRouter, 'put', '/:id', {
        params: { id: out.body.id }, body: { movementType: 'AdjustmentOut', quantity, unitCost: 6000, date: `${Y}-03-12`, offsetAccountId: s.offsetAccountId }, userId: s.actor.userId, role: s.actor.role,
      });
      // After the reversal A holds 300 again: 301 is refused, 300 goes through.
      const refused = await edit(301);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.code).toBe(STOCK_INSUFFICIENT);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ warehouse: 200 });
      const ok = await edit(300);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1000, warehouse: 0 });
    });
  });

  it('stock opname adds a warehouse row only for a counted item with a difference', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const held = await item(tx, s, 'disimpan');
      const elsewhere = await item(tx, s, 'gudang lain');
      const found = await item(tx, s, 'ditemukan');
      await seed(tx, s, held.id, s.whA, 100, 6000);
      await seed(tx, s, elsewhere.id, s.whB, 50, 6000);
      const opname = await callRoute(stockOpnameRouter, 'post', '/', {
        body: {
          date: `${Y}-03-11`,
          warehouseId: s.whA,
          items: [
            { itemId: held.id, actualStock: 100, expectedSystemStock: 100 },
            { itemId: elsewhere.id, actualStock: 0, expectedSystemStock: 0 },
            { itemId: found.id, actualStock: 20, expectedSystemStock: 0 },
          ],
        },
        userId: s.actor.userId, role: s.actor.role,
      });
      expect(opname.status, JSON.stringify(opname.body)).toBe(201);
      const rows = await tx.inventoryStock.findMany({ where: { warehouseId: s.whA }, select: { itemId: true, currentStock: true } });
      expect(rows.map((r) => [r.itemId, Number(r.currentStock)]).sort()).toEqual([[held.id, 100], [found.id, 20]].sort());
      expect(await stockOf(tx, elsewhere.id, s.whB)).toMatchObject({ item: 50, warehouse: 50 });
    });
  });

  it('stock opname cancel whose surplus already left its warehouse is refused; a cancel claims the opname once', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const gabah = await item(tx, s, 'gabah');
      await seed(tx, s, gabah.id, s.whA, 100, 6000);
      await seed(tx, s, gabah.id, s.whB, 1000, 6000);
      const opname = await callRoute(stockOpnameRouter, 'post', '/', {
        body: { date: `${Y}-03-11`, warehouseId: s.whA, items: [{ itemId: gabah.id, actualStock: 400, expectedSystemStock: 100 }] },
        userId: s.actor.userId, role: s.actor.role,
      });
      expect(opname.status, JSON.stringify(opname.body)).toBe(201);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1400, warehouse: 400 });

      const out = await postMovement(s, { itemId: gabah.id, warehouseId: s.whA, movementType: 'Out', quantity: 350, unitCost: 6000 });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      const cancel = () => callRoute(stockOpnameRouter, 'put', '/:id/cancel', { params: { id: opname.body.id }, userId: s.actor.userId, role: s.actor.role });
      const refused = await cancel();
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.code).toBe(STOCK_INSUFFICIENT);
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: opname.body.id } })).status).toBe('Submitted');

      // Take the Out back so warehouse A holds the surplus again; the cancel then goes through once.
      const back = await callRoute(movementsRouter, 'put', '/:id/cancel', { params: { id: out.body.id }, userId: s.actor.userId, role: s.actor.role });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      const done = await cancel();
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1100, warehouse: 100 });
      const again = await cancel();
      expect(again.status).toBe(400);
      expect(await stockOf(tx, gabah.id, s.whA)).toMatchObject({ item: 1100, warehouse: 100 });
    });
  });
});
