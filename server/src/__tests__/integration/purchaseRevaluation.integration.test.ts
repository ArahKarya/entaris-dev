/**
 * Integration test: purchase invoice landed cost and price revision as Revaluation rows of the value
 * ledger, and the legacy COGS settlement through it (E3-R6, PR-6.4c3), on fixtures made here inside
 * a rollback transaction (helpers/salesFlowFixture.ts):
 * - STT -> PI landed +50.000 -> cancel PI -> cancel STT: the STT row keeps its locked cost, one
 *   Revaluation carries the delta, book = GL of the item account at every step;
 * - a live Revaluation entered the book at the invoice: goods that went out before it do not refuse
 *   the invoice cancel, goods that went out after it do (REVERSAL_NEEDS_TRUE_UP);
 * - PI after the goods were all sold: the whole delta goes to COGS, stock_value stays 0;
 * - a revision down beyond the value left: the rest goes to COGS, the average is 0, never negative;
 * - a revision of an STT that carries a backfilled Revaluation: batch cost and average take both,
 *   cancelling the invoice takes both back and voids the revision journal;
 * - a legacy COGS settlement moves value out of stock by a Revaluation linked to its journal, and
 *   reversing the trigger takes it back.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2131.
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
import { averageAfter } from '../../services/inventory/inventoryValueMath';
import { REVERSAL_NEEDS_TRUE_UP, batchUnitCosts } from '../../services/inventory/inventoryLedger';
import { systemAccounts } from '../../services/systemAccounts';
import { postJournal } from '../../services/ledger/postJournal';
import { DOCUMENT_RULE } from '../../services/ledger/accountGuard';
import { purchaseRevisionPrefix } from '../../services/ledger/journalSource';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { revisePurchaseInvoiceInTx } from '../../services/purchaseInvoiceRevise';
import { cancelPurchaseInvoiceInTx } from '../../services/invoiceCancellation';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { LEGACY_COGS_SETTLE, settleCogsBackfillForItem } from '../../services/cogsBackfillService';
import { reverseCogsSettlementsByTrigger } from '../../services/cogsBackfillReverse';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2131;
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

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);
const trail = (w: SalesFlowWorld) => ({ cancelledById: w.userId, cancelReason: null });

/** Book value and the GL balance of the item's inventory account, which must agree. */
async function bookAndGl(tx: Tx, w: SalesFlowWorld) {
  const book = await bookOf(tx, w.item.id);
  expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe(book.value);
  return book;
}

/** A purchase invoice of the whole STT line at `rate` per kg, through the real service. */
async function invoiceReceipt(tx: Tx, w: SalesFlowWorld, goodsReceiptId: string, rate: number) {
  const line = await tx.goodsReceiptItem.findFirstOrThrow({ where: { goodsReceiptId } });
  return submitPurchaseInvoiceInTx(tx, {
    date: DAY,
    partyId: w.supplier.id,
    items: [{
      itemName: w.item.name, inventoryItemId: w.item.id, warehouseId: line.warehouseId, quantity: Number(line.quantity),
      unit: 'kg', rate, taxPct: 0, pphPct: 0, goodsReceiptItemId: line.id,
    }],
  }, w.userId);
}

/** The active Revaluation rows of a purchase invoice: [reference_type, value_delta, adjusted row]. */
async function revaluationsOf(tx: Tx, invoiceId: string) {
  const rows = await tx.stockMovement.findMany({
    where: { referenceId: invoiceId, movementType: 'Revaluation', isCancelled: false },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => [r.referenceType, money(r.valueDelta.toString()), r.adjustsMovementId]);
}

async function batchCost(tx: Tx, movementId: string): Promise<string> {
  const row = await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } });
  return (await batchUnitCosts(tx, [row])).get(movementId)!.toFixed(6);
}

/** Goods out through a delivery order billed by an invoice, so the COGS journal moves the GL too. */
async function sell(tx: Tx, w: SalesFlowWorld, qty: number) {
  const doc = await deliver(tx, w, DAY, [{ qty }]);
  await invoiceDelivery(tx, w, DAY, doc, { rate: 15_000 });
}

