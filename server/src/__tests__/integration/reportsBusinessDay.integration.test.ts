/**
 * Integration test: reports and the dashboard use WIB business days (E2-R1).
 *
 * A 10 jt rent journal stamped 1 Feb 02:00 WIB (31 Jan 19:00 UTC) belongs to February: it is in
 * February's P/L and not January's, P/L Jan + P/L Feb equals the change in current-year profit
 * on the 28 Feb balance sheet, and the dashboard monthly-profit chart shows it in February.
 * Route handlers run against a rollback transaction (lib/prisma is swapped for it), in a far
 * future year so existing rows cannot interfere.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import reportsRouter from '../../routes/reports';
import dashboardRouter from '../../routes/dashboard';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

/** Runs fn in a transaction that is always rolled back, with route handlers bound to it. */
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

const YEAR = 2097;
const RENT = 10_000_000;
const FEB1_0200_WIB = new Date(`${YEAR}-01-31T19:00:00.000Z`);

/** Posts a balanced Dr expense / Cr cash journal with its ledger rows. */
async function postRentJournal(tx: Tx, date: Date) {
  const tag = Math.random().toString(36).slice(2, 8);
  const fy = await tx.fiscalYear.create({
    data: { name: `IT-BD-${tag}`, startDate: new Date(`${YEAR}-01-01`), endDate: new Date(`${YEAR}-12-31`) },
  });
  const expense = await tx.account.findFirst({ where: { rootType: 'EXPENSE', isGroup: false, isActive: true } });
  const cash = await tx.account.findFirst({ where: { rootType: 'ASSET', isGroup: false, isActive: true } });
  if (!expense || !cash) throw new Error('Need an EXPENSE and an ASSET detail account.');
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-BD-${tag}`,
      date,
      status: 'Submitted',
      narration: 'Sewa gudang (uji hari bisnis)',
      fiscalYearId: fy.id,
      createdBy: userId,
      submittedAt: date,
      items: {
        create: [
          { accountId: expense.id, debit: RENT, credit: 0 },
          { accountId: cash.id, debit: 0, credit: RENT },
        ],
      },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: [
      { date, accountId: expense.id, debit: RENT, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
      { date, accountId: cash.id, debit: 0, credit: RENT, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
    ],
  });
}

async function netProfit(startDate: string, endDate: string): Promise<number> {
  const r = await callRoute(reportsRouter, 'get', '/profit-loss', { query: { startDate, endDate } });
  expect(r.status).toBe(200);
  return r.body.netProfit;
}

async function currentProfit(date: string): Promise<number> {
  const r = await callRoute(reportsRouter, 'get', '/balance-sheet', { query: { date } });
  expect(r.status).toBe(200);
  return r.body.equity.find((e: { id: string }) => e.id === 'current-profit').balance;
}

d('reports use WIB business days', () => {
  it('puts a 1 Feb 02:00 WIB journal in February everywhere', async () => {
    await inRollback(async (tx) => {
      const before = {
        jan: await netProfit(`${YEAR}-01-01`, `${YEAR}-01-31`),
        feb: await netProfit(`${YEAR}-02-01`, `${YEAR}-02-28`),
      };

      await postRentJournal(tx, FEB1_0200_WIB);

      const jan = await netProfit(`${YEAR}-01-01`, `${YEAR}-01-31`);
      const feb = await netProfit(`${YEAR}-02-01`, `${YEAR}-02-28`);
      expect(jan - before.jan).toBe(0);
      expect(feb - before.feb).toBe(-RENT);

      // Jan + Feb P/L = current-year profit at 28 Feb minus that at 31 Dec of the year before.
      const opening = await currentProfit(`${YEAR - 1}-12-31`);
      const feb28 = await currentProfit(`${YEAR}-02-28`);
      expect(jan + feb).toBeCloseTo(feb28 - opening, 2);
      // As of 31 Jan the journal is not yet on the balance sheet.
      expect(await currentProfit(`${YEAR}-01-31`)).toBeCloseTo(opening + jan, 2);

      const chart = await callRoute(dashboardRouter, 'get', '/monthly-profit', {
        query: { startDate: `${YEAR}-01-01`, endDate: `${YEAR}-02-28` },
      });
      expect(chart.status).toBe(200);
      expect(chart.body).toHaveLength(2);
      expect(chart.body[0].expense).toBe(0);
      expect(chart.body[1].expense).toBe(RENT);

      const charts = await callRoute(dashboardRouter, 'get', '/charts', {
        query: { startDate: `${YEAR}-01-01`, endDate: `${YEAR}-02-28` },
      });
      expect(charts.body.map((m: { beban: number }) => m.beban)).toEqual([0, RENT]);
    });
  });

  it('rejects malformed report dates with 400', async () => {
    await inRollback(async () => {
      const r = await callRoute(reportsRouter, 'get', '/profit-loss', { query: { startDate: '01/02/2097' } });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('Parameter startDate tidak valid.');
      const bs = await callRoute(reportsRouter, 'get', '/balance-sheet', { query: { date: 'kemarin' } });
      expect(bs.status).toBe(400);
    });
  });
});
