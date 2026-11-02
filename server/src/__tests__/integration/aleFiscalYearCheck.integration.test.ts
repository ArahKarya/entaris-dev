/**
 * Integration test: findAleFiscalYearMismatches and the "ALE vs Fiscal Year" health check (E2-R5).
 *
 * Fixture years 2173 (A) and 2174 (B), stored at UTC midnight like routes/fiscalYears.ts. The check
 * compares business days (WIB), not instants: a ledger row at 17:30Z on 31 Dec is already 1 Jan.
 * Every case runs in a rollback transaction and scopes the query to its own journals.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { findAleFiscalYearMismatches } from '../../services/ledger/aleFiscalYearCheck';
import healthCheckRouter from '../../routes/healthCheck';

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

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** A journal with one active ledger row dated `aleDate` and tagged `fiscalYearId`. */
async function journalWithAle(
  tx: Tx,
  opts: { fiscalYearId: string; aleDate: string; aleFiscalYearId?: string; debit?: number; cancelled?: boolean; journalDate?: string },
) {
  const account = await tx.account.findFirstOrThrow({ where: { isGroup: false } });
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-ALEFY-${tag()}`,
      date: new Date(opts.journalDate ?? opts.aleDate),
      status: 'Submitted',
      fiscalYearId: opts.fiscalYearId,
      createdBy: adminId,
    },
  });
  await tx.accountingLedgerEntry.create({
    data: {
      date: new Date(opts.aleDate),
      accountId: account.id,
      debit: opts.debit ?? 100,
      credit: 0,
      referenceType: 'JournalEntry',
      referenceId: je.id,
      fiscalYearId: opts.aleFiscalYearId ?? opts.fiscalYearId,
      isCancelled: opts.cancelled ?? false,
    },
  });
  return je;
}

async function years(tx: Tx) {
  return { a: await createFiscalYear(tx, { year: 2173 }), b: await createFiscalYear(tx, { year: 2174 }) };
}

d('findAleFiscalYearMismatches', () => {
  it('flags a ledger row booked to the wrong year and names both years', async () => {
    await inRollback(async (tx) => {
      const { a, b } = await years(tx);
      const wrong = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2174-02-10T03:00:00Z' });
      const right = await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2174-02-10T03:00:00Z' });
      const res = await findAleFiscalYearMismatches(tx, { journalIds: [wrong.id, right.id] });
      expect(res.total).toBe(1);
      expect(res.rows[0]).toMatchObject({
        journalId: wrong.id, entryNumber: wrong.entryNumber, day: '2174-02-10', aleCount: 1,
        storedYear: a.name, storedYearClosed: false, expectedYear: b.name, expectedYearClosed: false,
      });
      expect(res.closedTotal).toBe(0);
    });
  });

  it('splits at the WIB day: 17:30Z on 31 Dec is 1 Jan, 16:30Z is still 31 Dec', async () => {
    await inRollback(async (tx) => {
      const { a, b } = await years(tx);
      const lateOk = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2173-12-31T16:30:00Z' });
      const lateBad = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2173-12-31T17:30:00Z' });
      const earlyOk = await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2173-12-31T17:30:00Z' });
      const res = await findAleFiscalYearMismatches(tx, { journalIds: [lateOk.id, lateBad.id, earlyOk.id] });
      expect(res.rows.map((r) => r.journalId)).toEqual([lateBad.id]);
      expect(res.rows[0]).toMatchObject({ day: '2174-01-01', expectedYear: b.name });
    });
  });

  it('no false positives for UTC-midnight and WIB-midnight forms of the year bounds', async () => {
    await inRollback(async (tx) => {
      const { a, b } = await years(tx);
      const ids = [
        // date-only values keep their UTC day
        (await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2173-12-31T00:00:00Z' })).id,
        (await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2174-01-01T00:00:00Z' })).id,
        // local midnight of the same days
        (await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2173-12-30T17:00:00Z' })).id,
        (await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2173-12-31T17:00:00Z' })).id,
        (await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2174-12-31T00:00:00Z' })).id,
      ];
      const res = await findAleFiscalYearMismatches(tx, { journalIds: ids });
      expect(res).toEqual({ total: 0, closedTotal: 0, rows: [] });
    });
  });

  it('a cancel pair a few milliseconds apart is not a difference', async () => {
    await inRollback(async (tx) => {
      const { b } = await years(tx);
      const orig = await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2174-03-05T05:00:00.000Z' });
      const cxl = await journalWithAle(tx, { fiscalYearId: b.id, aleDate: '2174-03-05T05:00:00.002Z', journalDate: '2174-03-05T04:59:59.998Z' });
      const res = await findAleFiscalYearMismatches(tx, { journalIds: [orig.id, cxl.id] });
      expect(res.total).toBe(0);
    });
  });

  it('expectedYear is null when no fiscal year holds the day', async () => {
    await inRollback(async (tx) => {
      const { a } = await years(tx);
      const je = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2179-06-01T03:00:00Z' });
      const res = await findAleFiscalYearMismatches(tx, { journalIds: [je.id] });
      expect(res.rows[0]).toMatchObject({ expectedYear: null, expectedYearClosed: null, storedYear: a.name });
    });
  });

  it('ignores cancelled ledger rows, and an empty journalIds list matches nothing', async () => {
    await inRollback(async (tx) => {
      const { a } = await years(tx);
      const je = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2174-02-10T03:00:00Z', cancelled: true });
      expect((await findAleFiscalYearMismatches(tx, { journalIds: [je.id] })).total).toBe(0);
      const live = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2174-02-10T03:00:00Z' });
      expect((await findAleFiscalYearMismatches(tx, { journalIds: [] })).total).toBe(0);
      expect((await findAleFiscalYearMismatches(tx, { journalIds: [live.id], limit: 1 })).rows).toHaveLength(1);
    });
  });

  it('counts journals that touch a closed year', async () => {
    await inRollback(async (tx) => {
      const a = await createFiscalYear(tx, { year: 2173, isClosed: true });
      const b = await createFiscalYear(tx, { year: 2174 });
      const je = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2174-02-10T03:00:00Z' });
      const res = await findAleFiscalYearMismatches(tx, { journalIds: [je.id] });
      expect(res).toMatchObject({ total: 1, closedTotal: 1 });
      expect(res.rows[0]).toMatchObject({ storedYearClosed: true, expectedYear: b.name, expectedYearClosed: false });
    });
  });
});

d('GET /api/health-check: ALE vs Fiscal Year', () => {
  it('lists the mismatching journal and is an error when a closed year is involved', async () => {
    await inRollback(async (tx) => {
      const a = await createFiscalYear(tx, { year: 2173, isClosed: true });
      await createFiscalYear(tx, { year: 2174 });
      // Large amount so the row is among the 20 listed whatever else the database holds.
      const je = await journalWithAle(tx, { fiscalYearId: a.id, aleDate: '2174-02-10T03:00:00Z', debit: 9_000_000_000_000 });
      const user = await createCapUser(tx, []);
      const res = await callRoute(healthCheckRouter, 'get', '/', user);
      expect(res.status).toBe(200);
      const body = res.body as { data: { status: string; checks: Array<{ name: string; status: string; count: number; fixable: boolean; details: Array<Record<string, unknown>> }> } };
      const check = body.data.checks.find((c) => c.name === 'ALE vs Fiscal Year');
      expect(check).toBeDefined();
      expect(check).toMatchObject({ status: 'error', fixable: false });
      expect(check!.count).toBeGreaterThanOrEqual(1);
      expect(check!.details.length).toBeLessThanOrEqual(20);
      expect(check!.details[0]).toMatchObject({ journal_number: je.entryNumber, date: '2174-02-10', stored_year: a.name, closed_year: true });
      expect(body.data.status).toBe('error');
    });
  });
});