d('purchase invoice landed cost on the value ledger (PR-6.4c3)', () => {
  it('STT -> PI landed +50.000 -> cancel PI -> cancel STT: book = GL at every step, the STT row is never rewritten', async () => {
    await inWorld(async (tx, w) => {
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });

      const pi = await invoiceReceipt(tx, w, stt.goodsReceiptId, 10_500);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '1050000.00', average: '10500.000000' });
      expect(await revaluationsOf(tx, pi.id)).toEqual([['PurchaseInvoice', '50000.00', stt.movementId]]);
      const row = await tx.stockMovement.findUniqueOrThrow({ where: { id: stt.movementId } });
      expect([money(row.totalValue.toString()), money(row.valueDelta.toString()), row.unitCost.toFixed(6)])
        .toEqual(['1000000.00', '1000000.00', '10000.000000']);
      expect(await batchCost(tx, stt.movementId)).toBe('10500.000000');
      await assertLedgerInvariant(tx, [w.item.id]);

      await inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, trail(w)));
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });
      expect(await revaluationsOf(tx, pi.id)).toEqual([]);
      expect(await batchCost(tx, stt.movementId)).toBe('10000.000000');
      await assertLedgerInvariant(tx, [w.item.id]);

      await inRouteTx((t) => cancelGoodsReceiptInTx(t, stt.goodsReceiptId, w.userId));
      expect(await bookAndGl(tx, w)).toEqual({ stock: '0.000', value: '0.00', average: '10000.000000' });
    });
  });

  it('goods sold before the invoice do not refuse its cancel; goods sold after it do', async () => {
    await inWorld(async (tx, w) => {
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      await sell(tx, w, 10);
      // +50.000 into the 90 kg left: 900.000 -> 950.000.
      const pi = await invoiceReceipt(tx, w, stt.goodsReceiptId, 10_500);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '90.000', value: '950000.00', average: '10555.555556' });

      await inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, trail(w)));
      expect(await bookAndGl(tx, w)).toEqual({ stock: '90.000', value: '900000.00', average: '10000.000000' });

      const again = await invoiceReceipt(tx, w, stt.goodsReceiptId, 10_500);
      await sell(tx, w, 10);
      const before = await bookAndGl(tx, w);
      expect(await codeOf(inRouteTx((t) => cancelPurchaseInvoiceInTx(t, again.id, trail(w))))).toBe(REVERSAL_NEEDS_TRUE_UP);
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: again.id } })).status).toBe('Submitted');
    });
  });

  it('a PI after the goods were all sold sends the whole delta to COGS; stock_value stays 0', async () => {
    await inWorld(async (tx, w) => {
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      await sell(tx, w, 100);
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('1000000.00');

      const pi = await invoiceReceipt(tx, w, stt.goodsReceiptId, 10_500);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '0.000', value: '0.00', average: '10000.000000' });
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('1050000.00');
      // The row is written with no value: the invoice owns a trace of its COGS line.
      expect(await revaluationsOf(tx, pi.id)).toEqual([['PurchaseInvoice', '0.00', stt.movementId]]);
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${pi.invoiceNumber}` }, include: { items: true } });
      expect(je.items.filter((i) => i.accountId === w.accounts.cogs.id).map((i) => [money(i.debit.toString()), money(i.credit.toString())]))
        .toEqual([['50000.00', '0.00']]);
    });
  });
});

d('purchase invoice price revision on the value ledger (PR-6.4c3)', () => {
  it('a revision down beyond the value left: the rest goes to COGS and the average is 0, never negative', async () => {
    await inWorld(async (tx, w) => {
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const pi = await invoiceReceipt(tx, w, stt.goodsReceiptId, 10_000);
      // The delivery picks no batch, so the revision sees the whole lot as still in stock.
      await sell(tx, w, 90);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '10.000', value: '100000.00', average: '10000.000000' });
      const cogsBefore = await glBalance(tx, w.accounts.cogs.id);

      // (1.000 − 10.000) x 100 = −900.000: −100.000 out of the stock left, −800.000 to COGS.
      const line = await tx.purchaseInvoiceItem.findFirstOrThrow({ where: { purchaseInvoiceId: pi.id } });
      await revisePurchaseInvoiceInTx(tx, { invoiceId: pi.id, lines: [{ itemId: line.id, newRate: 1_000 }], reason: 'Harga final dari Supplier turun' }, w.userId);

      expect(await bookAndGl(tx, w)).toEqual({ stock: '10.000', value: '0.00', average: '0.000000' });
      expect(money((await glBalance(tx, w.accounts.cogs.id)).minus(cogsBefore))).toBe('-800000.00');
      expect(await revaluationsOf(tx, pi.id)).toEqual([['PurchaseRevision', '-100000.00', stt.movementId]]);
      const after = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } });
      expect(money(after.grandTotal.toString())).toBe('100000.00');
    });
  });

  it('a revision of an STT with a backfilled Revaluation adds to it; cancelling the PI takes both back and voids the revision journal', async () => {
    await inWorld(async (tx, w) => {
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const pi = await invoiceReceipt(tx, w, stt.goodsReceiptId, 10_000);
      // The value-ledger backfill's row of an old landed cost (+50.000), with its inventory debit.
      await postJournal(tx, {
        date: new Date(DAY), narration: `IT-PRV selisih harga lama ${pi.invoiceNumber}`, entryNumber: `JV-${pi.invoiceNumber}-OLD`,
        lines: [
          { accountId: w.accounts.inventory.id, debit: '50000', credit: 0, description: 'selisih harga lama' },
          { accountId: w.accounts.receiptOffset.id, debit: 0, credit: '50000', description: 'selisih harga lama' },
        ],
        sourceType: 'SYSTEM_DOC', createdBy: w.userId, accountRule: DOCUMENT_RULE, partyRule: 'off',
      });
      await tx.stockMovement.create({
        data: {
          movementNumber: `SM-RV-${pi.invoiceNumber}`, date: new Date(DAY), itemId: w.item.id, warehouseId: null, movementType: 'Revaluation',
          quantity: 0, unitCost: 0, totalValue: 50_000, valueDelta: 50_000, referenceType: 'PurchaseInvoice', referenceId: pi.id,
          referenceNumber: pi.invoiceNumber, adjustsMovementId: stt.movementId, fiscalYearId: w.fyId, createdById: w.userId,
        },
      });
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: w.item.id } });
      await tx.inventoryItem.update({
        where: { id: w.item.id },
        data: { stockValue: '1050000', averageCost: averageAfter(item.currentStock.toString(), '1050000', item.averageCost.toString()).toString() },
      });

      // 10.000 -> 10.500 on the 100 kg still in stock: +50.000 more.
      const line = await tx.purchaseInvoiceItem.findFirstOrThrow({ where: { purchaseInvoiceId: pi.id } });
      await revisePurchaseInvoiceInTx(tx, { invoiceId: pi.id, lines: [{ itemId: line.id, newRate: 10_500 }], reason: 'Harga final dari Supplier naik' }, w.userId);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '1100000.00', average: '11000.000000' });
      expect(await batchCost(tx, stt.movementId)).toBe('11000.000000');
      expect((await revaluationsOf(tx, pi.id)).map((r) => r.slice(0, 2)).sort())
        .toEqual([['PurchaseInvoice', '50000.00'], ['PurchaseRevision', '50000.00']]);
      const revision = await tx.journalEntry.findFirstOrThrow({ where: { sourceKey: { startsWith: purchaseRevisionPrefix(pi.id) } } });
      expect([revision.sourceType, revision.status]).toEqual(['SYSTEM_DOC', 'Submitted']);
      await assertLedgerInvariant(tx, [w.item.id]);

      await inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, trail(w)));
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });
      expect(await revaluationsOf(tx, pi.id)).toEqual([]);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: revision.id } })).status).toBe('Cancelled');
      expect(await batchCost(tx, stt.movementId)).toBe('10000.000000');
    });
  });
});

d('legacy COGS settlement on the value ledger (PR-6.4c3, decision #6)', () => {
  it('moves the differential out of stock by a Revaluation linked to its journal; reversing the trigger takes it back', async () => {
    await inWorld(async (tx, w) => {
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

      // 40 kg sold at 9.000, now costing 10.000: 40.000 more COGS, out of stock.
      const settled = await settleCogsBackfillForItem(tx, {
        itemId: w.item.id, qtyAvailable: 100, unitCostNow: 10_000, userId: w.userId, settleDate: new Date(DAY),
        source: { type: 'StockMovement', refId: stt.movementId, refNo: 'IT-PRV-SM' },
      });
      expect(settled?.totalDifferential).toBe(40_000);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '960000.00', average: '9600.000000' });
      const row = await tx.stockMovement.findUniqueOrThrow({ where: { journalEntryId: settled!.journalEntryId! } });
      expect([row.movementType, row.referenceType, row.referenceId, money(row.valueDelta.toString())])
        .toEqual(['Revaluation', LEGACY_COGS_SETTLE, stt.movementId, '-40000.00']);
      await assertLedgerInvariant(tx, [w.item.id]);

      await reverseCogsSettlementsByTrigger(tx, 'StockMovement', stt.movementId);
      expect(await bookAndGl(tx, w)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: row.id } })).isCancelled).toBe(true);
      const queue = await tx.cogsBackfillQueue.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      expect([queue.status, Number(queue.qtyPending)]).toEqual(['Pending', 40]);
    });
  });
});
