/**
 * Integration test: delivery note locks against the invoice, edit and cancel; stock checks of the
 * legacy reversals (E3-R3, plan step 6 PR-6.2c).
 *
 * Races (committed fixtures in fiscal year 2105, deleted after; pattern of
 * stockLocksRace.integration.test.ts). Item average and invoice rate are 0, so the invoices post
 * zero journals and no system account balance moves; they still need COGS mapped to a postable
 * account (the CI seed maps it to 5.1), otherwise the races are skipped with a message:
 * - invoice submit and delivery note cancel at once, either first: never "Cancelled and invoiced";
 * - two invoices billing one delivery note at once: one 201, one 400;
 * - delivery note edit and invoice submit at once, either first: the second is refused;
 * - two delivery notes of 4 t from 5 t at once: one 201, one 400 STOCK_INSUFFICIENT;
 * - sales return cancel waits for the AR row before it locks the return or its items (the order
 *   return submit and invoice cancel take), so it cannot deadlock against them;
 * - purchase invoice price revise waits for the invoice row before it locks the items, and then
 *   sees the cancel that held it.
 *
 * Stock checks (rollback transaction, same year):
 * - a delivery note with two lines of one item, 60 + 60, from 100 -> 400 STOCK_INSUFFICIENT;
 * - sales return cancel whose returned goods were sold again -> 400 STOCK_INSUFFICIENT; the
 *   bypass needs inventory.negative_stock and a reason; without the return the goods sold again
 *   would have gone out past zero, so the value replay refuses it (409 TRUE_UP_UNEXPLAINED) until
 *   PR-6.6 settles stock <= 0 windows;
 * - purchase invoice cancel of a legacy PI-owned stock movement already used -> 400 likewise; with
 *   the bypass it is cancelled the same way (PR-6.5a).
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
          const name = `do_locks_${++state.seq}`;
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
      if (!client) throw new Error('deliveryInvoiceLocks test: no client');
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

import deliveryOrdersRouter from '../../routes/deliveryOrders';
import salesRouter from '../../routes/sales';
import salesReturnsRouter from '../../routes/salesReturns';
import purchaseRouter from '../../routes/purchase';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { revisePurchaseInvoiceInTx } from '../../services/purchaseInvoiceRevise';
import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { STOCK_INSUFFICIENT } from '../../services/inventory/stockLocks';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import { TRUE_UP_UNEXPLAINED } from '../../services/inventory/inventoryLedger';
import { NEGATIVE_STOCK_FORBIDDEN } from '../../utils/negativeStockGate';

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
const Y = 2105;
const DAY = new Date(`${Y}-04-10`);
const DATE = `${Y}-04-12`;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      systemAccounts.invalidateCache();
      try {
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

/** Starts `p` and reports whether it settled within `ms`; the racing request must be waiting. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

/** Fiscal year Y, two warehouses, a Customer, a Supplier and an actor with doc.cancel. */
async function setup(db: Tx, caps: string[] = ['doc.cancel']) {
  const fy = await createFiscalYear(db, { year: Y });
  const warehouse = (n: string) => db.warehouse.create({ data: { code: `IT-E3SJ-${n}-${tag()}`, name: `Gudang uji SJ ${n} ${tag()}` } });
  const whA = await warehouse('A');
  const whB = await warehouse('B');
  const customer = await db.party.create({ data: { name: `IT-E3SJ Customer ${tag()}`, partyType: 'Customer', isActive: true } });
  const supplier = await db.party.create({ data: { name: `IT-E3SJ Supplier ${tag()}`, partyType: 'Supplier', isActive: true } });
  const actor = await createCapUser(db, caps);
  return { fy, whA: whA.id, whB: whB.id, customerId: customer.id, supplierId: supplier.id, actor };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const item = (db: Tx, name: string) => db.inventoryItem.create({
  data: { code: `IT-E3SJ-${tag()}`, name: `Uji SJ ${name} ${tag()}`, unit: 'kg', isActive: true },
});

const seed = (db: Tx, s: Setup, itemId: string, warehouseId: string, qty: number, avg: number) =>
  seedStock(db, { itemId, warehouseId, qty, avg, fiscalYearId: s.fy.id, userId: s.actor.userId, date: DAY });

const as = (s: Setup) => ({ userId: s.actor.userId, role: s.actor.role });

function postDelivery(s: Setup, lines: { itemId: string; name: string; warehouseId: string; quantity: number }[]): Promise<RouteResult> {
  return callRoute(deliveryOrdersRouter, 'post', '/', {
    body: {
      date: DATE,
      partyId: s.customerId,
      items: lines.map((l) => ({ inventoryItemId: l.itemId, warehouseId: l.warehouseId, itemName: l.name, quantity: l.quantity, unit: 'kg' })),
    },
    ...as(s),
  });
}

/** Invoice of every line of one delivery note at rate 0 (no amount, no COGS). */
async function postInvoice(s: Setup, deliveryOrderId: string): Promise<RouteResult> {
  const lines = await prisma.deliveryOrderItem.findMany({ where: { deliveryOrderId } });
  return callRoute(salesRouter, 'post', '/', {
    body: {
      date: DATE,
      partyId: s.customerId,
      items: lines.map((l) => ({
        itemName: l.itemName, itemType: 'product', inventoryItemId: l.inventoryItemId, warehouseId: l.warehouseId,
        deliveryOrderItemId: l.id, quantity: Number(l.quantity), unit: l.unit, rate: 0,
      })),
    },
    ...as(s),
  });
}

async function stockOf(db: Tx, itemId: string, warehouseId: string) {
  const it = await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { currentStock: true } });
  const wh = await db.inventoryStock.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } }, select: { currentStock: true } });
  return { item: Number(it.currentStock), warehouse: Number(wh?.currentStock ?? 0) };
}

