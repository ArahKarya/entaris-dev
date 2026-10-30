/**
 * Integration test: the monthly period lock (E1-R7, PR-7b).
 *
 * Lock date 31 Mar, today 25 Apr: a 15 Mar invoice is rejected PERIOD_LOCKED, cancelling a March
 * invoice is rejected, a March quotation or purchase order is still accepted. PUT /period-lock
 * needs period.lock, a reason to move the lock back, and a past date; every change is logged.
 * Bulk depreciation checks a mid-month lock against the 1st-of-month dates it posts; generate-dummy
 * skips the lock; firstOpenBusinessDay skips a closed year.
 *
 * The lock row is global. Every case changes it only inside a rollback transaction (the route
 * harness makes the route's own transaction a savepoint), so nothing is committed; the cases stay
 * short because other test files' postings wait on that row while a case holds it. Fiscal years
 * are far-future fixtures with the Date clock moved into them.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { closedThenOpenYears, createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { BusinessError } from '../../utils/errors';
import { FISCAL_YEAR_MISSING, PERIOD_LOCKED, assertPeriodOpen, firstOpenBusinessDay } from '../../utils/periodGuard';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { cancelSalesInvoiceInTx } from '../../services/invoiceCancellation';
import { submitPurchaseOrderInTx } from '../../services/purchaseOrderSubmit';
import { PERIOD_LOCK_NOT_PAST, PERIOD_LOCK_REASON_REQUIRED, setPeriodLockInTx } from '../../services/periodLock';
import periodLockRouter from '../../routes/periodLock';
import quotationsRouter from '../../routes/quotations';
import fixedAssetsRouter from '../../routes/fixedAssets';
import dummyDataRouter from '../../routes/settings/dummyData';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let adminId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  adminId = user.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

afterEach(() => {
  vi.useRealTimers();
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
    }, { timeout: 30000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2096;

/** Only the Date clock moves; timers stay real so the transaction timeout keeps working. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
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

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function customer(tx: Tx) {
  return tx.party.create({ data: { name: `IT-LOCK-Customer-${tag()}`, partyType: 'Customer', isActive: true } });
}

function serviceInvoice(tx: Tx, partyId: string, date: string, rate = 5_000_000) {
  return submitSalesInvoiceInTx(
    tx,
    { date, partyId, items: [{ itemName: 'Jasa uji kunci periode', itemType: 'service', quantity: 1, rate }] } as any,
    adminId,
  );
}

/** Sets the lock through PUT /period-lock as a role holding only period.lock (25 Apr by default). */
async function lockAt(tx: Tx, lockDate: string | null, reason?: string) {
  const user = await createCapUser(tx, ['period.lock']);
  return callRoute(periodLockRouter, 'put', '/', { ...user, body: { lockDate, reason } });
}

async function lockRow(tx: Tx) {
  const rows = await tx.$queryRaw<{ lock_date: string | null }[]>`SELECT lock_date::text AS lock_date FROM period_lock WHERE id = 1`;
  return rows[0]?.lock_date ?? null;
}

