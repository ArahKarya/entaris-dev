/**
 * Production input stock per item at the production warehouse, under the stock locks (E6-R4, the
 * production part of E3-R3, plan step 6 PR-6.2b).
 *
 * Rollback transaction, fixtures made here in fiscal year 2104:
 * - E6-R4: PK 100 kg at A, two lines of 80 kg -> 400 STOCK_INSUFFICIENT "dibutuhkan 160, tersedia
 *   100"; PK only at B and the run at A -> refused; the negative-stock bypass passes and is logged;
 * - E3-R3: GKP 700 + 500 from 1.000 -> refused; 800 kg at B (0 there) while A holds 1.000 -> refused;
 * - an edit checks the new inputs after its own reversal, at its (new) warehouse;
 * - reversing an output (cancel, edit) is checked at the movement's warehouse, not the item total;
 *   with the bypass, an output that went out since is refused by the value ledger
 *   (REVERSAL_NEEDS_TRUE_UP, until PR-6.5a).
 *
 * Committed fixtures (same year, deleted after; no value, so no journal or account balance moves):
 * - two cancels of one run at once: one cancels, the other gets STALE_STATUS, stock reversed once;
 * - an edit started while a cancel holds the run waits for it and is then refused;
 * - a cancel waiting on an edit checks the period of the run as the edit left it (the edit moves
 *   it into a period locked before the cancel wakes): PERIOD_LOCKED, nothing reversed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';

const state = vi.hoisted(() => ({ tx: null as Tx | null, client: null as PrismaClient | null }));
// Services read system accounts through the shared client: the rollback transaction while one is
// open (its mappings are remapped there), the real client for the committed races.
vi.mock('../../lib/prisma', () => ({
  prisma: new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const db = state.tx ?? state.client;
      if (!db) throw new Error('productionStockCheck test: no client');
      const value = (db as unknown as Record<string, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(db) : value;
    },
  }),
}));

import { logger } from '../../lib/logger';
import { systemAccounts } from '../../services/systemAccounts';
import { STOCK_INSUFFICIENT } from '../../services/inventory/stockLocks';
import { REVERSAL_NEEDS_TRUE_UP } from '../../services/inventory/inventoryLedger';
import { STALE_STATUS } from '../../utils/cancelClaim';
import { PERIOD_LOCKED } from '../../utils/periodGuard';
import { submitProductionRunInTx, type SubmitProductionRunInput } from '../../services/productionRunSubmit';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import { cancelProductionRunInTx } from '../../services/productionRunCancel';
import { createFiscalYear } from '../helpers/periodFixture';
import { seedStock } from '../helpers/inventoryFixture';
import { createProductionWorld, seedWorldStock, worldDate, type ProductionWorld } from '../helpers/productionFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

/** Unique fixture year of this file (plan step 6 §6.3). */
const YEAR = 2104;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

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

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inWorld(fn: (tx: Tx, world: ProductionWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      systemAccounts.invalidateCache();
      try {
        await fn(tx, await createProductionWorld(tx, YEAR));
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

type Line = { itemId: string; quantity: number };

/** A run without conversion costs; the main output's price is back-filled from the inputs. */
function runBody(w: ProductionWorld, inputs: Line[], outputs: Line[], over: Partial<SubmitProductionRunInput> = {}): SubmitProductionRunInput {
  return { date: worldDate(w), warehouseId: w.warehouseA.id, inputs, outputs, ...over };
}

async function stockAt(tx: Tx, itemId: string, warehouseId: string) {
  const row = await tx.inventoryStock.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } });
  return Number(row?.currentStock ?? 0);
}

let savepointSeq = 0;
/**
 * Runs a service call in a savepoint, as its route transaction would: a refused call leaves none of
 * its partial writes (the cancel claim, an edit's reversal) behind for the next step of the test.
 */