/** Why the committed races cannot run here, or null: the invoice resolves COGS as a postable account. */
async function cogsUnpostable(): Promise<string | null> {
  const mapping = await prisma.systemAccountMapping.findFirst({
    where: { role: 'COGS' },
    orderBy: { sortOrder: 'asc' },
    select: { account: { select: { accountNumber: true, isGroup: true, isActive: true } } },
  });
  if (!mapping) return 'COGS is not mapped';
  if (mapping.account.isGroup || !mapping.account.isActive) {
    return `COGS is mapped to ${mapping.account.accountNumber}, a group or inactive account (the CI seed maps it to 5.1)`;
  }
  return null;
}

/** Committed fixture for one race; `cleanup` deletes everything it and the routes wrote. */
async function committedSetup() {
  const db = prisma as unknown as Tx;
  const s = await setup(db);
  const itemIds: string[] = [];
  const cleanup = async () => {
    state.beforeCommit = null;
    const fiscalYearId = s.fy.id;
    await prisma.salesReturn.deleteMany({ where: { fiscalYearId } });
    await prisma.purchaseInvoiceItem.deleteMany({ where: { purchaseInvoice: { fiscalYearId } } });
    await prisma.purchaseInvoice.deleteMany({ where: { fiscalYearId } });
    await prisma.salesInvoiceItem.deleteMany({ where: { salesInvoice: { fiscalYearId } } });
    await prisma.salesInvoice.deleteMany({ where: { fiscalYearId } });
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { fiscalYearId } } });
    await prisma.deliveryOrder.deleteMany({ where: { fiscalYearId } });
    await prisma.accountingLedgerEntry.deleteMany({ where: { fiscalYearId } });
    await prisma.journalItem.deleteMany({ where: { journalEntry: { fiscalYearId } } });
    await prisma.journalEntry.deleteMany({ where: { fiscalYearId } });
    await prisma.stockMovement.deleteMany({ where: { fiscalYearId } });
    await prisma.inventoryStock.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.inventoryStock.deleteMany({ where: { warehouseId: { in: [s.whA, s.whB] } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: [s.whA, s.whB] } } });
    await prisma.party.deleteMany({ where: { id: { in: [s.customerId, s.supplierId] } } });
    await prisma.fiscalYear.delete({ where: { id: fiscalYearId } });
    await prisma.user.delete({ where: { id: s.actor.userId } });
    // Capabilities go with the role (cascade).
    await prisma.role.delete({ where: { key: s.actor.role } });
    invalidatePermissionCache();
  };
  const newItem = async (name: string) => {
    const it = await item(db, name);
    itemIds.push(it.id);
    return it;
  };
  /** A delivery note of 300 of a fresh item (500 at A, average 0), committed. */
  const delivered = async () => {
    const beras = await newItem('beras');
    await seed(db, s, beras.id, s.whA, 500, 0);
    const r = await postDelivery(s, [{ itemId: beras.id, name: beras.name, warehouseId: s.whA, quantity: 300 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { beras, doId: r.body.id as string };
  };
  return { s, db, newItem, delivered, cleanup };
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

/** Runs `first` up to its commit, starts `second`, checks that it waits, then lets both finish. */
async function race(first: () => Promise<RouteResult>, second: () => Promise<RouteResult>) {
  const hold = holdNextCommit();
  const a = first();
  await hold.reached;
  const b = second();
  expect(await stillPending(b)).toBe(true);
  hold.release();
  return Promise.all([a, b]);
}

const cancelDelivery = (s: Setup, id: string) =>
  callRoute(deliveryOrdersRouter, 'post', '/:id/cancel', { params: { id }, ...as(s) });

d('delivery note against invoice, edit and cancel (committed fixtures)', () => {
  it('invoice submit first, delivery note cancel waits and is refused: the note stays invoiced', async (ctx) => {
    const skip = await cogsUnpostable();
    if (skip) return ctx.skip(skip);
    const f = await committedSetup();
    try {
      const { beras, doId } = await f.delivered();
      const [inv, cancel] = await race(() => postInvoice(f.s, doId), () => cancelDelivery(f.s, doId));
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(400);
      expect(cancel.body.error).toBe('Batalkan invoice terkait dulu sebelum batalkan surat jalan.');
      const note = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: doId } });
      expect(note).toMatchObject({ status: 'Submitted', invoiceId: inv.body.id });
      expect(await stockOf(f.db, beras.id, f.s.whA)).toEqual({ item: 200, warehouse: 200 });
    } finally {
      await f.cleanup();
    }
  });

  it('delivery note cancel first, invoice submit waits and is refused: no invoice of a cancelled note', async (ctx) => {
    const skip = await cogsUnpostable();
    if (skip) return ctx.skip(skip);
    const f = await committedSetup();
    try {
      const { beras, doId } = await f.delivered();
      const [cancel, inv] = await race(() => cancelDelivery(f.s, doId), () => postInvoice(f.s, doId));
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect(inv.status, JSON.stringify(inv.body)).toBe(400);
      expect(inv.body.error).toMatch(/^Surat Jalan .+ sudah dibatalkan dan tidak bisa di-invoice\.$/);
      expect(await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: doId } })).toMatchObject({ status: 'Cancelled', invoiceId: null });
      expect(await prisma.salesInvoice.count({ where: { fiscalYearId: f.s.fy.id } })).toBe(0);
      expect(await stockOf(f.db, beras.id, f.s.whA)).toEqual({ item: 500, warehouse: 500 });
    } finally {
      await f.cleanup();
    }
  });

  it('two invoices billing one delivery note at once: one passes, the other is refused', async (ctx) => {
    const skip = await cogsUnpostable();
    if (skip) return ctx.skip(skip);
    const f = await committedSetup();
    try {
      const { doId } = await f.delivered();
      const [a, b] = await race(() => postInvoice(f.s, doId), () => postInvoice(f.s, doId));
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(b.status, JSON.stringify(b.body)).toBe(400);
      expect(b.body.error).toMatch(/^Surat Jalan .+ sudah ada di invoice lain\.$/);
      expect(await prisma.salesInvoice.count({ where: { fiscalYearId: f.s.fy.id } })).toBe(1);
      expect((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: doId } })).invoiceId).toBe(a.body.id);
    } finally {
      await f.cleanup();
    }
  });

  it('delivery note edit and invoice submit at once: the one that waits is refused, either way', async (ctx) => {
    const skip = await cogsUnpostable();
    if (skip) return ctx.skip(skip);
    const f = await committedSetup();
    try {
      const { beras, doId } = await f.delivered();
      const edit = () => callRoute(deliveryOrdersRouter, 'put', '/:id', {
        params: { id: doId },
        body: { date: DATE, partyId: f.s.customerId, items: [{ inventoryItemId: beras.id, warehouseId: f.s.whA, itemName: beras.name, quantity: 250, unit: 'kg' }] },
        ...as(f.s),
      });

      // Edit first: its new lines replace the ones the invoice bills.
      const [edited, inv] = await race(edit, () => postInvoice(f.s, doId));
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(inv.status, JSON.stringify(inv.body)).toBe(400);
      expect(inv.body.error).toMatch(/^Baris dari Surat Jalan tidak ditemukan/);
      expect(await stockOf(f.db, beras.id, f.s.whA)).toEqual({ item: 250, warehouse: 250 });

      // Invoice first: the edit then sees the note invoiced.
      const [inv2, edited2] = await race(() => postInvoice(f.s, doId), edit);
      expect(inv2.status, JSON.stringify(inv2.body)).toBe(201);
      expect(edited2.status, JSON.stringify(edited2.body)).toBe(400);
      expect(edited2.body.error).toBe('Surat jalan sudah masuk invoice. Batalkan dulu invoice terkait sebelum edit.');
      expect(await stockOf(f.db, beras.id, f.s.whA)).toEqual({ item: 250, warehouse: 250 });
    } finally {
      await f.cleanup();
    }
  });

  it('two delivery notes of 4 t from 5 t at once: one passes, the other is refused, 1 t is left', async () => {
    const f = await committedSetup();
    try {
      const gabah = await f.newItem('gabah');
      await seed(f.db, f.s, gabah.id, f.s.whA, 5000, 0);
      const ship = () => postDelivery(f.s, [{ itemId: gabah.id, name: gabah.name, warehouseId: f.s.whA, quantity: 4000 }]);
      const [a, b] = await race(ship, ship);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(b.status, JSON.stringify(b.body)).toBe(400);
      expect(b.body.code).toBe(STOCK_INSUFFICIENT);
      expect(await stockOf(f.db, gabah.id, f.s.whA)).toEqual({ item: 1000, warehouse: 1000 });
    } finally {
      await f.cleanup();
    }
  });

  it('sales return cancel takes the AR row before the return and its items', async () => {
    const f = await committedSetup();
    const holder = await pool.connect();
    const probe = await pool.connect();
    try {
      // A zero-value return that restocked 40 at A (no journals, so only the lock order matters).
      const beras = await f.newItem('beras');
      await seed(f.db, f.s, beras.id, f.s.whA, 40, 0);
      const invoice = await prisma.salesInvoice.create({
        data: {
          invoiceNumber: `IT-E3SJ-SI-${tag()}`, date: DAY, partyId: f.s.customerId, status: 'Paid',
          grandTotal: 0, outstanding: 0, fiscalYearId: f.s.fy.id, createdBy: f.s.actor.userId,
        },
      });
      const ret = await prisma.salesReturn.create({
        data: {
          returnNumber: `IT-E3SJ-RN-${tag()}`, date: DAY, partyId: f.s.customerId, salesInvoiceId: invoice.id,
          subtotal: 0, totalReturn: 0, fiscalYearId: f.s.fy.id, createdBy: f.s.actor.userId,
        },
      });
      const sm = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: beras.id, warehouseId: f.s.whA } });
      await prisma.stockMovement.update({ where: { id: sm.id }, data: { referenceType: 'SalesReturn', referenceId: ret.id } });

      // Another transaction (a return submit, a payment) holds AR.
      const ar = await systemAccounts.getAccount('AR');
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [ar.id]);
      const cancel = callRoute(salesReturnsRouter, 'post', '/:id/cancel', { params: { id: ret.id }, ...as(f.s) });
      expect(await stillPending(cancel)).toBe(true);
      // While it waits for AR, the cancel holds neither the return nor its item rows.
      await probe.query('BEGIN');
      await probe.query('SELECT id FROM sales_returns WHERE id = $1 FOR UPDATE NOWAIT', [ret.id]);
      await probe.query('SELECT id FROM inventory_items WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [beras.id]);
      await probe.query('ROLLBACK');
      await holder.query('ROLLBACK');

      const done = await cancel;
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect((await prisma.salesReturn.findUniqueOrThrow({ where: { id: ret.id } })).status).toBe('Cancelled');
      expect(await stockOf(f.db, beras.id, f.s.whA)).toEqual({ item: 0, warehouse: 0 });
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      probe.release();
      holder.release();
      await f.cleanup();
    }
  });

  it('purchase invoice revise takes the invoice row before its items, then sees the cancel', async () => {
    const f = await committedSetup();
    const holder = await pool.connect();
    const probe = await pool.connect();
    try {
      const gkp = await f.newItem('gkp');
      const ar = await systemAccounts.getAccount('AR');
      const pi = await prisma.purchaseInvoice.create({
        data: {
          invoiceNumber: `IT-E3SJ-PI-${tag()}`, date: DAY, partyId: f.s.supplierId, status: 'Submitted',
          grandTotal: 0, outstanding: 0, fiscalYearId: f.s.fy.id, createdBy: f.s.actor.userId,
          items: { create: [{ itemName: gkp.name, inventoryItemId: gkp.id, quantity: 10, unit: 'kg', rate: 0, amount: 0, accountId: ar.id }] },
        },
        include: { items: true },
      });

      // A cancel of the same invoice holds its row.
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM purchase_invoices WHERE id = $1 FOR UPDATE', [pi.id]);
      const revise = prisma.$transaction((tx) => revisePurchaseInvoiceInTx(
        tx as Tx, { invoiceId: pi.id, lines: [{ itemId: pi.items[0].id, newRate: 0 }], reason: 'supplier koreksi harga faktur' }, f.s.actor.userId,
      )).then(() => 'revised', (e: Error) => e.message);
      expect(await stillPending(revise)).toBe(true);
      // While it waits for the invoice, the revise holds no item row.
      await probe.query('BEGIN');
      await probe.query('SELECT id FROM inventory_items WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [gkp.id]);
      await probe.query('ROLLBACK');
      await holder.query(`UPDATE purchase_invoices SET status = 'Cancelled' WHERE id = $1`, [pi.id]);
      await holder.query('COMMIT');

      expect(await revise).toBe('Invoice sudah dibatalkan, tidak bisa direvisi.');
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      probe.release();
      holder.release();
      await f.cleanup();
    }
  });
});