d('period lock: postings and cancels', () => {
  it('lock 31 Mar, today 25 Apr: an invoice dated 15 Mar is rejected PERIOD_LOCKED; 1 Apr still posts', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      const party = await customer(tx);
      clockAt(`${Y}-04-25T03:00:00Z`);
      const r = await lockAt(tx, `${Y}-03-31`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ lockDate: `${Y}-03-31`, changed: true });

      const before = await tx.salesInvoice.count({ where: { fiscalYearId: fy.id } });
      expect(await codeOf(inRouteTx((t) => serviceInvoice(t, party.id, `${Y}-03-15`)))).toBe(PERIOD_LOCKED);
      expect(await tx.salesInvoice.count({ where: { fiscalYearId: fy.id } })).toBe(before);

      const april = await inRouteTx((t) => serviceInvoice(t, party.id, `${Y}-04-01`));
      expect(april.status).not.toBe('Cancelled');
    });
  });

  it('rejects cancelling a March invoice once March is locked; the invoice and its journal stay as they were', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const party = await customer(tx);
      clockAt(`${Y}-03-20T03:00:00Z`);
      const invoice = await inRouteTx((t) => serviceInvoice(t, party.id, `${Y}-03-10`));
      clockAt(`${Y}-04-25T03:00:00Z`);
      expect((await lockAt(tx, `${Y}-03-31`)).status).toBe(200);

      expect(await codeOf(inRouteTx((t) => cancelSalesInvoiceInTx(t, invoice.id)))).toBe(PERIOD_LOCKED);

      const after = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe('Submitted');
      expect(Number(after.outstanding)).toBe(5_000_000);
      const journals = await tx.journalEntry.findMany({ where: { entryNumber: { startsWith: `JV-${invoice.invoiceNumber}` } } });
      expect(journals.length).toBeGreaterThan(0);
      expect(journals.every((j) => j.status === 'Submitted')).toBe(true);
    });
  });

  it('accepts a quotation and a purchase order dated in the locked March', async () => {
    await inRollback(async (tx) => {
      const year = await createFiscalYear(tx, { year: Y });
      const party = await customer(tx);
      clockAt(`${Y}-04-25T03:00:00Z`);
      expect((await lockAt(tx, `${Y}-03-31`)).status).toBe(200);

      const user = await createCapUser(tx, []);
      const q = await callRoute(quotationsRouter, 'post', '/', {
        ...user,
        body: {
          date: `${Y}-03-15`,
          validUntil: `${Y}-03-31`,
          partyId: party.id,
          items: [{ itemName: 'Jasa uji kunci periode', itemType: 'service', quantity: 1, rate: 1_000_000 }],
        },
      });
      expect(q.status, JSON.stringify(q.body)).toBe(201);
      expect(q.body.fiscalYearId).toBe(year.id);

      const po = await inRouteTx((t) =>
        submitPurchaseOrderInTx(t, { date: `${Y}-03-15`, saveAs: 'draft', items: [{ itemName: 'Barang uji', quantity: 2, unit: 'pcs', estimatedRate: 10_000 }] }, adminId),
      );
      expect(po.fiscalYearId).toBe(year.id);
    });
  });

  it('bulk depreciation checks a mid-month lock against the posted 1st-of-month date, like a single post', async () => {
    await inRollback(async (tx) => {
      const year = await createFiscalYear(tx, { year: Y });
      const account = (rootType: 'ASSET' | 'EXPENSE') =>
        tx.account.create({ data: { name: `IT-LOCK ${rootType}`, accountNumber: `IT-LOCK-${tag()}`, accountType: rootType, rootType } });
      const [assetAccount, expense, accum] = [await account('ASSET'), await account('EXPENSE'), await account('ASSET')];
      const asset = await tx.fixedAsset.create({
        data: {
          assetNumber: `IT-LOCK-${tag()}`,
          name: `IT-LOCK Mesin ${tag()}`,
          category: 'IT-LOCK',
          acquisitionDate: new Date(`${Y}-03-01`),
          acquisitionCost: 12_000_000,
          usefulLifeMonths: 12,
          bookValue: 12_000_000,
          assetAccountId: assetAccount.id,
          depreciationAccountId: expense.id,
          accumulatedDepAccountId: accum.id,
          fiscalYearId: year.id,
          createdBy: adminId,
        },
      });
      const entry = await tx.depreciationEntry.create({
        data: { fixedAssetId: asset.id, periodDate: new Date(`${Y}-04-01`), amount: 1_000_000 },
      });
      clockAt(`${Y}-04-25T03:00:00Z`);
      expect((await lockAt(tx, `${Y}-04-09`)).status).toBe(200);

      const bulk = () => callRoute(fixedAssetsRouter, 'post', '/depreciate-bulk', { body: { month: `${Y}-04` }, userId: adminId, role: 'Admin' });
      const locked = await bulk();
      expect(locked.status, JSON.stringify(locked.body)).toBe(400);
      expect(locked.body.code).toBe(PERIOD_LOCKED);
      expect(await tx.depreciationEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ isPosted: false, journalEntryId: null });
      expect(await tx.journalEntry.count({ where: { sourceType: 'DEPRECIATION', fiscalYearId: year.id } })).toBe(0);
      expect(Number((await tx.account.findUniqueOrThrow({ where: { id: expense.id } })).balance)).toBe(0);

      expect((await lockAt(tx, `${Y}-03-31`, 'Buka April untuk penyusutan')).status).toBe(200);
      const posted = await bulk();
      expect(posted.status, JSON.stringify(posted.body)).toBe(200);
      expect(posted.body.posted).toBe(1);
      expect(await tx.depreciationEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ isPosted: true });
    });
  });

  it('generate-dummy skips the lock: demo data dated in the locked months is still created', async () => {
    await inRollback(async (tx) => {
      // The route refuses to run while demo data exists; hide any (rolled back with the rest).
      await tx.party.updateMany({ where: { isDummy: true }, data: { isDummy: false } });
      const year = await createFiscalYear(tx, { year: Y });
      clockAt(`${Y}-06-15T03:00:00Z`);
      expect((await lockAt(tx, `${Y}-05-31`)).status).toBe(200);

      const r = await callRoute(dummyDataRouter, 'post', '/generate-dummy', { userId: adminId, role: 'Admin' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // Stock movements before June (opening stock on 1 April, April and May runs) are in the locked window.
      const opening = await tx.stockMovement.count({ where: { fiscalYearId: year.id, date: { lt: new Date(`${Y}-06-01`) } } });
      expect(opening).toBeGreaterThan(0);
      expect(await lockRow(tx)).toBe(`${Y}-05-31`);
    });
  }, 60000);
});

