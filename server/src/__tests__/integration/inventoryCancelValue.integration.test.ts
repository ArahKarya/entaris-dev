/**
 * Integration test: the value true-up of a cancel (E3-R8, PR-6.5a), through the real services on a
 * fixture made inside a rollback transaction (helpers/salesFlowFixture.ts):
 * - PRD acceptance: STT A 100 @10.000, STT B 100 @20.000, delivery order 100 invoiced (COGS
 *   1.500.000), cancel STT B: one true-up journal DR inventory 500.000 / CR COGS, stock_value 0 and
 *   the GL of the item's inventory account 0 after the invoice, COGS 1.000.000;
 * - the negative-stock scenario, rewritten with explicit numbers (the PRD's "stockValue 10.000.000"
 *   is a typo: 100 kg x 10.000 = 1.000.000): average 9.000 at stock 0, a delivery of 100 through the
 *   bypass (stock −100, value −900.000), a receipt 100 @10.000 that settles the window (PR-6.6: DR
 *   COGS 100.000, stock 0, value 0), cancel the delivery: stock 100, stock_value 1.000.000, the
 *   settlement back through a true-up of +100.000; book = GL (+ the value of notes not invoiced
 *   yet) at every step;
 * - a sales return cancelled after the goods were sold again: the true-up comes back against COGS;
 * - the true-up journal is dated the day of the cancel (owner decision #3): a locked day refuses
 *   the cancel with PERIOD_LOCKED and nothing changes (fiscal year 2114).
 * "Today" is the fixture year's day (businessToday mocked). Every scenario ends with
 * assertLedgerInvariant (warehouses included). Fiscal years 2113 and 2114.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import {
  bookOf, createSalesFlowWorld, deliver, glBalance, invoiceDelivery, receiveStock, type SalesFlowWorld,
} from '../helpers/salesFlowFixture';
import { systemAccounts } from '../../services/systemAccounts';
import { sourceKeys } from '../../services/ledger/journalSource';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null, today: null as string | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../utils/businessDate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/businessDate')>();
  return { ...actual, businessToday: (...args: Parameters<typeof actual.businessToday>) => state.today ?? actual.businessToday(...args) };
});

import { prisma as appPrisma } from '../../lib/prisma';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { cancelSalesReturnInTx } from '../../services/salesReturnCancel';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2113;
const LOCKED_YEAR = 2114;

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

async function inWorld(year: number, today: string, fn: (tx: Tx, w: SalesFlowWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      state.today = today;
      try {
        const w = await createSalesFlowWorld(tx, year);
        await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id], { warehouses: true });
      } finally {
        state.tx = null;
        state.today = null;
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** Runs fn in a savepoint of the test transaction: a refusal leaves no partial writes. */
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

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);

/** The value of delivery notes not invoiced yet: in the book's outflow, not yet in the GL (no journal). */
async function uninvoicedNoteValue(tx: Tx, w: SalesFlowWorld): Promise<Decimal> {
  const rows = await tx.stockMovement.findMany({
    // The note's own Out rows: a true-up row of a cancelled note carries its journal already.
    where: { itemId: w.item.id, referenceType: 'DeliveryOrder', movementType: 'Out', isCancelled: false },
    select: { valueDelta: true, referenceId: true },
  });
  const notes = await tx.deliveryOrder.findMany({ where: { id: { in: rows.map((r) => r.referenceId!) } }, select: { id: true, invoiceId: true } });
  const open = new Set(notes.filter((n) => !n.invoiceId).map((n) => n.id));
  return rows.filter((r) => open.has(r.referenceId!)).reduce((s, r) => s.minus(r.valueDelta.toString()), new Decimal(0));
}

