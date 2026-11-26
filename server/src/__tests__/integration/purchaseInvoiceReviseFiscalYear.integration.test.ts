/**
 * Integration test: the price-revision journal follows its own date (E2-R5).
 *
 * Fixture years 2171 (the invoice's) and 2172. The Date clock moves into 2172, so the revision
 * journal and its ledger rows must carry the 2172 year and a 2172 month number, even though the
 * invoice belongs to 2171, which may be closed. A closed or missing year of the revision date
 * rejects the revision before anything is written; the monthly lock is honoured.
 * The last cases pin today's behaviour of two revision details owned by E5 (price revision).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { BusinessError } from '../../utils/errors';
import { FISCAL_YEAR_MISSING, PERIOD_CLOSED, PERIOD_LOCKED } from '../../utils/periodGuard';
import { revisePurchaseInvoiceInTx } from '../../services/purchaseInvoiceRevise';
import { seedStock } from '../helpers/inventoryFixture';

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

/** Only the Date clock moves; timers stay real so the transaction timeout keeps working. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
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

/** A Submitted purchase invoice of one service line in `fiscalYearId`, rate 10 jt. */
async function serviceInvoice(tx: Tx, fiscalYearId: string, opts: { outstanding?: number } = {}) {
  const supplier = await tx.party.create({ data: { name: `IT-REVFY-Supplier-${tag()}`, partyType: 'Supplier', isActive: true } });
  const account = await tx.account.findFirstOrThrow({ where: { isGroup: false, rootType: 'EXPENSE' } });
  const invoice = await tx.purchaseInvoice.create({
    data: {
      invoiceNumber: `IT-REVFY-${tag()}`,
      date: new Date('2171-06-10'),
      partyId: supplier.id,
      status: 'Submitted',
      grandTotal: 10_000_000,
      outstanding: opts.outstanding ?? 10_000_000,
      fiscalYearId,
      createdBy: adminId,
      items: {
        create: [{ itemType: 'service', itemName: 'Jasa uji revisi', quantity: 1, unit: 'ls', rate: 10_000_000, amount: 10_000_000, accountId: account.id }],
      },
    },
    include: { items: true },
  });
  return { invoice, line: invoice.items[0]! };
}

const revise = (tx: Tx, invoiceId: string, itemId: string, newRate: number) =>
  revisePurchaseInvoiceInTx(tx, { invoiceId, lines: [{ itemId, newRate }], reason: 'Penyesuaian harga uji' }, adminId);

async function journalsOf(tx: Tx, fiscalYearIds: string[]) {
  return tx.journalEntry.findMany({ where: { fiscalYearId: { in: fiscalYearIds } }, include: { items: true } });
}

d('purchase invoice revision: fiscal year of the revision journal', () => {
  it('+3 jt on a 2171 invoice (year closed) books journal and ledger rows to 2172, numbered by the revision month', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171, isClosed: true });
      const y2 = await createFiscalYear(tx, { year: 2172 });
      const { invoice, line } = await serviceInvoice(tx, y1.id);
      clockAt('2172-02-10T03:00:00Z');

      await revise(tx, invoice.id, line.id, 13_000_000);

      expect(await journalsOf(tx, [y1.id])).toHaveLength(0);
      const jes = await journalsOf(tx, [y2.id]);
      expect(jes).toHaveLength(1);
      expect(jes[0]!.entryNumber).toMatch(/^JV-217202-\d{4}$/);
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceType: 'JournalEntry', referenceId: jes[0]!.id } });
      expect(ale.length).toBe(jes[0]!.items.length);
      expect(ale.every((a) => a.fiscalYearId === y2.id)).toBe(true);
      const after = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(Number(after.grandTotal)).toBe(13_000_000);
      expect(after.fiscalYearId).toBe(y1.id);
    });
  });

  it('31 Dec 17:30Z is already 1 Jan 2172 in WIB: the journal lands in 2172, numbered by January', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171 });
      const y2 = await createFiscalYear(tx, { year: 2172 });
      const { invoice, line } = await serviceInvoice(tx, y1.id);
      clockAt('2171-12-31T17:30:00Z');

      await revise(tx, invoice.id, line.id, 13_000_000);

      expect(await journalsOf(tx, [y1.id])).toHaveLength(0);
      const jes = await journalsOf(tx, [y2.id]);
      expect(jes).toHaveLength(1);
      expect(jes[0]!.entryNumber).toMatch(/^JV-217201-\d{4}$/);
    });
  });

  it('the day before (31 Dec 16:30Z) stays in 2171', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171 });
      const y2 = await createFiscalYear(tx, { year: 2172 });
      const { invoice, line } = await serviceInvoice(tx, y1.id);
      clockAt('2171-12-31T16:30:00Z');

      await revise(tx, invoice.id, line.id, 13_000_000);

      expect(await journalsOf(tx, [y2.id])).toHaveLength(0);
      expect((await journalsOf(tx, [y1.id]))[0]!.entryNumber).toMatch(/^JV-217112-\d{4}$/);
    });
  });

  it('a closed year of the revision date is PERIOD_CLOSED and nothing is written', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171 });
      const y2 = await createFiscalYear(tx, { year: 2172, isClosed: true });
      const { invoice, line } = await serviceInvoice(tx, y1.id);
      clockAt('2172-02-10T03:00:00Z');

      expect(await codeOf(revise(tx, invoice.id, line.id, 13_000_000))).toBe(PERIOD_CLOSED);

      expect(await journalsOf(tx, [y1.id, y2.id])).toHaveLength(0);
      const after = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { items: true } });
      expect(Number(after.grandTotal)).toBe(10_000_000);
      expect(Number(after.items[0]!.rate)).toBe(10_000_000);
    });
  });

  it('no fiscal year for the revision date is FISCAL_YEAR_MISSING', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171 });
      const { invoice, line } = await serviceInvoice(tx, y1.id);
      clockAt('2172-02-10T03:00:00Z');

      expect(await codeOf(revise(tx, invoice.id, line.id, 13_000_000))).toBe(FISCAL_YEAR_MISSING);
      expect(await journalsOf(tx, [y1.id])).toHaveLength(0);
    });
  });

  it('a revision date on or before the monthly lock is PERIOD_LOCKED', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171 });
      const y2 = await createFiscalYear(tx, { year: 2172 });
      const { invoice, line } = await serviceInvoice(tx, y1.id);
      clockAt('2172-02-10T03:00:00Z');
      const locked = await tx.$executeRaw`UPDATE period_lock SET lock_date = '2172-02-28'::date WHERE id = 1`;
      expect(locked).toBe(1);

      expect(await codeOf(revise(tx, invoice.id, line.id, 13_000_000))).toBe(PERIOD_LOCKED);
      expect(await journalsOf(tx, [y1.id, y2.id])).toHaveLength(0);
    });
  });
});