d('period lock: PUT /period-lock', () => {
  it('rejects a role without period.lock with 403 and leaves the lock unchanged', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-04-25T03:00:00Z`);
      const before = await lockRow(tx);
      const user = await createCapUser(tx, []);
      const r = await callRoute(periodLockRouter, 'put', '/', { ...user, body: { lockDate: `${Y}-03-31` } });
      expect(r.status).toBe(403);
      expect(await lockRow(tx)).toBe(before);
    });
  });

  it('moving the lock back without a reason is 400; with a reason it is saved and logged', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-04-25T03:00:00Z`);
      expect((await lockAt(tx, `${Y}-03-31`)).status).toBe(200);

      const noReason = await lockAt(tx, `${Y}-02-28`);
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe(PERIOD_LOCK_REASON_REQUIRED);
      const shortReason = await lockAt(tx, `${Y}-02-28`, ' ab ');
      expect(shortReason.body.code).toBe(PERIOD_LOCK_REASON_REQUIRED);
      const clearNoReason = await lockAt(tx, null);
      expect(clearNoReason.body.code).toBe(PERIOD_LOCK_REASON_REQUIRED);
      expect(await lockRow(tx)).toBe(`${Y}-03-31`);

      const back = await lockAt(tx, `${Y}-02-28`, 'Koreksi biaya Maret');
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(back.body).toMatchObject({ lockDate: `${Y}-02-28`, previousLockDate: `${Y}-03-31`, changed: true });
      expect(await lockRow(tx)).toBe(`${Y}-02-28`);

      const log = await tx.periodLockLog.findUniqueOrThrow({ where: { id: back.body.logId } });
      expect(log.oldDate?.toISOString().slice(0, 10)).toBe(`${Y}-03-31`);
      expect(log.newDate?.toISOString().slice(0, 10)).toBe(`${Y}-02-28`);
      expect(log.reason).toBe('Koreksi biaya Maret');

      const cleared = await lockAt(tx, null, 'Buka semua periode');
      expect(cleared.status).toBe(200);
      expect(await lockRow(tx)).toBeNull();
    });
  });

  it('moving forward needs no reason; the same date again changes and logs nothing', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-04-25T03:00:00Z`);
      const first = await lockAt(tx, `${Y}-02-28`);
      const forward = await lockAt(tx, `${Y}-03-31`);
      expect(forward.status).toBe(200);
      expect(forward.body).toMatchObject({ previousLockDate: `${Y}-02-28`, changed: true });
      const logs = await tx.periodLockLog.count({ where: { id: { in: [first.body.logId, forward.body.logId] } } });
      expect(logs).toBe(2);

      const same = await lockAt(tx, `${Y}-03-31`);
      expect(same.body).toMatchObject({ changed: false, logId: null });
    });
  });

  it('rejects a lock date of today or later (WIB business day)', async () => {
    await inRollback(async (tx) => {
      // 25 Apr 18:00Z = 26 Apr 01:00 WIB.
      clockAt(`${Y}-04-25T18:00:00Z`);
      const today = await lockAt(tx, `${Y}-04-26`);
      expect(today.status).toBe(400);
      expect(today.body.code).toBe(PERIOD_LOCK_NOT_PAST);
      expect((await lockAt(tx, `${Y}-05-01`)).body.code).toBe(PERIOD_LOCK_NOT_PAST);
      expect((await lockAt(tx, `${Y}-04-25`)).status).toBe(200);
    });
  });

  it('rejects a malformed or impossible date with 400', async () => {
    await inRollback(async (tx) => {
      expect((await lockAt(tx, '31-03-2096')).status).toBe(400);
      expect((await lockAt(tx, `${Y}-02-30`)).status).toBe(400);
      const user = await createCapUser(tx, ['period.lock']);
      expect((await callRoute(periodLockRouter, 'put', '/', { ...user, body: {} })).status).toBe(400);
    });
  });

  it('GET returns the lock date, who set it, and the history newest first', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-04-25T03:00:00Z`);
      const user = await createCapUser(tx, ['period.lock']);
      await callRoute(periodLockRouter, 'put', '/', { ...user, body: { lockDate: `${Y}-03-31` } });
      vi.setSystemTime(new Date(`${Y}-04-25T04:00:00Z`));
      await callRoute(periodLockRouter, 'put', '/', { ...user, body: { lockDate: `${Y}-01-31`, reason: 'Revisi Februari' } });

      const r = await callRoute(periodLockRouter, 'get', '/', { userId: user.userId, role: user.role });
      expect(r.status).toBe(200);
      expect(r.body.lockDate).toBe(`${Y}-01-31`);
      expect(r.body.updatedBy?.id).toBe(user.userId);
      expect(r.body.logs.slice(0, 2)).toMatchObject([
        { oldDate: `${Y}-03-31`, newDate: `${Y}-01-31`, reason: 'Revisi Februari', user: { id: user.userId } },
        { newDate: `${Y}-03-31`, reason: null },
      ]);
    });
  });
});

