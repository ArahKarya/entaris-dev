/**
 * Integration test: party balances per side (PR-5.9a, services/ledger/partySides.ts), the backfill in
 * prisma/migrations/20261110100000_party_side_balances, recalcPartyOutstanding per side and the core
 * of scripts/repair/e2-party-side-recalc.ts.
 *
 * Fixture: fiscal year 2154 (this file's only year, plan §6.3). Everything runs in a rollback
 * transaction and assertions only look at this file's parties, except the adjustPartyOpening race,
 * which needs a committed party on two connections and deletes it after.
 * - The migration, run twice, gives the same columns; a clean Customer's opening goes to the
 *   receivable side, a clean Supplier's to the payable side; a Customer with a payment remainder,
 *   one with a cancelled payment, a negative opening and a party typed Both stay undirected and
 *   their outstanding does not change; Draft invoices are left out of the side columns.
 * - recalcPartyOutstanding keeps a Both party's receivable and payable apart, each with its own
 *   manual adjustment, and leaves Draft invoices out.
 * - The recalculation script lists the parties to rewrite and the undirected ones, rewrites only the
 *   derived columns with one repair audit row per changed party, and a second run changes nothing.
 * - Two adjustPartyOpening reductions at once never take the opening below zero.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient, Prisma, type FiscalYear, type PartyType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import {
  adjustPartyOpening,
  applyPartySideRecalc,
  PARTY_SIDE_RECALC_AUDIT_ACTION,
  planPartySideRecalc,
} from '../../services/ledger/partySides';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../prisma/migrations/20261110100000_party_side_balances/migration.sql'),
  'utf8',
);

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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2154;
const JT = 1_000_000;
const DAY = new Date(`${Y}-03-10T03:00:00.000Z`);
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books {
  fy: FiscalYear;
  userId: string;
  cashId: string;
  party: (partyType: PartyType, opening?: number, outstanding?: number) => Promise<string>;
  salesInvoice: (partyId: string, outstanding: number, status?: 'Submitted' | 'Draft' | 'Cancelled') => Promise<void>;
  purchaseInvoice: (partyId: string, outstanding: number, status?: 'Submitted' | 'Draft' | 'Cancelled') => Promise<void>;
  payment: (partyId: string, amount: number, allocated: number, status?: 'Submitted' | 'Cancelled') => Promise<void>;
}

async function books(tx: Tx): Promise<Books> {
  const fy = await createFiscalYear(tx, { year: Y });
  const { userId } = await createCapUser(tx, []);
  const cash = await tx.account.create({ data: { name: 'IT2154 Kas', accountNumber: `IT2154-${tag()}`, accountType: 'ASSET', rootType: 'ASSET' } });
  const invoice = { date: DAY, fiscalYearId: fy.id, createdBy: userId };
  return {
    fy,
    userId,
    cashId: cash.id,
    party: async (partyType, opening = 0, outstanding = opening) => (await tx.party.create({
      data: { name: `IT2154 ${partyType} ${tag()}`, partyType, openingOutstanding: opening, outstandingAmount: outstanding },
    })).id,
    salesInvoice: async (partyId, outstanding, status = 'Submitted') => {
      await tx.salesInvoice.create({ data: { ...invoice, invoiceNumber: `IT2154-SI-${tag()}`, partyId, grandTotal: outstanding, outstanding, status } });
    },
    purchaseInvoice: async (partyId, outstanding, status = 'Submitted') => {
      await tx.purchaseInvoice.create({ data: { ...invoice, invoiceNumber: `IT2154-PI-${tag()}`, partyId, grandTotal: outstanding, outstanding, status } });
    },
    payment: async (partyId, amount, allocated, status = 'Submitted') => {
      const pay = await tx.payment.create({
        data: {
          paymentNumber: `IT2154-PAY-${tag()}`, date: DAY, paymentType: 'Receive', partyId, accountId: cash.id, amount, status,
          createdBy: userId, fiscalYearId: fy.id,
        },
      });
      if (allocated > 0) {
        await tx.paymentAllocation.create({ data: { paymentId: pay.id, invoiceType: 'SalesInvoice', invoiceId: `it2154-${tag()}`, allocatedAmount: allocated } });
      }
    },
  };
}

const columns = async (tx: Tx, ids: readonly string[]) => {
  const rows = await tx.party.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true, outstandingAmount: true, receivableOutstanding: true, payableOutstanding: true,
      openingOutstanding: true, openingReceivable: true, openingPayable: true,
    },
  });
  return Object.fromEntries(rows.map(({ id, ...c }) => [id, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, (v as Prisma.Decimal).toFixed(2)]))]));
};

d('migration 20261110100000_party_side_balances backfill', () => {
  it('directs only clean openings, keeps outstanding and is idempotent', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const cleanCustomer = await b.party('Customer', 50 * JT, 60 * JT);
      await b.salesInvoice(cleanCustomer, 10 * JT);
      await b.salesInvoice(cleanCustomer, 4 * JT, 'Draft');
      await b.payment(cleanCustomer, 3 * JT, 3 * JT); // fully allocated: did not cut the opening
      const cleanSupplier = await b.party('Supplier', 7 * JT, 9 * JT);
      await b.purchaseInvoice(cleanSupplier, 2 * JT);
      const remainder = await b.party('Customer', 40 * JT);
      await b.payment(remainder, 15 * JT, 5 * JT); // 10 jt rest may have cut the opening
      const cancelled = await b.party('Customer', 20 * JT);
      await b.payment(cancelled, 5 * JT, 0, 'Cancelled');
      const negative = await b.party('Customer', -3 * JT);
      const both = await b.party('Both', 30 * JT, 35 * JT);
      await b.salesInvoice(both, 2 * JT);
      await b.purchaseInvoice(both, 3 * JT);
      const ids = [cleanCustomer, cleanSupplier, remainder, cancelled, negative, both];
      const before = await columns(tx, ids);

      await tx.$executeRawUnsafe(MIGRATION_SQL);
      const once = await columns(tx, ids);
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await columns(tx, ids)).toEqual(once);

      expect(once[cleanCustomer]).toMatchObject({ openingReceivable: '50000000.00', openingPayable: '0.00', receivableOutstanding: '60000000.00', payableOutstanding: '0.00' });
      expect(once[cleanSupplier]).toMatchObject({ openingReceivable: '0.00', openingPayable: '7000000.00', receivableOutstanding: '0.00', payableOutstanding: '9000000.00' });
      for (const id of [remainder, cancelled, negative]) {
        expect(once[id]).toMatchObject({ openingReceivable: '0.00', openingPayable: '0.00', receivableOutstanding: before[id].openingOutstanding, payableOutstanding: '0.00' });
      }
      // Both: undirected opening on the receivable side; payable from the purchase invoice.
      expect(once[both]).toMatchObject({ openingReceivable: '0.00', openingPayable: '0.00', receivableOutstanding: '32000000.00', payableOutstanding: '3000000.00' });
      // The migration never touches outstanding_amount or opening_outstanding.
      for (const id of ids) {
        expect(once[id].outstandingAmount).toBe(before[id].outstandingAmount);
        expect(once[id].openingOutstanding).toBe(before[id].openingOutstanding);
      }
    });
  });
});

d('recalcPartyOutstanding per side', () => {
  it('Both: payable 30 jt and receivable 20 jt apart, manual adjustment on each side, Draft left out', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const both = await b.party('Both');
      await b.purchaseInvoice(both, 30 * JT);
      await b.salesInvoice(both, 18 * JT);
      await b.salesInvoice(both, 9 * JT, 'Draft');
      await b.purchaseInvoice(both, 9 * JT, 'Cancelled');
      const ar = await tx.systemAccountMapping.findFirst({ where: { role: 'AR' }, orderBy: { sortOrder: 'asc' }, select: { accountId: true } });
      if (!ar) throw new Error('AR is not mapped (seed).');
      const je = await tx.journalEntry.create({
        data: {
          entryNumber: `IT2154-MAN-${tag()}`, date: DAY, status: 'Submitted', fiscalYearId: b.fy.id, createdBy: b.userId, sourceType: 'MANUAL',
          items: { create: [{ accountId: ar.accountId, partyId: both, debit: 2 * JT }, { accountId: b.cashId, credit: 2 * JT }] },
        },
      });
      await tx.accountingLedgerEntry.createMany({
        data: [
          { date: DAY, accountId: ar.accountId, partyId: both, debit: 2 * JT, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: b.fy.id },
          { date: DAY, accountId: b.cashId, debit: 0, credit: 2 * JT, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: b.fy.id },
        ],
      });

      await recalcPartyOutstanding(tx, both);
      expect((await columns(tx, [both]))[both]).toMatchObject({
        receivableOutstanding: '20000000.00', payableOutstanding: '30000000.00', outstandingAmount: '50000000.00',
      });
    });
  });

  it('an undirected opening still counts, on the payable side of a Supplier', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const supplier = await b.party('Supplier', 4 * JT, 0);
      await b.purchaseInvoice(supplier, JT);
      await recalcPartyOutstanding(tx, supplier);
      expect((await columns(tx, [supplier]))[supplier]).toMatchObject({ receivableOutstanding: '0.00', payableOutstanding: '5000000.00', outstandingAmount: '5000000.00' });
    });
  });
});

d('e2-party-side-recalc core', () => {
  it('lists, rewrites the derived columns with one repair audit row each, and a second run changes nothing', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const stale = await b.party('Customer', 0, 0);
      await b.salesInvoice(stale, 6 * JT);
      const undirected = await b.party('Both', 2 * JT, 2 * JT);
      await tx.party.update({ where: { id: undirected }, data: { receivableOutstanding: 2 * JT } });
      const ids = [stale, undirected];

      const plan = await planPartySideRecalc(tx, ids);
      const byId = new Map(plan.map((r) => [r.partyId, r]));
      expect(byId.get(stale)).toMatchObject({ changes: true, issues: [] });
      expect(byId.get(stale)!.computed.receivable.toFixed(2)).toBe('6000000.00');
      expect(byId.get(undirected)).toMatchObject({ changes: false, issues: ['legacy-unassigned'] });
      expect(byId.get(undirected)!.legacyUnassigned.toFixed(2)).toBe('2000000.00');

      const glBefore = await tx.accountingLedgerEntry.count({ where: { partyId: { in: ids } } });
      expect(await applyPartySideRecalc(tx, ids, { approvedBy: 'Bu Sari' })).toEqual([stale]);
      expect((await columns(tx, [stale]))[stale]).toMatchObject({ receivableOutstanding: '6000000.00', outstandingAmount: '6000000.00', openingOutstanding: '0.00' });
      expect(await tx.accountingLedgerEntry.count({ where: { partyId: { in: ids } } })).toBe(glBefore);
      const audit = await tx.auditLog.findMany({ where: { action: PARTY_SIDE_RECALC_AUDIT_ACTION, entityId: { in: ids } } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'Party', entityId: stale, via: 'repair',
        viaMeta: { script: PARTY_SIDE_RECALC_AUDIT_ACTION, approvedBy: 'Bu Sari' },
        oldValues: { receivableOutstanding: '0.00', outstandingAmount: '0.00' },
        newValues: { receivableOutstanding: '6000000.00', outstandingAmount: '6000000.00' },
      });

      expect(await applyPartySideRecalc(tx, ids, { approvedBy: null })).toEqual([]);
      expect((await planPartySideRecalc(tx, ids)).filter((r) => r.changes)).toEqual([]);
    });
  });
});

d('adjustPartyOpening (committed rows)', () => {
  let partyId: string | null = null;

  afterAll(async () => {
    if (hasDb && partyId) await prisma.party.delete({ where: { id: partyId } });
  });

  it('two reductions at once take at most the opening, and a restore adds it back', async () => {
    partyId = (await prisma.party.create({
      data: { name: `IT2154 Race ${tag()}`, partyType: 'Customer', openingOutstanding: 100, openingReceivable: 100 },
    })).id;
    const id = partyId;
    let second: Promise<Prisma.Decimal> | null = null;
    const first = await prisma.$transaction(async (tx) => {
      const cut = await adjustPartyOpening(tx, id, 'RECEIVABLE', -70);
      second = prisma.$transaction((t) => adjustPartyOpening(t, id, 'RECEIVABLE', -70));
      await new Promise((r) => setTimeout(r, 300));
      return cut;
    }, { timeout: 20000 });
    expect(first.toFixed(2)).toBe('-70.00');
    expect((await second!).toFixed(2)).toBe('-30.00');
    const after = await prisma.party.findUniqueOrThrow({ where: { id }, select: { openingReceivable: true, openingOutstanding: true } });
    expect([after.openingReceivable.toFixed(2), after.openingOutstanding.toFixed(2)]).toEqual(['0.00', '0.00']);

    expect((await prisma.$transaction((tx) => adjustPartyOpening(tx, id, 'RECEIVABLE', -5))).toFixed(2)).toBe('0.00');
    expect((await prisma.$transaction((tx) => adjustPartyOpening(tx, id, 'RECEIVABLE', 30))).toFixed(2)).toBe('30.00');
    const restored = await prisma.party.findUniqueOrThrow({ where: { id }, select: { openingReceivable: true, openingOutstanding: true } });
    expect([restored.openingReceivable.toFixed(2), restored.openingOutstanding.toFixed(2)]).toEqual(['30.00', '30.00']);
  });
});