/** Fixture leaf accounts mapped to COGS and SALES_RETURN, inside the rollback transaction only. */
async function mapSalesAccounts(tx: Tx) {
  for (const [role, rootType] of [['COGS', 'EXPENSE'], ['SALES_RETURN', 'REVENUE']] as const) {
    const acc = await tx.account.create({
      data: { name: `IT-E3SJ ${role}`, accountNumber: `IT-E3SJ-${role}-${tag()}`, accountType: rootType, rootType },
    });
    await tx.systemAccountMapping.deleteMany({ where: { role } });
    await tx.systemAccountMapping.create({ data: { role, accountId: acc.id } });
  }
  systemAccounts.invalidateCache();
}

d('stock checks of delivery notes and legacy reversals', () => {
  it('a delivery note with two lines of one item, 60 + 60, from 100: refused and nothing is written', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const beras = await item(tx, 'beras');
      await seed(tx, s, beras.id, s.whA, 100, 5000);
      const line = { itemId: beras.id, name: beras.name, warehouseId: s.whA, quantity: 60 };
      const r = await postDelivery(s, [line, line]);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe(STOCK_INSUFFICIENT);
      expect(r.body.error).toContain('dibutuhkan: 120 kg');
      expect(await stockOf(tx, beras.id, s.whA)).toEqual({ item: 100, warehouse: 100 });
      expect(await tx.deliveryOrder.count({ where: { fiscalYearId: s.fy.id } })).toBe(0);
    });
  });

  it('sales return cancel whose goods were sold again: refused, and the bypass needs the capability', async () => {
    await inRollback(async (tx) => {
      await mapSalesAccounts(tx);
      const s = await setup(tx);
      const beras = await item(tx, 'beras');
      await seed(tx, s, beras.id, s.whA, 100, 5000);
      const date = DATE;
      const delivery = await submitDeliveryOrderInTx(
        tx, { date, partyId: s.customerId, items: [{ inventoryItemId: beras.id, warehouseId: s.whA, itemName: beras.name, quantity: 100, unit: 'kg' }] }, s.actor.userId,
      );
      const invoice = await submitSalesInvoiceInTx(tx, {
        date, partyId: s.customerId,
        items: [{ itemName: beras.name, itemType: 'product', inventoryItemId: beras.id, warehouseId: s.whA, deliveryOrderItemId: delivery.items[0].id, quantity: 100, unit: 'kg', rate: 8000 }],
      }, s.actor.userId);
      const src = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      const ret = await submitSalesReturnInTx(tx, {
        salesInvoiceId: invoice.id, date,
        items: [{ salesInvoiceItemId: src.id, quantity: 40, restock: true, warehouseId: s.whA }],
      } as any, s.actor.userId);
      // The 40 returned are delivered again, 30 of them; A keeps 10.
      const again = await postDelivery(s, [{ itemId: beras.id, name: beras.name, warehouseId: s.whA, quantity: 30 }]);
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(await stockOf(tx, beras.id, s.whA)).toEqual({ item: 10, warehouse: 10 });

      const cancel = (actor: Setup['actor'], body: Record<string, unknown> = {}) =>
        callRoute(salesReturnsRouter, 'post', '/:id/cancel', { params: { id: ret!.id }, body, userId: actor.userId, role: actor.role });
      const refused = await cancel(s.actor);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.code).toBe(STOCK_INSUFFICIENT);
      expect(refused.body.error).toContain('tidak cukup untuk pembalikan: tersedia 10 kg, dibutuhkan 40 kg');
      expect((await tx.salesReturn.findUniqueOrThrow({ where: { id: ret!.id } })).status).toBe('Submitted');
      expect(await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${ret!.returnNumber}` } })).toMatchObject({ status: 'Submitted' });

      const bypass = { allowNegativeStock: true, negativeStockReason: 'retur salah input, barang sudah terjual' };
      const forbidden = await cancel(s.actor, bypass);
      expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(403);
      expect(forbidden.body.code).toBe(NEGATIVE_STOCK_FORBIDDEN);
      const noReason = await cancel(s.actor, { allowNegativeStock: true });
      expect(noReason.status).toBe(400);

      // The bypass passes the stock check; goods of the item went out since, so the value ledger
      // replays the item (PR-6.5a). Without the return the 30 delivered again would have gone out
      // past zero, where they did not: valuing them is a guess until PR-6.6, so it is refused.
      const admin = await createCapUser(tx, ['doc.cancel', 'inventory.negative_stock']);
      const forced = await cancel(admin, bypass);
      expect(forced.status, JSON.stringify(forced.body)).toBe(409);
      expect(forced.body.code).toBe(TRUE_UP_UNEXPLAINED);
      expect(await stockOf(tx, beras.id, s.whA)).toEqual({ item: 10, warehouse: 10 });
      expect((await tx.salesReturn.findUniqueOrThrow({ where: { id: ret!.id } })).status).toBe('Submitted');
      await assertLedgerInvariant(tx, [beras.id], { warehouses: true });
    });
  });

  it('purchase invoice cancel of a legacy PI-owned movement already used: refused without the bypass', async () => {
    await inRollback(async (tx) => {
      const s = await setup(tx);
      const gkp = await item(tx, 'gkp');
      await seed(tx, s, gkp.id, s.whA, 100, 4000);
      await seed(tx, s, gkp.id, s.whB, 500, 4000);
      // A legacy standalone invoice that brought the 100 at A in itself (no journal, no amount).
      const pi = await tx.purchaseInvoice.create({
        data: {
          invoiceNumber: `IT-E3SJ-PI-${tag()}`, date: DAY, partyId: s.supplierId, status: 'Submitted',
          grandTotal: 0, outstanding: 0, fiscalYearId: s.fy.id, createdBy: s.actor.userId,
        },
      });
      const own = await tx.stockMovement.findFirstOrThrow({ where: { itemId: gkp.id, warehouseId: s.whA } });
      await tx.stockMovement.update({ where: { id: own.id }, data: { referenceType: 'PurchaseInvoice', referenceId: pi.id } });
      const out = await postDelivery(s, [{ itemId: gkp.id, name: gkp.name, warehouseId: s.whA, quantity: 80 }]);
      expect(out.status, JSON.stringify(out.body)).toBe(201);

      const cancel = (actor: Setup['actor'], body: Record<string, unknown> = {}) =>
        callRoute(purchaseRouter, 'post', '/:id/cancel', { params: { id: pi.id }, body, userId: actor.userId, role: actor.role });
      // B holds 500 of the item, but the movement's own warehouse A holds 20.
      const refused = await cancel(s.actor);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.code).toBe(STOCK_INSUFFICIENT);
      expect(refused.body.error).toContain('tersedia 20 kg, dibutuhkan 100 kg');
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Submitted');

      // The bypass passes the stock check; the value true-up (PR-6.5a) replays the item: all at
      // 4.000, so the receipt comes back exactly (true-up 0) and warehouse A goes to −80.
      const admin = await createCapUser(tx, ['doc.cancel', 'inventory.negative_stock']);
      const forced = await cancel(admin, { allowNegativeStock: true, negativeStockReason: 'faktur lama salah, stok sudah dikirim' });
      expect(forced.status, JSON.stringify(forced.body)).toBe(200);
      expect(await stockOf(tx, gkp.id, s.whA)).toEqual({ item: 420, warehouse: -80 });
      expect((await tx.inventoryItem.findUniqueOrThrow({ where: { id: gkp.id } })).stockValue.toFixed(2)).toBe('1680000.00');
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Cancelled');
      await assertLedgerInvariant(tx, [gkp.id], { warehouses: true });
    });
  });
});
