/**
 * Integration test: the outbound stock paths on the value ledger (E3-R6, PR-6.4d), on fixtures made
 * here inside a rollback transaction (helpers/salesFlowFixture.ts):
 * - receipt -> delivery order -> invoice: COGS is the value the DO's Out took out of the book
 *   (−value_delta, 225.030.000,00 for 45.000 of 90.000 kg at 5.000,666667, not qty x unit cost
 *   225.030.000,02), and the GL of the item's inventory account equals stock_value after the invoice;
 * - an invoice quantity that differs from the note still posts the note's movement value;
 * - a note of an item switched off before billing still posts its COGS;
 * - DO edit and cancel take the old rows back exactly;
 * - cancelling a billed invoice voids its COGS and leaves the note's value out of the book (a note
 *   not invoiced again), until the note is cancelled;
 * - a transfer moves quantity between warehouses only: legs carry value_delta 0, total_value shown
 *   rounded; its cancel puts both warehouses back;
 * - a purchase invoice whose price delta sits in a Revaluation row (as the value-ledger backfill
 *   writes it): cancelling it lowers stock_value by the delta and GL = book; after goods went out
 *   (also when the row was stamped after those sales, as the backfill does) it is refused with
 *   REVERSAL_NEEDS_TRUE_UP and nothing changes;
 * - a legacy invoice receipt that leaves stock 0 with a baseline residue: refused as a residue.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2111.
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
import { REVERSAL_NEEDS_TRUE_UP } from '../../services/inventory/inventoryLedger';
import { systemAccounts } from '../../services/systemAccounts';
import { postJournal } from '../../services/ledger/postJournal';
import { DOCUMENT_RULE } from '../../services/ledger/accountGuard';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import { editDeliveryOrderInTx } from '../../services/deliveryOrderEdit';
import { cancelDeliveryOrderInTx } from '../../services/deliveryOrderCancel';
import { cancelPurchaseInvoiceInTx, cancelSalesInvoiceInTx } from '../../services/invoiceCancellation';
import { cancelStockTransferInTx, submitStockTransferInTx } from '../../services/stockTransfer';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2111;
const DAY = `${YEAR}-04-07`;
const LATER = `${YEAR}-04-20`;

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

async function cogsJournal(tx: Tx, w: SalesFlowWorld, invoiceNumber: string) {
  const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-COGS-${invoiceNumber}` }, include: { items: true } });
  const line = (accountId: string) => je.items.find((i) => i.accountId === accountId);
  return {
    status: je.status,
    cogsDebit: money(line(w.accounts.cogs.id)?.debit.toString() ?? 0),
    inventoryCredit: money(line(w.accounts.inventory.id)?.credit.toString() ?? 0),
  };
}

async function warehouseStock(tx: Tx, w: SalesFlowWorld, warehouseId: string) {
  const row = await tx.inventoryStock.findUnique({ where: { itemId_warehouseId: { itemId: w.item.id, warehouseId } } });
  return row ? row.currentStock.toFixed(3) : '0.000';
}

/** 30.000 kg @5.000 and 60.000 kg @5.001 into warehouse A: 90.000 kg, 450.060.000,00. */
async function receiveTwoLots(tx: Tx, w: SalesFlowWorld) {
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 30_000, avg: 5_000, day: DAY });
  await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 60_000, avg: 5_001, day: DAY });
}

