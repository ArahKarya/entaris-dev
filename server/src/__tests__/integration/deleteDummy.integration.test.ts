/**
 * Integration test: POST /api/settings/delete-dummy after the old generator was removed (E7-R13).
 *
 * A real customer with a 25 jt opening balance (and its 25 jt AR ledger row) is left untouched by
 * the delete; the dummy party, invoice, journal and every ledger row of them go, including a row
 * referencing the dummy journal (no orphan). Only the accounts that lost ledger rows are
 * recalculated. Dummy rows in a closed fiscal year are refused with 409 and nothing is deleted;
 * a dummy journal dated outside every fiscal year is still deleted. The route needs
 * approval.bypass on top of settings edit. POST /generate-dummy no longer exists.
 *
 * Fixture year 2181 (plan §5.2). Everything runs in a rollback transaction; the route's own
 * transaction is a savepoint (route harness).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { systemAccountNumber } from '../helpers/systemAccountNumbers';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import { DUMMY_LEDGER_MARKERS } from '../../services/dummyJournalMatch';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import dummyDataRouter from '../../routes/settings/dummyData';
import demoDataRouter from '../../routes/settings/demoData';
import settingsRouter from '../../routes/settings';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const Y = 2181;
const OPENING = 25_000_000;
const DUMMY_AMOUNT = 1_000_000;

let prisma: PrismaClient;
let pool: Pool;
let arNumber: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  arNumber = await systemAccountNumber(prisma, 'AR');
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
        // Only this test's dummy rows may exist: hide any others (rolled back with the rest),
        // and drop demo batches, which make the route answer 409.
        await tx.demoDataBatch.deleteMany();
        await tx.party.updateMany({ where: { isDummy: true }, data: { isDummy: false } });
        await tx.salesInvoice.updateMany({ where: { isDummy: true }, data: { isDummy: false } });
        await tx.purchaseInvoice.updateMany({ where: { isDummy: true }, data: { isDummy: false } });
        await tx.inventoryItem.updateMany({ where: { isDummy: true }, data: { isDummy: false } });
        await tx.journalEntry.updateMany({ where: { isDummy: true }, data: { isDummy: false } });
        // Old-generator ledger markers left in a dev DB would pull their rows and the matching
        // untagged generic journals into the delete: rename them so nothing matches.
        await tx.accountingLedgerEntry.updateMany({
          where: { referenceId: { in: [...DUMMY_LEDGER_MARKERS] } },
          data: { referenceId: 'it-hidden-dummy-marker' },
        });
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 30000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** The route's actor: settings edit + approval.bypass (Admin by default). */
const manager = (tx: Tx) => createCapUser(tx, ['approval.bypass'], { perms: { settings: 'edit' } });

/** A detail account owned by the test, with a stored balance that may be deliberately wrong. */
function testAccount(tx: Tx, rootType: 'ASSET' | 'REVENUE', balance: number) {
  const t = tag();
  return tx.account.create({
    data: { name: `IT-dummy-${rootType}-${t}`, accountNumber: `IT-${Y}-${t}`, accountType: rootType, rootType, balance },
  });
}

/**
 * Old-generator leftovers: a [Dummy] customer, a Submitted invoice with its ledger rows (AR debit,
 * income credit), an isDummy journal, and a ledger row referencing that journal directly.
 */