d('period lock: row locking', () => {
  it('a posting holds the lock row until it ends, so a lock change cannot slip in meanwhile', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const posting = prisma.$transaction(async (tx) => {
      const year = await createFiscalYear(tx, { year: Y });
      await assertPeriodOpen(tx, { fiscalYearId: year.id, date: new Date(`${Y}-06-15T03:00:00Z`) }, 'invoice');
      locked();
      await held;
      throw new RollbackSentinel();
    }).catch((e) => { if (!(e instanceof RollbackSentinel)) throw e; });

    const other = await pool.connect();
    try {
      await isLocked;
      await expect(other.query('SELECT id FROM period_lock WHERE id = 1 FOR UPDATE NOWAIT')).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release();
      await posting;
      other.release();
    }
  });

  it('a lock change waits for a running posting, then proceeds', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const events: string[] = [];
    const posting = prisma.$transaction(async (tx) => {
      const year = await createFiscalYear(tx, { year: Y });
      await assertPeriodOpen(tx, { fiscalYearId: year.id, date: new Date(`${Y}-06-15T03:00:00Z`) }, 'invoice');
      locked();
      await held;
      events.push('posting ends');
      throw new RollbackSentinel();
    }).catch((e) => { if (!(e instanceof RollbackSentinel)) throw e; });

    await isLocked;
    const change = prisma.$transaction(async (tx) => {
      // Never committed: the lock row is global. The reason covers a stored lock later than 2001.
      const result = await setPeriodLockInTx(tx, { lockDate: '2001-01-31', reason: 'Uji antrean kunci', userId: adminId, today: '2001-02-01' });
      events.push('lock changed');
      expect(result.changed).toBe(true);
      expect(await lockRow(tx)).toBe('2001-01-31');
      throw new RollbackSentinel();
    }, { timeout: 15000 }).catch((e) => { if (!(e instanceof RollbackSentinel)) throw e; });

    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
    release();
    await Promise.all([posting, change]);
    expect(events).toEqual(['posting ends', 'lock changed']);
  }, 20000);
});

d('period lock: firstOpenBusinessDay', () => {
  /** Sets the lock inside the rollback transaction; the reason covers a backward move from the stored date. */
  const setLock = (tx: Tx, lockDate: string | null, today: string) =>
    setPeriodLockInTx(tx, { lockDate, reason: 'Uji hari terbuka pertama', userId: adminId, today });

  it('is null without a lock and the day after the lock when that day is in an open year', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      await setLock(tx, null, `${Y}-06-15`);
      expect(await firstOpenBusinessDay(tx)).toBeNull();
      await setLock(tx, `${Y}-04-30`, `${Y}-06-15`);
      expect(await firstOpenBusinessDay(tx)).toBe(`${Y}-05-01`);
    });
  });

  it('skips a closed year to the start of the next open one', async () => {
    await inRollback(async (tx) => {
      await closedThenOpenYears(tx, Y - 1);
      await setLock(tx, `${Y - 1}-11-30`, `${Y}-01-15`);
      expect(await firstOpenBusinessDay(tx)).toBe(`${Y}-01-01`);
    });
  });

  it('throws FISCAL_YEAR_MISSING when no open year covers or follows the day after the lock', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: 2199, isClosed: true });
      await setLock(tx, '2199-11-30', '2199-12-15');
      expect(await codeOf(firstOpenBusinessDay(tx))).toBe(FISCAL_YEAR_MISSING);
    });
  });
});