d('outbound paths on the value ledger (PR-6.4d)', () => {
  it('receipt -> DO -> invoice: COGS = −value_delta of the DO row, GL of the item account = stock_value', async () => {
    await inWorld(async (tx, w) => {
      await receiveTwoLots(tx, w);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '90000.000', value: '450060000.00', average: '5000.666667' });

      const doc = await deliver(tx, w, DAY, [{ qty: 45_000 }]);
      const out = await tx.stockMovement.findUniqueOrThrow({ where: { id: doc.items[0]!.stockMovementId! } });
      expect(out.movementType).toBe('Out');
      expect(money(out.valueDelta.toString())).toBe('-225030000.00');
      expect(money(out.totalValue.toString())).toBe('225030000.00');
      expect(out.unitCost.toFixed(6)).toBe('5000.666667');
      expect(out.offsetAccountId).toBe(w.accounts.cogs.id);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '45000.000', value: '225030000.00', average: '5000.666667' });
      expect(await warehouseStock(tx, w, w.warehouseA.id)).toBe('45000.000');

      const invoice = await invoiceDelivery(tx, w, DAY, doc, { rate: 6_000 });
      // qty x unit cost would be 45.000 x 5.000,666667 = 225.030.000,02; the book took 225.030.000,00.
      expect(await cogsJournal(tx, w, invoice.invoiceNumber)).toEqual({ status: 'Submitted', cogsDebit: '225030000.00', inventoryCredit: '225030000.00' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('225030000.00');
      expect((await tx.deliveryOrder.findUniqueOrThrow({ where: { id: doc.id } })).invoiceId).toBe(invoice.id);

      // The rest of the stock: the whole remaining value leaves, the book and the GL end at 0.
      const rest = await deliver(tx, w, LATER, [{ qty: 45_000 }]);
      const restInvoice = await invoiceDelivery(tx, w, LATER, rest, { rate: 6_000 });
      expect((await cogsJournal(tx, w, restInvoice.invoiceNumber)).cogsDebit).toBe('225030000.00');
      expect((await bookOf(tx, w.item.id)).value).toBe('0.00');
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('0.00');
    });
  });

  it('an invoice quantity that differs from the note posts the note\'s movement value (3.600.000, not 250 x 12.000)', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 300 }]);
      const invoice = await invoiceDelivery(tx, w, DAY, doc, { rate: 15_000, qty: 250 });
      expect(await cogsJournal(tx, w, invoice.invoiceNumber)).toEqual({ status: 'Submitted', cogsDebit: '3600000.00', inventoryCredit: '3600000.00' });
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '700.000', value: '8400000.00', average: '12000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('8400000.00');
    });
  });

  it('a note of an item switched off before billing still posts its COGS', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 100 }]);
      await tx.inventoryItem.update({ where: { id: w.item.id }, data: { isActive: false } });
      const invoice = await invoiceDelivery(tx, w, DAY, doc, { rate: 15_000 });
      expect(await cogsJournal(tx, w, invoice.invoiceNumber)).toEqual({ status: 'Submitted', cogsDebit: '1200000.00', inventoryCredit: '1200000.00' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('10800000.00');
      expect((await bookOf(tx, w.item.id)).value).toBe('10800000.00');
    });
  });

  it('DO edit and cancel take the old rows back exactly', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 300 }]);
      const firstRowId = doc.items[0]!.stockMovementId!;
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '700.000', value: '8400000.00', average: '12000.000000' });

      const edited = await editDeliveryOrderInTx(tx, doc.id, {
        date: DAY, partyId: w.customer.id,
        items: [{ inventoryItemId: w.item.id, warehouseId: w.warehouseA.id, itemName: w.item.name, quantity: 200, unit: 'kg' }],
      }, w.userId);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: firstRowId } })).isCancelled).toBe(true);
      const newRow = await tx.stockMovement.findUniqueOrThrow({ where: { id: edited.items[0]!.stockMovementId! } });
      expect(money(newRow.valueDelta.toString())).toBe('-2400000.00');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '800.000', value: '9600000.00', average: '12000.000000' });

      await cancelDeliveryOrderInTx(tx, doc.id, w.userId);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: newRow.id } })).isCancelled).toBe(true);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1000.000', value: '12000000.00', average: '12000.000000' });
      expect(await warehouseStock(tx, w, w.warehouseA.id)).toBe('1000.000');
      // The note never had a journal: the GL kept the receipt.
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('12000000.00');
    });
  });

  it('cancelling the invoice voids its COGS; the note\'s value stays out until the note is cancelled', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 300 }]);
      const invoice = await invoiceDelivery(tx, w, DAY, doc, { rate: 15_000 });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('8400000.00');

      await cancelSalesInvoiceInTx(tx, invoice.id, { cancelledById: w.userId, cancelReason: null });
      expect((await cogsJournal(tx, w, invoice.invoiceNumber)).status).toBe('Cancelled');
      // The DO's Out stays active: book 8.400.000, GL 12.000.000, the gap is the note not billed.
      expect((await bookOf(tx, w.item.id)).value).toBe('8400000.00');
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('12000000.00');
      expect((await tx.deliveryOrder.findUniqueOrThrow({ where: { id: doc.id } })).invoiceId).toBeNull();

      await cancelDeliveryOrderInTx(tx, doc.id, w.userId);
      expect((await bookOf(tx, w.item.id)).value).toBe('12000000.00');
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('12000000.00');
    });
  });

  it('a transfer moves quantity only: legs carry value_delta 0, total_value rounded; its cancel puts both warehouses back', async () => {
    await inWorld(async (tx, w) => {
      await receiveTwoLots(tx, w);
      const before = await bookOf(tx, w.item.id);
      const transfer = await submitStockTransferInTx(tx, {
        date: DAY, fromWarehouseId: w.warehouseA.id, toWarehouseId: w.warehouseB.id, items: [{ itemId: w.item.id, quantity: 100 }],
      }, w.userId);
      const legs = await tx.stockMovement.findMany({ where: { referenceType: 'StockTransfer', referenceId: transfer.id }, orderBy: { movementType: 'asc' } });
      expect(legs.map((l) => [l.movementType, l.warehouseId, money(l.valueDelta.toString()), money(l.totalValue.toString()), l.unitCost.toFixed(6)])).toEqual([
        ['TransferOut', w.warehouseA.id, '0.00', '500066.67', '5000.666667'],
        ['TransferIn', w.warehouseB.id, '0.00', '500066.67', '5000.666667'],
      ]);
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect(await warehouseStock(tx, w, w.warehouseA.id)).toBe('89900.000');
      expect(await warehouseStock(tx, w, w.warehouseB.id)).toBe('100.000');

      await cancelStockTransferInTx(tx, transfer.id);
      expect((await tx.stockMovement.count({ where: { referenceId: transfer.id, isCancelled: false } }))).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect(await warehouseStock(tx, w, w.warehouseA.id)).toBe('90000.000');
      expect(await warehouseStock(tx, w, w.warehouseB.id)).toBe('0.000');

      // Goods shipped from the destination are valued from the item's one book (I-43).
      await submitStockTransferInTx(tx, {
        date: DAY, fromWarehouseId: w.warehouseA.id, toWarehouseId: w.warehouseB.id, items: [{ itemId: w.item.id, quantity: 250 }],
      }, w.userId);
      const doc = await deliver(tx, w, DAY, [{ qty: 100, warehouseId: w.warehouseB.id }]);
      const out = await tx.stockMovement.findUniqueOrThrow({ where: { id: doc.items[0]!.stockMovementId! } });
      // round(450.060.000 x 100 / 90.000, 2)
      expect(money(out.valueDelta.toString())).toBe('-500066.67');
      expect(await warehouseStock(tx, w, w.warehouseB.id)).toBe('150.000');
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('450060000.00');
    });
  });

  /**
   * A purchase invoice of a received lot whose price delta (+50.000) lives in a Revaluation row the
   * way the value-ledger backfill (or PR-6.4c3) writes it: quantity 0, no warehouse, adjusting the
   * receipt, referenced to the invoice, and debited to inventory by the invoice's journal.
   */
  async function invoiceWithRevaluation(tx: Tx, w: SalesFlowWorld, receiptId: string, createdAt?: Date) {
    const delta = new Decimal(50_000);
    const supplier = await tx.party.create({ data: { name: `IT-SF Supplier ${Date.now()}`, partyType: 'Supplier', isActive: true } });
    const invoiceNumber = `IT-SF-PI-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const pi = await tx.purchaseInvoice.create({
      data: {
        invoiceNumber, date: new Date(DAY), partyId: supplier.id, status: 'Submitted', grandTotal: delta.toNumber(),
        outstanding: delta.toNumber(), fiscalYearId: w.fyId, createdBy: w.userId, submittedAt: new Date(),
      },
    });
    await postJournal(tx, {
      date: new Date(DAY), narration: `IT-SF selisih harga ${invoiceNumber}`, entryNumber: `JV-${invoiceNumber}`,
      lines: [
        { accountId: w.accounts.inventory.id, debit: delta.toString(), credit: 0, description: 'selisih harga' },
        { accountId: w.accounts.receiptOffset.id, debit: 0, credit: delta.toString(), description: 'selisih harga' },
      ],
      sourceType: 'SYSTEM_DOC', createdBy: w.userId, accountRule: DOCUMENT_RULE, partyRule: 'off',
    });
    await tx.stockMovement.create({
      data: {
        movementNumber: `SM-RV-${invoiceNumber}`, date: new Date(DAY), itemId: w.item.id, warehouseId: null, movementType: 'Revaluation',
        quantity: 0, unitCost: 0, totalValue: delta.toNumber(), valueDelta: delta.toNumber(), referenceType: 'PurchaseInvoice',
        referenceId: pi.id, referenceNumber: invoiceNumber, adjustsMovementId: receiptId, fiscalYearId: w.fyId, createdById: w.userId,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: w.item.id } });
    const value = new Decimal(item.stockValue.toString()).plus(delta);
    await tx.inventoryItem.update({
      where: { id: w.item.id },
      data: { stockValue: value.toString(), averageCost: averageAfter(item.currentStock.toString(), value, item.averageCost.toString()).toString() },
    });
    return pi;
  }

  it('cancelling a purchase invoice with a backfilled Revaluation lowers stock_value by the delta; GL = book', async () => {
    await inWorld(async (tx, w) => {
      const { movementId } = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const pi = await invoiceWithRevaluation(tx, w, movementId);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '100.000', value: '1050000.00', average: '10500.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1050000.00');

      await cancelPurchaseInvoiceInTx(tx, pi.id, { cancelledById: w.userId, cancelReason: null });
      expect(await tx.stockMovement.count({ where: { referenceId: pi.id, isCancelled: false } })).toBe(0);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1000000.00');
      // The receipt it adjusted stays active.
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } })).isCancelled).toBe(false);
    });
  });

  it('after goods went out, the purchase invoice cancel is refused with REVERSAL_NEEDS_TRUE_UP and nothing changes', async () => {
    await inWorld(async (tx, w) => {
      const { movementId } = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const pi = await invoiceWithRevaluation(tx, w, movementId);
      await deliver(tx, w, DAY, [{ qty: 10 }]);
      const before = await bookOf(tx, w.item.id);
      expect(before).toEqual({ stock: '90.000', value: '945000.00', average: '10500.000000' });

      expect(await codeOf(inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, { cancelledById: w.userId, cancelReason: null })))).toBe(REVERSAL_NEEDS_TRUE_UP);
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Submitted');
      expect(await tx.stockMovement.count({ where: { referenceId: pi.id, isCancelled: false } })).toBe(1);
    });
  });

  it('a backfilled Revaluation stamped after the sales (deploy time) is still refused: goods went out after the receipt it adjusts', async () => {
    await inWorld(async (tx, w) => {
      const { movementId } = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      await deliver(tx, w, DAY, [{ qty: 90 }]);
      // The backfill writes the row at migration time, after the old delivery orders.
      const pi = await invoiceWithRevaluation(tx, w, movementId, new Date(Date.now() + 60_000));
      const before = await bookOf(tx, w.item.id);
      expect(before).toEqual({ stock: '10.000', value: '150000.00', average: '15000.000000' });

      expect(await codeOf(inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, { cancelledById: w.userId, cancelReason: null })))).toBe(REVERSAL_NEEDS_TRUE_UP);
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Submitted');
    });
  });

  it('a legacy purchase invoice receipt that leaves stock 0 with a baseline residue is refused as a residue, not as goods gone out', async () => {
    await inWorld(async (tx, w) => {
      const { movementId } = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      const supplier = await tx.party.create({ data: { name: `IT-SF Supplier ${Date.now()}`, partyType: 'Supplier', isActive: true } });
      const invoiceNumber = `IT-SF-PI-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const pi = await tx.purchaseInvoice.create({
        data: {
          invoiceNumber, date: new Date(DAY), partyId: supplier.id, status: 'Submitted', grandTotal: 1_000_000,
          outstanding: 1_000_000, fiscalYearId: w.fyId, createdBy: w.userId, submittedAt: new Date(),
        },
      });
      // A legacy invoice that received the goods itself, and the 6.4b1 baseline that closed the item's gap.
      await tx.stockMovement.update({ where: { id: movementId }, data: { referenceType: 'PurchaseInvoice', referenceId: pi.id, referenceNumber: invoiceNumber } });
      await tx.stockMovement.create({
        data: {
          movementNumber: `IT-SF-BL-${invoiceNumber}`, date: new Date(DAY), itemId: w.item.id, warehouseId: null, movementType: 'Revaluation',
          quantity: 0, unitCost: 0, totalValue: 3_250, valueDelta: 3_250, referenceType: 'ValuationBaseline', fiscalYearId: w.fyId, createdById: w.userId,
        },
      });
      await tx.inventoryItem.update({ where: { id: w.item.id }, data: { stockValue: '1003250', averageCost: '10032.5' } });
      await postJournal(tx, {
        date: new Date(DAY), narration: `IT-SF baseline ${invoiceNumber}`,
        lines: [
          { accountId: w.accounts.inventory.id, debit: '3250', credit: 0, description: 'baseline' },
          { accountId: w.accounts.receiptOffset.id, debit: 0, credit: '3250', description: 'baseline' },
        ],
        sourceType: 'SYSTEM_DOC', createdBy: w.userId, accountRule: DOCUMENT_RULE, partyRule: 'off',
      });
      const before = await bookOf(tx, w.item.id);

      let refusal: BusinessError | null = null;
      try {
        await inRouteTx((t) => cancelPurchaseInvoiceInTx(t, pi.id, { cancelledById: w.userId, cancelReason: null }));
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        refusal = e;
      }
      expect(refusal).toMatchObject({ code: REVERSAL_NEEDS_TRUE_UP, status: 409 });
      expect(refusal!.message).toContain('menjadi 0 tetapi nilai persediaannya masih 3250.00');
      expect(refusal!.message).not.toContain('sudah sebagian keluar');
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Submitted');
    });
  });
});