d('purchase invoice revision: current behaviour owned by E5 (characterisation)', () => {
  it('a decrease beyond the outstanding debits Hutang Usaha in full while the invoice outstanding stops at 0', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171 });
      const y2 = await createFiscalYear(tx, { year: 2172 });
      // 10 jt invoice, 8 jt already paid: 2 jt outstanding.
      const { invoice, line } = await serviceInvoice(tx, y1.id, { outstanding: 2_000_000 });
      clockAt('2172-02-10T03:00:00Z');

      await revise(tx, invoice.id, line.id, 6_000_000);

      const ap = await tx.account.findFirstOrThrow({ where: { accountNumber: '2.1.1' } });
      const [je] = await journalsOf(tx, [y2.id]);
      expect(je!.items.filter((i) => i.accountId === ap.id).map((i) => [Number(i.debit), Number(i.credit)])).toEqual([[4_000_000, 0]]);
      const after = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(Number(after.grandTotal)).toBe(6_000_000);
      expect(Number(after.outstanding)).toBe(0);
    });
  });

  it('revalues a receipt dated in a closed year by a Revaluation in the revision year; the receipt row is not rewritten', async () => {
    await inRollback(async (tx) => {
      const y1 = await createFiscalYear(tx, { year: 2171, isClosed: true });
      const y2 = await createFiscalYear(tx, { year: 2172 });
      const { invoice } = await serviceInvoice(tx, y1.id);
      const stamp = tag();
      const item = await tx.inventoryItem.create({
        data: { code: `IT-REVFY-${stamp}`, name: `Barang uji ${stamp}`, unit: 'kg', isActive: true },
      });
      const warehouse = await tx.warehouse.create({ data: { code: `IT-REVFY-${stamp}`, name: `Gudang uji ${stamp}` } });
      const { movementId } = await seedStock(tx, {
        itemId: item.id, warehouseId: warehouse.id, qty: 10, avg: 1_000_000, date: '2171-06-10', fiscalYearId: y1.id, userId: adminId,
      });
      const receipt = await tx.goodsReceipt.create({
        data: {
          sttNumber: `IT-REVFY-STT-${stamp}`, date: new Date('2171-06-10'), partyId: invoice.partyId, fiscalYearId: y1.id, createdBy: adminId,
          items: { create: [{ inventoryItemId: item.id, warehouseId: warehouse.id, itemName: item.name, quantity: 10, unit: 'kg', lockedUnitCost: 1_000_000, stockMovementId: movementId }] },
        },
        include: { items: true },
      });
      const piLine = await tx.purchaseInvoiceItem.findFirstOrThrow({ where: { purchaseInvoiceId: invoice.id } });
      await tx.purchaseInvoiceItem.update({
        where: { id: piLine.id },
        data: { itemType: 'product', inventoryItemId: item.id, quantity: 10, unit: 'kg', rate: 1_000_000, goodsReceiptItemId: receipt.items[0]!.id },
      });
      clockAt('2172-02-10T03:00:00Z');

      await revise(tx, invoice.id, piLine.id, 1_300_000);

      const sm = await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } });
      expect(Number(sm.unitCost)).toBe(1_000_000);
      expect(Number(sm.totalValue)).toBe(10_000_000);
      expect(sm.fiscalYearId).toBe(y1.id);
      const reval = await tx.stockMovement.findFirstOrThrow({ where: { adjustsMovementId: movementId, isCancelled: false } });
      expect([reval.movementType, reval.referenceType, Number(reval.valueDelta), reval.fiscalYearId])
        .toEqual(['Revaluation', 'PurchaseRevision', 3_000_000, y2.id]);
      expect(await journalsOf(tx, [y2.id])).toHaveLength(1);
    });
  });
});
