/**
 * Integration test: guards from the whole-train review of the value ledger (E3-R6, train PR review),
 * on fixtures made here inside a rollback transaction (helpers/salesFlowFixture.ts). Fiscal year 2169.
 * - a purchase invoice from before the value ledger whose landed-cost delta sits in the valuation
 *   baseline (no Revaluation row) cannot be cancelled: voiding its journal would move the GL alone;
 * - a legacy COGS settlement journal without its LegacyCogsSettle row cannot be voided by cancelling
 *   or editing its trigger, nor by cancelling its sales invoice;
 * - cancelling a delivery order with two Out rows of one item judges the stock-0 residue after both
 *   rows are back, not after the first.
 * Every scenario ends with assertLedgerInvariant (warehouses included).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import { bookOf, createSalesFlowWorld, receiveStock, type SalesFlowWorld } from '../helpers/salesFlowFixture';
import { REVERSAL_NEEDS_TRUE_UP } from '../../services/inventory/inventoryLedger';
import { systemAccounts } from '../../services/systemAccounts';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { cancelPurchaseInvoiceInTx } from '../../services/invoiceCancellation';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { settleCogsBackfillForItem, LEGACY_COGS_SETTLE } from '../../services/cogsBackfillService';
import { closeCogsBackfillForSalesInvoice, reverseCogsSettlementsByTrigger } from '../../services/cogsBackfillReverse';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2169;
const DAY = `${YEAR}-04-14`;

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

async function inWorld(fn: (tx: Tx, w: SalesFlowWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        const w = await createSalesFlowWorld(tx, YEAR);
        await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id], { warehouses: true });
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

const trail = (w: SalesFlowWorld) => ({ cancelledById: w.userId, cancelReason: null });

/** A row the migration baseline carries: no document, no journal (what a pre-ledger delta became). */
async function asBaselineRow(tx: Tx, id: string, n: string) {
  await tx.stockMovement.update({
    where: { id },
    data: { referenceType: 'ValuationBaseline', referenceId: null, referenceNumber: null, adjustsMovementId: null, journalEntryId: null, movementNumber: `SM-VB-IT2169-${n}` },
  });
}

d('purchase invoice with a pre-ledger landed-cost delta (train review)', () => {
  it('refuses the cancel: its journal would leave the GL while the book keeps the delta', async () => {
    await inWorld(async (tx, w) => {
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const line = await tx.goodsReceiptItem.findFirstOrThrow({ where: { goodsReceiptId: stt.goodsReceiptId } });
      const pi = await submitPurchaseInvoiceInTx(tx, {
        date: DAY, partyId: w.supplier.id,
        items: [{
          itemName: w.item.name, inventoryItemId: w.item.id, warehouseId: line.warehouseId, quantity: 100, unit: 'kg',
          rate: 10_500, taxPct: 0, pphPct: 0, goodsReceiptItemId: line.id,
        }],
      }, w.userId);
      const reval = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: pi.id, movementType: 'Revaluation' } });
      await asBaselineRow(tx, reval.id, '1');
      const before = await bookOf(tx, w.item.id);

      expect(await codeOf(inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, trail(w))))).toBe(REVERSAL_NEEDS_TRUE_UP);

      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Submitted');
    });
  });
});

d('legacy COGS settlement journal without a Revaluation row (train review)', () => {
  /** 100 kg in @10.000; 40 kg sold at 9.000 on a queue, settled at 10.000 (-40.000), then made a pre-ledger journal. */
  async function legacySettlement(tx: Tx, w: SalesFlowWorld) {
    const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
    const invoice = await submitSalesInvoiceInTx(tx, {
      date: DAY, partyId: w.customer.id, items: [{ itemName: 'Jasa uji HPP', itemType: 'service', quantity: 1, rate: 1_000_000 }],
    }, w.userId);
    const siItem = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
    await tx.cogsBackfillQueue.create({
      data: {
        salesInvoiceId: invoice.id, salesInvoiceItemId: siItem.id, inventoryItemId: w.item.id,
        qtyPending: 40, qtyOriginal: 40, costAtSale: 9_000, fiscalYearId: invoice.fiscalYearId,
      },
    });
    const settled = await settleCogsBackfillForItem(tx, {
      itemId: w.item.id, qtyAvailable: 100, unitCostNow: 10_000, userId: w.userId, settleDate: new Date(DAY),
      source: { type: 'StockMovement', refId: stt.movementId, refNo: 'IT-TRG-SM' },
    });
    const row = await tx.stockMovement.findUniqueOrThrow({ where: { journalEntryId: settled!.journalEntryId! } });
    expect(row.referenceType).toBe(LEGACY_COGS_SETTLE);
    await asBaselineRow(tx, row.id, '2');
    return { stt, invoice, journalEntryId: settled!.journalEntryId! };
  }

  it('refuses reversing the trigger of a settlement that has no row', async () => {
    await inWorld(async (tx, w) => {
      const { stt, journalEntryId } = await legacySettlement(tx, w);
      const before = await bookOf(tx, w.item.id);

      expect(await codeOf(inRouteTx((t) => reverseCogsSettlementsByTrigger(t, 'StockMovement', stt.movementId, trail(w))))).toBe(REVERSAL_NEEDS_TRUE_UP);

      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId } })).status).not.toBe('Cancelled');
    });
  });

  it('refuses closing the queue of a sales invoice whose settlement has no row', async () => {
    await inWorld(async (tx, w) => {
      const { invoice, journalEntryId } = await legacySettlement(tx, w);
      const before = await bookOf(tx, w.item.id);

      expect(await codeOf(inRouteTx((t) => closeCogsBackfillForSalesInvoice(t, invoice.id, trail(w))))).toBe(REVERSAL_NEEDS_TRUE_UP);

      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId } })).status).not.toBe('Cancelled');
      expect((await tx.cogsBackfillQueue.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } })).status).not.toBe('Cancelled');
    });
  });
});

d('delivery order with two Out rows of one item (train review)', () => {
  it('cancels although the first row alone would leave stock 0 with value on hand', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const out = (qty: number) => submitDeliveryOrderInTx(tx, {
        date: DAY, partyId: w.customer.id, allowNegativeStock: true, negativeStockReason: 'Barang sudah dikirim, STT menyusul',
        items: [
          { inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: qty, unit: 'kg' },
          { inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: qty, unit: 'kg' },
        ],
      }, w.userId);
      // All 100 kg out (0 / 0, average 10.000), then 2 x 50 kg below zero: -100 kg, -1.000.000.
      await submitDeliveryOrderInTx(tx, {
        date: DAY, partyId: w.customer.id,
        items: [{ inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: 100, unit: 'kg' }],
      }, w.userId);
      const doc = await out(50);
      // 50 kg in @12.000 (+600.000): -50 kg, -400.000.
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 50, avg: 12_000, day: DAY });
      expect(await bookOf(tx, w.item.id)).toMatchObject({ stock: '-50.000', value: '-400000.00' });

      // Row 1 back: 0 kg with 100.000; row 2 back: 50 kg, 600.000 (average 12.000).
      await inRouteTx((t) => cancelDeliveryOrderInTx(t, doc.id, w.userId));

      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '50.000', value: '600000.00', average: '12000.000000' });
    });
  });
});