async function legacyDummy(tx: Tx, opts: { fiscalYearId: string; date: string; userId: string; arId: string; incomeId: string }) {
  const t = tag();
  const date = new Date(opts.date);
  const party = await tx.party.create({ data: { name: `[Dummy] IT ${t}`, partyType: 'Customer', isDummy: true, outstandingAmount: DUMMY_AMOUNT } });
  const invoice = await tx.salesInvoice.create({
    data: {
      invoiceNumber: `IT-DUMMY-SI-${t}`, date, partyId: party.id, status: 'Submitted', grandTotal: DUMMY_AMOUNT,
      outstanding: DUMMY_AMOUNT, fiscalYearId: opts.fiscalYearId, createdBy: opts.userId, isDummy: true,
    },
  });
  const journal = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-DUMMY-JV-${t}`, date, status: 'Submitted', narration: `Penjualan beras - ${party.name}`,
      fiscalYearId: opts.fiscalYearId, createdBy: opts.userId, submittedAt: date, isDummy: true,
      items: { create: [{ accountId: opts.arId, debit: DUMMY_AMOUNT, credit: 0 }, { accountId: opts.incomeId, debit: 0, credit: DUMMY_AMOUNT }] },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: [
      { accountId: opts.arId, partyId: party.id, date, debit: DUMMY_AMOUNT, credit: 0, referenceType: 'SalesInvoice', referenceId: invoice.id, fiscalYearId: opts.fiscalYearId },
      { accountId: opts.incomeId, date, debit: 0, credit: DUMMY_AMOUNT, referenceType: 'SalesInvoice', referenceId: invoice.id, fiscalYearId: opts.fiscalYearId },
      // Points at the journal only: no party, no dummy document.
      { accountId: opts.incomeId, date, debit: 0, credit: 5_000, referenceType: 'JournalEntry', referenceId: journal.id, fiscalYearId: opts.fiscalYearId },
    ],
  });
  return { party, invoice, journal };
}

/** Sum of active ledger rows of one account for one party. */
async function arOf(tx: Tx, accountId: string, partyId: string): Promise<number> {
  const s = await tx.accountingLedgerEntry.aggregate({ where: { accountId, partyId, isCancelled: false }, _sum: { debit: true, credit: true } });
  return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
}

d('delete-dummy: legacy dummy data cleanup (E7-R13)', () => {
  it('keeps a real customer with a 25 jt opening balance intact, removes every dummy row, and recalculates only touched accounts', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      const actor = await manager(tx);
      const ar = await tx.account.findUniqueOrThrow({ where: { accountNumber: arNumber } });
      const income = await testAccount(tx, 'REVENUE', 123); // drifted; real credit below is 300k
      const untouched = await testAccount(tx, 'ASSET', 999); // drifted, no ledger rows at all

      const customer = await tx.party.create({
        data: { name: `IT-real-${tag()}`, partyType: 'Customer', openingOutstanding: OPENING, outstandingAmount: OPENING },
      });
      await tx.accountingLedgerEntry.create({
        data: { accountId: ar.id, partyId: customer.id, date: new Date(`${Y}-01-01`), debit: OPENING, credit: 0, referenceType: 'OpeningBalance', referenceId: `it-opening-${customer.id}`, fiscalYearId: fy.id },
      });
      await tx.accountingLedgerEntry.create({
        data: { accountId: income.id, date: new Date(`${Y}-02-01`), debit: 0, credit: 300_000, referenceType: 'JournalEntry', referenceId: `it-real-${tag()}`, fiscalYearId: fy.id },
      });
      const dummy = await legacyDummy(tx, { fiscalYearId: fy.id, date: `${Y}-03-10`, userId: actor.userId, arId: ar.id, incomeId: income.id });

      const r = await callRoute(dummyDataRouter, 'post', '/delete-dummy', actor);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.results).toMatchObject({ parties: 1, salesInvoices: 1, journals: 1 });

      const real = await tx.party.findUniqueOrThrow({ where: { id: customer.id } });
      expect(Number(real.outstandingAmount)).toBe(OPENING);
      expect(Number(real.openingOutstanding)).toBe(OPENING);
      expect(await arOf(tx, ar.id, customer.id)).toBe(OPENING);

      expect(await tx.party.findUnique({ where: { id: dummy.party.id } })).toBeNull();
      expect(await tx.salesInvoice.findUnique({ where: { id: dummy.invoice.id } })).toBeNull();
      expect(await tx.journalEntry.findUnique({ where: { id: dummy.journal.id } })).toBeNull();
      expect(await tx.journalItem.count({ where: { journalEntryId: dummy.journal.id } })).toBe(0);
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: { in: [dummy.invoice.id, dummy.journal.id] } } })).toBe(0);
      expect(await tx.accountingLedgerEntry.count({ where: { partyId: dummy.party.id } })).toBe(0);

      // Touched account: recalculated from what remains. Untouched account: stored balance kept.
      expect(Number((await tx.account.findUniqueOrThrow({ where: { id: income.id } })).balance)).toBe(300_000);
      expect(Number((await tx.account.findUniqueOrThrow({ where: { id: untouched.id } })).balance)).toBe(999);
    });
  }, 60000);

  it('refuses with 409 PERIOD_CLOSED when dummy rows are in a closed fiscal year, and deletes nothing', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y, isClosed: true });
      const actor = await manager(tx);
      const ar = await tx.account.findUniqueOrThrow({ where: { accountNumber: arNumber } });
      const income = await testAccount(tx, 'REVENUE', 0);
      const dummy = await legacyDummy(tx, { fiscalYearId: fy.id, date: `${Y}-06-15`, userId: actor.userId, arId: ar.id, incomeId: income.id });

      const r = await callRoute(dummyDataRouter, 'post', '/delete-dummy', actor);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe(PERIOD_CLOSED);
      expect(r.body.error).toContain(fy.name);

      expect(await tx.party.findUnique({ where: { id: dummy.party.id } })).not.toBeNull();
      expect(await tx.salesInvoice.findUnique({ where: { id: dummy.invoice.id } })).not.toBeNull();
      expect(await tx.journalEntry.findUnique({ where: { id: dummy.journal.id } })).not.toBeNull();
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: { in: [dummy.invoice.id, dummy.journal.id] } } })).toBe(3);
    });
  }, 60000);

  it('deletes a dummy journal dated outside every fiscal year without an error', async () => {
    await inRollback(async (tx) => {
      // Covers only the first half of the year; the dummy rows are dated in September.
      const fy = await tx.fiscalYear.create({
        data: { name: `IT-${Y}-H1-${tag()}`, startDate: new Date(`${Y}-01-01`), endDate: new Date(`${Y}-06-30`) },
      });
      const actor = await manager(tx);
      const ar = await tx.account.findUniqueOrThrow({ where: { accountNumber: arNumber } });
      const income = await testAccount(tx, 'REVENUE', 0);
      const dummy = await legacyDummy(tx, { fiscalYearId: fy.id, date: `${Y}-09-15`, userId: actor.userId, arId: ar.id, incomeId: income.id });
      expect(await tx.fiscalYear.count({ where: { startDate: { lte: new Date(`${Y}-09-15`) }, endDate: { gte: new Date(`${Y}-09-15`) } } })).toBe(0);

      const r = await callRoute(dummyDataRouter, 'post', '/delete-dummy', actor);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await tx.journalEntry.findUnique({ where: { id: dummy.journal.id } })).toBeNull();
      expect(await tx.salesInvoice.findUnique({ where: { id: dummy.invoice.id } })).toBeNull();
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: { in: [dummy.invoice.id, dummy.journal.id] } } })).toBe(0);
    });
  }, 60000);

  it('refuses a role with settings edit but without approval.bypass with 403', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      const actor = await createCapUser(tx, [], { perms: { settings: 'edit' } });
      const ar = await tx.account.findUniqueOrThrow({ where: { accountNumber: arNumber } });
      const income = await testAccount(tx, 'REVENUE', 0);
      const dummy = await legacyDummy(tx, { fiscalYearId: fy.id, date: `${Y}-03-10`, userId: actor.userId, arId: ar.id, incomeId: income.id });

      const r = await callRoute(dummyDataRouter, 'post', '/delete-dummy', actor);
      expect(r.status).toBe(403);
      expect(await tx.party.findUnique({ where: { id: dummy.party.id } })).not.toBeNull();
      expect(await tx.journalEntry.findUnique({ where: { id: dummy.journal.id } })).not.toBeNull();
    });
  }, 60000);
});

describe('generate-dummy is gone (E7-R13)', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
  /** Every method + path served by a router, including routers mounted with router.use. */
  const routesOf = (router: Router): string[] =>
    (router.stack as Layer[]).flatMap((l) =>
      l.route
        ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`)
        : l.handle?.stack ? routesOf(l.handle as unknown as Router) : [],
    );

  it('no settings router serves POST /generate-dummy (Express answers 404), while delete-dummy stays', async () => {
    for (const router of [dummyDataRouter, demoDataRouter, settingsRouter]) {
      expect(routesOf(router)).not.toContain('POST /generate-dummy');
    }
    expect(routesOf(settingsRouter)).toContain('POST /delete-dummy');
    await expect(callRoute(dummyDataRouter, 'post', '/generate-dummy')).rejects.toThrow(/not found/);
  });
});