/** GL of the item's inventory account = stock_value + the value of notes not invoiced yet. */
async function expectBookEqualsGl(tx: Tx, w: SalesFlowWorld): Promise<void> {
  const book = await bookOf(tx, w.item.id);
  const gl = await glBalance(tx, w.accounts.inventory.id);
  expect(money(gl)).toBe(money(new Decimal(book.value).plus(await uninvoicedNoteValue(tx, w))));
}

async function trueUpJournal(tx: Tx, movementId: string) {
  const journals = await tx.journalEntry.findMany({
    where: { sourceKey: sourceKeys.inventoryTrueUp(movementId), status: { not: 'Cancelled' } },
    include: { items: true },
  });
  return journals;
}

d('cancel value true-up (E3-R8)', () => {
  it('PRD: STT A 100 @10.000, STT B 100 @20.000, DO 100 invoiced, cancel STT B -> DR inventory 500.000 / CR COGS', async () => {
    await inWorld(YEAR, `${YEAR}-03-20`, async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: `${YEAR}-03-02` });
      const b = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 20_000, day: `${YEAR}-03-03` });
      const note = await deliver(tx, w, `${YEAR}-03-05`, [{ qty: 100 }]);
      await invoiceDelivery(tx, w, `${YEAR}-03-06`, note, { rate: 25_000 });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '100.000', value: '1500000.00' });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('1500000.00');
      await expectBookEqualsGl(tx, w);

      await inRouteTx((t) => cancelGoodsReceiptInTx(t, b.goodsReceiptId, w.userId));

      const [journal, ...more] = await trueUpJournal(tx, b.movementId);
      expect(more).toHaveLength(0);
      expect(journal.entryNumber).toMatch(/^JV-\d{6}-/);
      expect(journal.date.toISOString().slice(0, 10)).toBe(`${YEAR}-03-20`);
      expect(journal.sourceType).toBe('SYSTEM_DOC');
      const line = (accountId: string) => journal.items.find((i) => i.accountId === accountId)!;
      expect(money(line(w.accounts.inventory.id).debit.toString())).toBe('500000.00');
      expect(money(line(w.accounts.cogs.id).credit.toString())).toBe('500000.00');

      const row = await tx.stockMovement.findFirstOrThrow({ where: { adjustsMovementId: b.movementId, movementType: 'Revaluation' } });
      expect(row).toMatchObject({ referenceType: 'GoodsReceipt', referenceId: b.goodsReceiptId, journalEntryId: journal.id, isCancelled: false });
      expect(money(row.valueDelta.toString())).toBe('500000.00');

      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '0.000', value: '0.00' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('0.00');
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('1000000.00');
    });
  });

  it('negative stock: DO past zero, receipt settles, cancel the DO -> stock 100, stock_value 1.000.000, true-up +100.000', async () => {
    await inWorld(YEAR, `${YEAR}-05-20`, async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 9_000, day: `${YEAR}-05-01` });
      const first = await deliver(tx, w, `${YEAR}-05-02`, [{ qty: 100 }]);
      await invoiceDelivery(tx, w, `${YEAR}-05-02`, first, { rate: 12_000 });
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '0.000', value: '0.00', average: '9000.000000' });
      await expectBookEqualsGl(tx, w);

      const minus = await submitDeliveryOrderInTx(tx, {
        date: `${YEAR}-05-03`, partyId: w.customer.id, allowNegativeStock: true, negativeStockReason: 'uji stok minus',
        items: [{ inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: 100, unit: 'kg' }],
      } as Parameters<typeof submitDeliveryOrderInTx>[1], w.userId);
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '-100.000', value: '-900000.00' });
      await expectBookEqualsGl(tx, w);

      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: `${YEAR}-05-04` });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '0.000', value: '0.00' });
      await expectBookEqualsGl(tx, w);

      const minusRow = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: 'DeliveryOrder', referenceId: minus.id } });
      await inRouteTx((t) => cancelDeliveryOrderInTx(t, minus.id, w.userId));

      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });
      const [journal, ...more] = await trueUpJournal(tx, minusRow.id);
      expect(more).toHaveLength(0);
      expect(money(journal.items.find((i) => i.accountId === w.accounts.inventory.id)!.debit.toString())).toBe('100000.00');
      expect(await tx.stockMovement.count({ where: { adjustsMovementId: minusRow.id } })).toBe(1);
      await expectBookEqualsGl(tx, w);
    });
  });

  it('a sales return cancelled after its goods were sold again: the true-up comes back against COGS', async () => {
    await inWorld(YEAR, `${YEAR}-07-20`, async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: `${YEAR}-07-01` });
      const sold = await deliver(tx, w, `${YEAR}-07-02`, [{ qty: 50 }]);
      const invoice = await invoiceDelivery(tx, w, `${YEAR}-07-02`, sold, { rate: 15_000 });
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 50, avg: 16_000, day: `${YEAR}-07-03` }); // 100 @ 13.000
      const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      // 10 back at the note's 10.000 -> 110 @ 12.727,272727 (1.400.000)
      const ret = await submitSalesReturnInTx(tx, {
        salesInvoiceId: invoice.id, date: `${YEAR}-07-04`, reason: 'uji',
        items: [{ salesInvoiceItemId: line.id, quantity: 10, restock: true, warehouseId: w.warehouseA.id }],
      }, w.userId);
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '110.000', value: '1400000.00' });
      const later = await deliver(tx, w, `${YEAR}-07-05`, [{ qty: 55 }]); // 700.000 out
      await invoiceDelivery(tx, w, `${YEAR}-07-05`, later, { rate: 15_000 });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '55.000', value: '700000.00' });
      const retRow = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: 'SalesReturn', referenceId: ret!.id } });

      await inRouteTx((t) => cancelSalesReturnInTx(t, ret!.id, { cancelledById: w.userId, cancelReason: null }));

      // Without the return the 55 went out of 100 @ 13.000 (715.000): 45 @ 13.000 = 585.000 left.
      // Exact reversal: 700.000 − 100.000 = 600.000, so the true-up is −15.000 (CR inventory / DR COGS).
      const [journal] = await trueUpJournal(tx, retRow.id);
      const jl = (accountId: string) => journal.items.find((i) => i.accountId === accountId)!;
      expect(money(jl(w.accounts.inventory.id).credit.toString())).toBe('15000.00');
      expect(money(jl(w.accounts.cogs.id).debit.toString())).toBe('15000.00');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '45.000', value: '585000.00', average: '13000.000000' });
      await expectBookEqualsGl(tx, w);
    });
  });

  it('a true-up on a locked day is refused with PERIOD_LOCKED and nothing changes (2114)', async () => {
    await inWorld(LOCKED_YEAR, `${LOCKED_YEAR}-04-15`, async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: `${LOCKED_YEAR}-05-02` });
      const b = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 20_000, day: `${LOCKED_YEAR}-05-03` });
      const note = await deliver(tx, w, `${LOCKED_YEAR}-05-05`, [{ qty: 100 }]);
      await invoiceDelivery(tx, w, `${LOCKED_YEAR}-05-06`, note, { rate: 25_000 });
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${LOCKED_YEAR}-04-30`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      const before = await bookOf(tx, w.item.id);
      const glBefore = money(await glBalance(tx, w.accounts.inventory.id));

      expect(await codeOf(inRouteTx((t) => cancelGoodsReceiptInTx(t, b.goodsReceiptId, w.userId)))).toBe('PERIOD_LOCKED');

      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe(glBefore);
      expect(await tx.stockMovement.findUniqueOrThrow({ where: { id: b.movementId } })).toMatchObject({ isCancelled: false });
      expect(await tx.goodsReceipt.findUniqueOrThrow({ where: { id: b.goodsReceiptId } })).toMatchObject({ status: 'Submitted' });
      expect(await trueUpJournal(tx, b.movementId)).toHaveLength(0);
    });
  });
});
