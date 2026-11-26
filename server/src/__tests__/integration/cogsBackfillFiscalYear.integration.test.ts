/**
 * Integration test: the COGS settlement journal takes its fiscal year from settleDate (E2-R5).
 *
 * Fixture years 2175 (A) and 2176 (B). A deferred-COGS invoice sits in A; the settling stock-in
 * happens in B. The caller no longer passes a year: the journal and its ledger rows carry the
 * year of settleDate, a closed year rejects the settlement, and the paths that post no journal
 * (nothing pending, differential below the threshold) do not look a year up at all.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { seedStock } from '../helpers/inventoryFixture';
import { BusinessError } from '../../utils/errors';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { settleCogsBackfillForItem } from '../../services/cogsBackfillService';

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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 30000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Service invoice in the year of the current clock plus a deferred-COGS queue row against it. */
async function seedQueue(tx: Tx, qty: number, costAtSale: number) {
  const stamp = tag();
  const party = await tx.party.create({ data: { name: `IT-COGSFY-Customer-${stamp}`, partyType: 'Customer', isActive: true } });
  const item = await tx.inventoryItem.create({
    data: { code: `IT-COGSFY-${stamp}`, name: `COGSFY ${stamp}`, unit: 'kg', isActive: true },
  });
  // The stock-in a settlement follows: its differential moves value out of this stock (value ledger).
  const warehouse = await tx.warehouse.create({ data: { code: `IT-COGSFY-${stamp}`, name: `COGSFY ${stamp}` } });
  await seedStock(tx, { itemId: item.id, warehouseId: warehouse.id, qty, avg: costAtSale, date: '2175-06-10', userId: adminId });
  const invoice = await submitSalesInvoiceInTx(
    tx,
    { date: '2175-06-10', partyId: party.id, items: [{ itemName: 'Jasa uji HPP', itemType: 'service', quantity: 1, rate: 1_000_000 }] } as any,
    adminId,
  );
  const siItem = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
  await tx.cogsBackfillQueue.create({
    data: { salesInvoiceId: invoice.id, salesInvoiceItemId: siItem.id, inventoryItemId: item.id, qtyPending: qty, qtyOriginal: qty, costAtSale, fiscalYearId: invoice.fiscalYearId },
  });
  return { item };
}

const settle = (tx: Tx, itemId: string, settleDate: Date, qty: number, unitCostNow: number) =>
  settleCogsBackfillForItem(tx, {
    itemId, qtyAvailable: qty, unitCostNow, userId: adminId, settleDate,
    source: { type: 'StockMovement', refId: `IT-COGSFY-SM-${itemId}`, refNo: 'IT-COGSFY-SM' },
  });

d('settleCogsBackfillForItem: fiscal year of the settlement journal', () => {
  it('a settlement dated in B books journal and ledger rows to B, although the invoice is in A', async () => {
    await inRollback(async (tx) => {
      const a = await createFiscalYear(tx, { year: 2175 });
      const b = await createFiscalYear(tx, { year: 2176 });
      clockAt('2175-06-10T03:00:00Z');
      const { item } = await seedQueue(tx, 100, 10_000);

      const res = await settle(tx, item.id, new Date('2176-03-05T03:00:00Z'), 40, 12_000);

      expect(res?.totalDifferential).toBe(80_000);
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: res!.journalEntryId! } });
      expect(je.fiscalYearId).toBe(b.id);
      expect(je.entryNumber).toMatch(/^JV-217603-\d{4}$/);
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceType: 'JournalEntry', referenceId: je.id } });
      expect(ale).toHaveLength(2);
      expect(ale.every((r) => r.fiscalYearId === b.id)).toBe(true);
      expect(a.id).not.toBe(b.id);
    });
  });

  it('the year of settleDate decides at the WIB boundary: 17:30Z on 31 Dec 2175 is 2176', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: 2175 });
      const b = await createFiscalYear(tx, { year: 2176 });
      clockAt('2175-06-10T03:00:00Z');
      const { item } = await seedQueue(tx, 100, 10_000);

      const res = await settle(tx, item.id, new Date('2175-12-31T17:30:00Z'), 40, 12_000);

      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: res!.journalEntryId! } });
      expect(je.fiscalYearId).toBe(b.id);
    });
  });

  it('a closed year of settleDate rejects the settlement and leaves the queue untouched', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: 2175 });
      await createFiscalYear(tx, { year: 2176, isClosed: true });
      clockAt('2175-06-10T03:00:00Z');
      const { item } = await seedQueue(tx, 100, 10_000);

      const err = await settle(tx, item.id, new Date('2176-03-05T03:00:00Z'), 40, 12_000).catch((e) => e);

      expect(err).toBeInstanceOf(BusinessError);
      expect((err as BusinessError).code).toBe(PERIOD_CLOSED);
      const q = await tx.cogsBackfillQueue.findFirstOrThrow({ where: { inventoryItemId: item.id } });
      expect(q.status).toBe('Pending');
      expect(Number(q.qtyPending)).toBe(100);
    });
  });

  it('a settlement without a differential posts no journal and needs no open year', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: 2175 });
      await createFiscalYear(tx, { year: 2176, isClosed: true });
      clockAt('2175-06-10T03:00:00Z');
      const { item } = await seedQueue(tx, 100, 10_000);

      const res = await settle(tx, item.id, new Date('2176-03-05T03:00:00Z'), 40, 10_000);

      expect(res).toMatchObject({ settledCount: 1, totalDifferential: 0, journalEntryId: undefined });
    });
  });
});