async function attempt<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  const name = `it_62b_${++savepointSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await fn(tx);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw e;
  }
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message);

d('production input stock at the production warehouse (rollback)', () => {
  it('E6-R4: two lines of one item are summed against the production warehouse', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'pk', 100, 5000, 'A');
      const pk = w.items.pk.id;
      const body = runBody(w, [{ itemId: pk, quantity: 80 }, { itemId: pk, quantity: 80 }], [{ itemId: w.items.beras.id, quantity: 120 }]);
      await expect(attempt(tx, (t) => submitProductionRunInTx(t, body, w.userId))).rejects.toMatchObject({
        code: STOCK_INSUFFICIENT,
        message: `Stok '${w.items.pk.name}' di gudang IT-6.1a gudang A tidak cukup. Tersedia: 100 Kg, dibutuhkan: 160 Kg. Buat penerimaan/transfer dulu.`,
      });
      expect(await stockAt(tx, pk, w.warehouseA.id)).toBe(100);
    });
  });

  it('E6-R4: stock held only at another warehouse does not cover the run; the bypass passes and is logged', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'pk', 100, 5000, 'B');
      const pk = w.items.pk.id;
      const body = runBody(w, [{ itemId: pk, quantity: 50 }], [{ itemId: w.items.beras.id, quantity: 40 }]);
      expect(await codeOf(attempt(tx, (t) => submitProductionRunInTx(t, body, w.userId)))).toBe(STOCK_INSUFFICIENT);

      const warn = vi.spyOn(logger, 'warn');
      try {
        const run = await submitProductionRunInTx(
          tx, { ...body, allowNegativeStock: true, negativeStockReason: 'IT 6.2b stok fisik ada di A' }, w.userId,
        );
        expect(run).toBeTruthy();
        const bypass = warn.mock.calls.filter((c) => String(c[1]).includes('Stock check bypassed'));
        expect(bypass.map((c) => c[0])).toEqual([expect.objectContaining({
          context: 'productionRun.submit', userId: w.userId, reason: 'IT 6.2b stok fisik ada di A',
          itemId: pk, warehouseId: w.warehouseA.id, available: 0, needed: 50,
        })]);
      } finally {
        warn.mockRestore();
      }
      expect(await stockAt(tx, pk, w.warehouseA.id)).toBe(-50);
      expect(await stockAt(tx, pk, w.warehouseB.id)).toBe(100);
    });
  });

  it('E3-R3: 700 + 500 from 1.000 is refused, and 800 at B (empty) while A holds 1.000 is refused', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1000, 6000, 'A');
      const gkp = w.items.gkp.id;
      const out = [{ itemId: w.items.beras.id, quantity: 600 }];
      expect(await codeOf(attempt(tx, (t) => submitProductionRunInTx(
        t, runBody(w, [{ itemId: gkp, quantity: 700 }, { itemId: gkp, quantity: 500 }], out), w.userId,
      )))).toBe(STOCK_INSUFFICIENT);
      expect(await codeOf(attempt(tx, (t) => submitProductionRunInTx(
        t, runBody(w, [{ itemId: gkp, quantity: 800 }], out, { warehouseId: w.warehouseB.id }), w.userId,
      )))).toBe(STOCK_INSUFFICIENT);
      // The same 800 at A passes.
      await submitProductionRunInTx(tx, runBody(w, [{ itemId: gkp, quantity: 800 }], out), w.userId);
      expect(await stockAt(tx, gkp, w.warehouseA.id)).toBe(200);
    });
  });

  it('an edit checks its new inputs after its own reversal, at the warehouse of the edited run', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1000, 6000, 'A');
      const gkp = w.items.gkp.id;
      const out = [{ itemId: w.items.beras.id, quantity: 600 }];
      const run = (await submitProductionRunInTx(tx, runBody(w, [{ itemId: gkp, quantity: 600 }], out), w.userId))!;
      expect(await stockAt(tx, gkp, w.warehouseA.id)).toBe(400);

      // 1.000 = the 400 left + the 600 the edit gives back first.
      await editProductionRunInTx(tx, run.id, runBody(w, [{ itemId: gkp, quantity: 1000 }], out), w.userId);
      expect(await stockAt(tx, gkp, w.warehouseA.id)).toBe(0);
      expect(await codeOf(attempt(tx, (t) => editProductionRunInTx(
        t, run.id, runBody(w, [{ itemId: gkp, quantity: 1001 }], out), w.userId,
      )))).toBe(STOCK_INSUFFICIENT);
      // Moving the run to B, where there is no GKP, is refused too.
      expect(await codeOf(attempt(tx, (t) => editProductionRunInTx(
        t, run.id, runBody(w, [{ itemId: gkp, quantity: 10 }], out, { warehouseId: w.warehouseB.id }), w.userId,
      )))).toBe(STOCK_INSUFFICIENT);
      expect(await stockAt(tx, gkp, w.warehouseA.id)).toBe(0);
    });
  });

  it('reversing an output is checked at the movement warehouse: stock of the item elsewhere does not cover it', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 1000, 6000, 'A');
      await seedWorldStock(tx, w, 'beras', 1000, 10000, 'B');
      const beras = w.items.beras.id;
      const first = (await submitProductionRunInTx(
        tx, runBody(w, [{ itemId: w.items.gkp.id, quantity: 1000 }], [{ itemId: beras, quantity: 600 }]), w.userId,
      ))!;
      // A second run at A uses up the 600 beras the first one made there.
      await submitProductionRunInTx(tx, runBody(w, [{ itemId: beras, quantity: 600 }], [{ itemId: w.items.pk.id, quantity: 500 }]), w.userId);
      expect(await stockAt(tx, beras, w.warehouseA.id)).toBe(0);

      await expect(attempt(tx, (t) => cancelProductionRunInTx(t, first.id, { userId: w.userId }))).rejects.toMatchObject({
        code: STOCK_INSUFFICIENT,
        message: `Tidak dapat membatalkan: stok '${w.items.beras.name}' di IT-6.1a gudang A tidak mencukupi untuk pembalikan output (tersedia 0, perlu 600). Output sudah dipakai produksi/penjualan berikutnya. Batalkan transaksi tersebut dulu.`,
      });
      expect(await codeOf(attempt(tx, (t) => editProductionRunInTx(
        t, first.id, runBody(w, [{ itemId: w.items.gkp.id, quantity: 1000 }], [{ itemId: beras, quantity: 500 }]), w.userId,
      )))).toBe(STOCK_INSUFFICIENT);
      expect(await tx.productionRun.findUniqueOrThrow({ where: { id: first.id }, select: { isCancelled: true } }))
        .toEqual({ isCancelled: false });

      // The bypass passes the stock check at A, but the 600 beras of the run went out since: on the
      // value ledger taking their value back needs a value true-up (PR-6.5a / PR-6.12), so it is
      // refused until then and nothing changes, at A or at B.
      expect(await codeOf(attempt(tx, (t) => cancelProductionRunInTx(t, first.id, {
        userId: w.userId, allowNegativeStock: true, negativeStockReason: 'IT 6.2b koreksi produksi',
      })))).toBe(REVERSAL_NEEDS_TRUE_UP);
      expect(await stockAt(tx, beras, w.warehouseA.id)).toBe(0);
      expect(await stockAt(tx, beras, w.warehouseB.id)).toBe(1000);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Committed races
// ---------------------------------------------------------------------------------------------

/** Starts `p` and reports whether it settled within `ms`; the racing call must be waiting. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

/**
 * Committed fixture: fiscal year 2104, one warehouse, GKP 1.000 kg at average 0 and a run that
 * turns 600 of it into 300 kg beras. No value, so the run posts no journal. `cleanup` deletes all.
 */
async function committedRun() {
  const db = prisma as unknown as Tx;
  const fy = await createFiscalYear(db, { year: YEAR });
  const user = await prisma.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true } });
  const wh = await prisma.warehouse.create({ data: { code: `IT-62B-${tag()}`, name: `IT-6.2b gudang ${tag()}` } });
  const item = (name: string) => prisma.inventoryItem.create({
    data: { code: `IT-62B-${name}-${tag()}`, name: `IT-6.2b ${name} ${tag()}`, unit: 'Kg', isActive: true },
  });
  const gkp = await item('GKP');
  const beras = await item('BERAS');
  const itemIds = [gkp.id, beras.id];
  const cleanup = async () => {
    const runs = (await prisma.productionRun.findMany({ where: { fiscalYearId: fy.id }, select: { id: true } })).map((r) => r.id);
    const runWhere = { productionRunId: { in: runs } };
    await prisma.productionRunItem.deleteMany({ where: runWhere });
    await prisma.productionRunCost.deleteMany({ where: runWhere });
    await prisma.productionRunProcess.deleteMany({ where: runWhere });
    await prisma.productionDowntime.deleteMany({ where: runWhere });
    await prisma.productionRunMachine.deleteMany({ where: runWhere });
    await prisma.stockMovement.deleteMany({ where: { fiscalYearId: fy.id } });
    await prisma.productionRun.deleteMany({ where: { id: { in: runs } } });
    await prisma.inventoryStock.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.warehouse.delete({ where: { id: wh.id } });
    await prisma.fiscalYear.delete({ where: { id: fy.id } });
  };
  try {
    await seedStock(db, { itemId: gkp.id, warehouseId: wh.id, qty: 1000, avg: 0, date: `${YEAR}-01-02`, fiscalYearId: fy.id, userId: user.id });
    const body: SubmitProductionRunInput = {
      date: `${YEAR}-03-05`,
      warehouseId: wh.id,
      inputs: [{ itemId: gkp.id, quantity: 600 }],
      outputs: [{ itemId: beras.id, quantity: 300 }],
    };
    const run = (await prisma.$transaction((tx) => submitProductionRunInTx(tx as Tx, body, user.id)))!;
    return { userId: user.id, wh: wh.id, gkp: gkp.id, beras: beras.id, runId: run.id, body, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** Runs `first` in a committed transaction held open before its commit, starts `second`, checks it waits, then releases. */
async function race(first: (tx: Tx) => Promise<unknown>, second: (tx: Tx) => Promise<unknown>) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const atCommit = new Promise<void>((r) => { reached = r; });
  const a = prisma.$transaction(async (tx) => {
    await first(tx as Tx);
    reached();
    await held;
  }, { timeout: 30000 });
  await atCommit;
  const b = prisma.$transaction((tx) => second(tx as Tx), { timeout: 30000 });
  const waited = await stillPending(b);
  release();
  const [ra, rb] = await Promise.allSettled([a, b]);
  return { waited, first: ra, second: rb };
}

const reasonOf = (r: PromiseSettledResult<unknown>) =>
  r.status === 'fulfilled' ? 'ok' : (r.reason as { code?: string; message?: string }).code ?? (r.reason as Error).message;

d('production run cancel claim and run lock (committed fixtures)', () => {
  it('two cancels of one run at once: one cancels, the other gets STALE_STATUS and the stock is reversed once', async () => {
    const f = await committedRun();
    try {
      const cancel = (tx: Tx) => cancelProductionRunInTx(tx, f.runId, { userId: f.userId, reason: 'IT 6.2b batal ganda' });
      const r = await race(cancel, cancel);
      expect(r.waited).toBe(true);
      expect(reasonOf(r.first)).toBe('ok');
      expect(reasonOf(r.second)).toBe(STALE_STATUS);
      const db = prisma as unknown as Tx;
      expect(await stockAt(db, f.gkp, f.wh)).toBe(1000);
      expect(await stockAt(db, f.beras, f.wh)).toBe(0);
      const totals = await prisma.inventoryItem.findMany({ where: { id: { in: [f.gkp, f.beras] } }, select: { id: true, currentStock: true } });
      expect(Object.fromEntries(totals.map((t) => [t.id, Number(t.currentStock)]))).toEqual({ [f.gkp]: 1000, [f.beras]: 0 });
      expect(await prisma.stockMovement.count({ where: { referenceId: f.runId, isCancelled: false } })).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('an edit started while a cancel holds the run waits for it and is then refused', async () => {
    const f = await committedRun();
    try {
      const r = await race(
        (tx) => cancelProductionRunInTx(tx, f.runId, { userId: f.userId }),
        (tx) => editProductionRunInTx(tx, f.runId, { ...f.body, inputs: [{ itemId: f.gkp, quantity: 500 }] }, f.userId),
      );
      expect(r.waited).toBe(true);
      expect(reasonOf(r.first)).toBe('ok');
      expect(reasonOf(r.second)).toBe('Proses produksi yang sudah dibatalkan tidak bisa diedit.');
      const db = prisma as unknown as Tx;
      expect(await stockAt(db, f.gkp, f.wh)).toBe(1000);
      expect(await stockAt(db, f.beras, f.wh)).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('a cancel waiting on an edit checks the period of the run as the edit left it', async () => {
    const f = await committedRun();
    const [lock] = await prisma.$queryRaw<{ lock_date: string | null }[]>`SELECT lock_date::text AS lock_date FROM period_lock WHERE id = 1`;
    try {
      if (!lock) await prisma.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`;
      // The edit moves the run from 5 March back to 10 January; January is locked before it commits,
      // so the cancel wakes after both. The run's old date (March) stays open.
      const r = await race(
        async (tx) => {
          await editProductionRunInTx(tx, f.runId, { ...f.body, date: `${YEAR}-01-10` }, f.userId);
          await tx.$executeRaw`UPDATE period_lock SET lock_date = ${`${YEAR}-02-01`}::date WHERE id = 1`;
        },
        (tx) => cancelProductionRunInTx(tx, f.runId, { userId: f.userId }),
      );
      expect(r.waited).toBe(true);
      expect(reasonOf(r.first)).toBe('ok');
      expect(reasonOf(r.second)).toBe(PERIOD_LOCKED);
      const run = await prisma.productionRun.findUniqueOrThrow({ where: { id: f.runId }, select: { isCancelled: true, date: true } });
      expect(run.isCancelled).toBe(false);
      expect(run.date.toISOString().slice(0, 10)).toBe(`${YEAR}-01-10`);
      const db = prisma as unknown as Tx;
      expect(await stockAt(db, f.gkp, f.wh)).toBe(400);
      expect(await stockAt(db, f.beras, f.wh)).toBe(300);
    } finally {
      await prisma.$executeRaw`UPDATE period_lock SET lock_date = ${lock?.lock_date ?? null}::date WHERE id = 1`;
      await f.cleanup();
    }
  });
});
