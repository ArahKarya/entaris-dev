/**
 * Integration test: transfer and deposit cancel safeguards and the delivery note audit snapshot
 * (E1-R3).
 *
 * - A stock transfer cannot be cancelled once the destination used the goods: either an active
 *   movement picked the TransferIn batch, or the destination stock fell below the transferred qty
 *   (only inventory.negative_stock may force the second case).
 * - A customer or supplier deposit with a refund cannot be cancelled; the remainder stays usable.
 * - Two concurrent cancels of one transfer reverse the stock once.
 * - A legacy deposit without a journal link voids its unlinked create journal (found by number or
 *   exact narration), never another journal's rows, and never reverses an already voided one.
 * - A deposit created by a sales return cannot be cancelled on its own.
 * - A full delivery note edit leaves the old lines in audit_trail.oldValues.
 *
 * Route handlers and services run through the route harness, whose `$transaction` is a
 * savepoint; everything runs in a rollback transaction in a far-future year, except the concurrent
 * transfer cancel, which commits its fixture and deletes it after.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { prisma as appPrisma } from '../../lib/prisma';
import {
  submitStockTransferInTx,
  cancelStockTransferInTx,
  STOCK_TRANSFER_CANCEL_BATCH_USED,
  STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK,
} from '../../services/stockTransfer';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { editDeliveryOrderInTx } from '../../services/deliveryOrderEdit';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { DEPOSIT_CANCEL_REFUNDED, DEPOSIT_CANCEL_SALES_RETURN } from '../../services/depositCancelGuard';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { systemAccounts } from '../../services/systemAccounts';
import { updateAccountBalance } from '../../utils/accountBalance';
import { invalidatePermissionCache } from '../../services/permissionService';
import stockTransfersRouter from '../../routes/stockTransfers';
import customerDepositsRouter from '../../routes/customerDeposits';
import vendorDepositsRouter from '../../routes/vendorDeposits';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
/** The acting user and its role; the concurrent test creates and deletes its own user. */
let userId: string;
let role: string;
let warehouseId: string;
let cashAccountId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const wh = await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!wh) throw new Error('No active warehouse.');
  warehouseId = wh.id;
  const cash = await prisma.account.findFirst({ where: { accountNumber: { startsWith: '1.1.' }, isGroup: false } });
  if (!cash) throw new Error('No cash account (1.1.x) configured.');
  cashAccountId = cash.id;
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
      // The role cache is loaded through the harness; never reuse one from another transaction.
      invalidatePermissionCache();
      try {
        // Transfer and deposit cancels require doc.cancel; a forced transfer cancel also inventory.negative_stock.
        ({ userId, role } = await createCapUser(tx, ['doc.cancel', 'inventory.negative_stock']));
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2094;

/** A service call in its own savepoint, like the route transaction that wraps it in production. */
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

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function stockItem(tx: Tx, stock: number) {
  const item = await tx.inventoryItem.create({
    data: { code: `IT-E1R3-${tag()}`, name: `Uji batal ${tag()}`, unit: 'kg', currentStock: stock, averageCost: 9_000, isActive: true },
  });
  await tx.inventoryStock.create({ data: { itemId: item.id, warehouseId, currentStock: stock } });
  return item;
}

function warehouse(tx: Tx) {
  return tx.warehouse.create({ data: { code: `IT-E1R3-${tag()}`, name: `Gudang uji ${tag()}` } });
}

async function stockAt(tx: Tx, itemId: string, whId: string) {
  const row = await tx.inventoryStock.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId: whId } } });
  return Number(row?.currentStock ?? 0);
}

function party(tx: Tx, partyType: 'Customer' | 'Supplier') {
  return tx.party.create({ data: { name: `IT-E1R3-${partyType}-${tag()}`, partyType, isActive: true } });
}

/** 1,000 kg from the default warehouse to a new warehouse B. */
async function transferToB(tx: Tx) {
  await createFiscalYear(tx, { year: Y });
  const item = await stockItem(tx, 1_000);
  const b = await warehouse(tx);
  const transfer = await submitStockTransferInTx(
    tx,
    { date: `${Y}-03-10`, fromWarehouseId: warehouseId, toWarehouseId: b.id, items: [{ itemId: item.id, quantity: 1_000 }] },
    userId,
  );
  const transferIn = await tx.stockMovement.findFirstOrThrow({
    where: { referenceType: 'StockTransfer', referenceId: transfer.id, movementType: 'TransferIn' },
  });
  return { item, b, transfer, transferIn };
}

d('stock transfer cancel after the destination used the goods', () => {
  it('rejects when 800 of 1,000 kg left B under the picked TransferIn batch', async () => {
    await inRollback(async (tx) => {
      const { item, b, transfer, transferIn } = await transferToB(tx);
      // Extra stock at B so only the batch rule can block the cancel.
      await tx.inventoryStock.update({
        where: { itemId_warehouseId: { itemId: item.id, warehouseId: b.id } },
        data: { currentStock: { increment: 1_000 } },
      });
      const c = await warehouse(tx);
      const onward = await submitStockTransferInTx(
        tx,
        { date: `${Y}-03-11`, fromWarehouseId: b.id, toWarehouseId: c.id, items: [{ itemId: item.id, quantity: 800, sourceMovementId: transferIn.id }] },
        userId,
      );

      expect(await codeOf(inRouteTx((t) => cancelStockTransferInTx(t, transfer.id)))).toBe(STOCK_TRANSFER_CANCEL_BATCH_USED);
      expect((await tx.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe('Submitted');
      expect(await stockAt(tx, item.id, warehouseId)).toBe(0);
      expect(await stockAt(tx, item.id, b.id)).toBe(1_200);

      // Once the onward transfer is cancelled the batch is free again.
      await inRouteTx((t) => cancelStockTransferInTx(t, onward.id));
      await inRouteTx((t) => cancelStockTransferInTx(t, transfer.id));
      expect(await stockAt(tx, item.id, warehouseId)).toBe(1_000);
      expect(await stockAt(tx, item.id, b.id)).toBe(1_000);
    });
  });

  it('rejects when B shipped 800 kg without a batch, unless forced with inventory.negative_stock', async () => {
    await inRollback(async (tx) => {
      const { item, b, transfer } = await transferToB(tx);
      const customer = await party(tx, 'Customer');
      await submitDeliveryOrderInTx(
        tx,
        { date: `${Y}-03-12`, partyId: customer.id, items: [{ inventoryItemId: item.id, warehouseId: b.id, itemName: item.name, quantity: 800, unit: 'kg' }] },
        userId,
      );
      expect(await stockAt(tx, item.id, b.id)).toBe(200);

      const rejected = await callRoute(stockTransfersRouter, 'patch', '/:id/cancel', { params: { id: transfer.id }, userId, role });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
      expect(rejected.body.code).toBe(STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK);
      expect(await stockAt(tx, item.id, b.id)).toBe(200);
      expect(await stockAt(tx, item.id, warehouseId)).toBe(0);

      // The harness role holds inventory.negative_stock.
      const forced = await callRoute(stockTransfersRouter, 'patch', '/:id/cancel', {
        params: { id: transfer.id },
        body: { allowNegativeStock: true, negativeStockReason: 'Koreksi transfer salah gudang' },
        userId, role,
      });
      expect(forced.status, JSON.stringify(forced.body)).toBe(200);
      expect(forced.body.status).toBe('Cancelled');
      expect(await stockAt(tx, item.id, b.id)).toBe(-800);
      expect(await stockAt(tx, item.id, warehouseId)).toBe(1_000);
    });
  });
});

d('stock transfer cancel run twice at once', () => {
  // Needs committed rows on two connections, so the fixture is created for real and deleted after.
  it('the second cancel waits for the first, then fails; 1,000 kg moves back once', async () => {
    const fy = await createFiscalYear(prisma as unknown as Tx, { year: 2089 });
    const actor = await createCapUser(prisma as unknown as Tx, []);
    const [a, b] = await Promise.all([warehouse(prisma as unknown as Tx), warehouse(prisma as unknown as Tx)]);
    const item = await prisma.inventoryItem.create({
      data: { code: `IT-E1R3-${tag()}`, name: `Uji batal ganda ${tag()}`, unit: 'kg', currentStock: 1_000, averageCost: 9_000, isActive: true },
    });
    // State right after a 1,000 kg transfer A -> B.
    await prisma.inventoryStock.createMany({
      data: [{ itemId: item.id, warehouseId: a.id, currentStock: 0 }, { itemId: item.id, warehouseId: b.id, currentStock: 1_000 }],
    });
    const transfer = await prisma.stockTransfer.create({
      data: {
        transferNumber: `ST-E1R3-${tag()}`, date: new Date('2089-03-10'), fromWarehouseId: a.id, toWarehouseId: b.id,
        status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId, submittedAt: new Date(),
        items: { create: [{ itemId: item.id, quantity: 1_000 }] },
      },
    });
    // Its paired movements: the cancel reverses from the active movements, not from the lines.
    await prisma.stockMovement.createMany({
      data: (['TransferOut', 'TransferIn'] as const).map((movementType) => ({
        movementNumber: `SM-E1R3-${movementType}-${tag()}`, date: new Date('2089-03-10'), itemId: item.id,
        warehouseId: movementType === 'TransferOut' ? a.id : b.id, movementType, quantity: 1_000,
        referenceType: 'StockTransfer', referenceId: transfer.id, fiscalYearId: fy.id, createdById: actor.userId,
      })),
    });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let firstDone!: () => void;
      const firstApplied = new Promise<void>((r) => { firstDone = r; });
      const first = prisma.$transaction(async (t) => {
        await cancelStockTransferInTx(t, transfer.id);
        firstDone();
        await held; // keep the first cancel uncommitted while the second one starts
      }, { timeout: 20000 });
      await firstApplied;

      let settled = false;
      const second = prisma.$transaction((t) => cancelStockTransferInTx(t, transfer.id), { timeout: 20000 })
        .then(() => 'NO_ERROR', (e: unknown) => (e instanceof Error ? e.message : String(e)))
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);

      release();
      await first;
      expect(await second).toBe('Transfer sudah dibatalkan.');

      const stock = await prisma.inventoryStock.findMany({ where: { itemId: item.id } });
      const at = (whId: string) => Number(stock.find((s) => s.warehouseId === whId)?.currentStock ?? NaN);
      expect(at(a.id)).toBe(1_000);
      expect(at(b.id)).toBe(0);
      expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe('Cancelled');
    } finally {
      await prisma.stockMovement.deleteMany({ where: { referenceId: transfer.id } });
      await prisma.stockTransfer.delete({ where: { id: transfer.id } });
      await prisma.inventoryStock.deleteMany({ where: { itemId: item.id } });
      await prisma.inventoryItem.delete({ where: { id: item.id } });
      await prisma.warehouse.deleteMany({ where: { id: { in: [a.id, b.id] } } });
      await prisma.fiscalYear.delete({ where: { id: fy.id } });
      await prisma.user.delete({ where: { id: actor.userId } });
      await prisma.role.delete({ where: { key: actor.role } });
    }
  });
});

d('deposit cancel after a refund', () => {
  it('rejects a customer deposit of 10 jt with 4 jt refunded; 6 jt remains', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const customer = await party(tx, 'Customer');
      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-04-01`, partyId: customer.id, amount: 10_000_000, paymentType: 'CustomerDeposit', accountId: cashAccountId } as any,
        userId,
      );
      const refund = await callRoute(customerDepositsRouter, 'post', '/:id/refund', {
        params: { id: payment.id },
        body: { date: `${Y}-04-05`, cashAmount: 4_000_000, cashAccountId },
        userId, role,
      });
      expect(refund.status, JSON.stringify(refund.body)).toBe(200);

      const cancel = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId, role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(400);
      expect(cancel.body.code).toBe(DEPOSIT_CANCEL_REFUNDED);

      const after = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('Submitted');
      expect(Number(after.refundedAmount)).toBe(4_000_000);
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: customer.id } })).customerDepositBalance)).toBe(6_000_000);
    });
  });

  it('rejects a supplier deposit of 10 jt with 4 jt refunded; 6 jt remains', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const supplier = await party(tx, 'Supplier');
      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-04-01`, partyId: supplier.id, amount: 10_000_000, paymentType: 'VendorDeposit', accountId: cashAccountId } as any,
        userId,
      );
      const refund = await callRoute(vendorDepositsRouter, 'post', '/:id/refund', {
        params: { id: payment.id },
        body: { date: `${Y}-04-05`, cashAmount: 4_000_000, cashAccountId },
        userId, role,
      });
      expect(refund.status, JSON.stringify(refund.body)).toBe(200);

      const cancel = await callRoute(vendorDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId, role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(400);
      expect(cancel.body.code).toBe(DEPOSIT_CANCEL_REFUNDED);

      expect((await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('Submitted');
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: supplier.id } })).depositBalance)).toBe(6_000_000);
    });
  });
});

/**
 * A deposit posted before payment.journalEntryId was set: its journal exists, unlinked, and its
 * ledger rows reference the journal and carry the create narration `<prefix>: <paymentNumber>`.
 */
async function legacyDeposit(
  tx: Tx,
  kind: 'CustomerDeposit' | 'VendorDeposit',
  opts: { entryNumber?: string; narration: string; journalStatus?: 'Submitted' | 'Cancelled' },
) {
  const fy = await createFiscalYear(tx, { year: Y });
  const p = await party(tx, kind === 'CustomerDeposit' ? 'Customer' : 'Supplier');
  const depositAccountId = await systemAccounts.getAccountId(kind === 'CustomerDeposit' ? 'CUSTOMER_DEPOSIT' : 'VENDOR_DEPOSIT');
  const amount = 10_000_000;
  const paymentNumber = `PAY-E1R3-${tag()}`;
  const date = new Date(`${Y}-04-01`);
  const narration = opts.narration.replace('{n}', paymentNumber);
  // Customer: DR cash / CR deposit liability. Supplier: DR deposit asset / CR cash.
  const lines = kind === 'CustomerDeposit'
    ? [{ accountId: cashAccountId, partyId: null, debit: amount, credit: 0 }, { accountId: depositAccountId, partyId: p.id, debit: 0, credit: amount }]
    : [{ accountId: depositAccountId, partyId: p.id, debit: amount, credit: 0 }, { accountId: cashAccountId, partyId: null, debit: 0, credit: amount }];
  const cancelled = opts.journalStatus === 'Cancelled';
  const journal = await tx.journalEntry.create({
    data: {
      entryNumber: opts.entryNumber?.replace('{n}', paymentNumber) ?? `JV-E1R3-${tag()}`,
      date, narration, status: opts.journalStatus ?? 'Submitted', fiscalYearId: fy.id, createdBy: userId, submittedAt: date,
      items: { create: lines.map((l) => ({ ...l, description: narration })) },
    },
  });
  const rows = [];
  for (const l of lines) {
    rows.push(await tx.accountingLedgerEntry.create({
      data: { date, ...l, referenceType: 'JournalEntry', referenceId: journal.id, description: narration, fiscalYearId: fy.id, isCancelled: cancelled },
    }));
  }
  // A cancelled journal already had its balances reversed (voided from the ledger before the guard).
  if (!cancelled) for (const l of lines) await updateAccountBalance(tx, l.accountId, l.debit, l.credit);
  await tx.party.update({
    where: { id: p.id },
    data: kind === 'CustomerDeposit' ? { customerDepositBalance: amount } : { depositBalance: amount },
  });
  const payment = await tx.payment.create({
    data: {
      paymentNumber, date, paymentType: kind, partyId: p.id, accountId: cashAccountId, amount,
      status: 'Submitted', createdBy: userId, fiscalYearId: fy.id, submittedAt: date,
    },
  });
  // Another journal whose narration also holds the number (refund shape) must stay active.
  const otherJournal = await tx.journalEntry.create({
    data: { entryNumber: `JV-E1R3-RF-${tag()}`, date, narration: 'refund', status: 'Submitted', fiscalYearId: fy.id, createdBy: userId, submittedAt: date },
  });
  const otherRow = await tx.accountingLedgerEntry.create({
    data: {
      date, accountId: depositAccountId, partyId: p.id, debit: 0, credit: 0, referenceType: 'JournalEntry', referenceId: otherJournal.id,
      description: `Refund UM ${kind === 'CustomerDeposit' ? 'Pelanggan' : 'Supplier'}: ${paymentNumber}`, fiscalYearId: fy.id,
    },
  });
  return { party: p, payment, journal, rows, otherRow };
}

async function balanceOf(tx: Tx, accountId: string) {
  return Number((await tx.account.findUniqueOrThrow({ where: { id: accountId } })).balance);
}

async function isCancelledRow(tx: Tx, id: string) {
  return (await tx.accountingLedgerEntry.findUniqueOrThrow({ where: { id } })).isCancelled;
}

d('legacy deposit cancel without a journal link', () => {
  it('voids the unlinked journal JV-<number> of a 10 jt customer deposit and only its ledger rows', async () => {
    await inRollback(async (tx) => {
      const depositAccountId = await systemAccounts.getAccountId('CUSTOMER_DEPOSIT');
      const before = { cash: await balanceOf(tx, cashAccountId), deposit: await balanceOf(tx, depositAccountId) };
      const fx = await legacyDeposit(tx, 'CustomerDeposit', { entryNumber: 'JV-{n}', narration: 'Uang Muka Pelanggan: {n}' });
      expect(await balanceOf(tx, depositAccountId)).toBe(before.deposit + 10_000_000);

      const cancel = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: fx.payment.id }, userId, role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: fx.journal.id } })).status).toBe('Cancelled');
      for (const r of fx.rows) expect(await isCancelledRow(tx, r.id)).toBe(true);
      expect(await isCancelledRow(tx, fx.otherRow.id)).toBe(false);
      expect(await balanceOf(tx, cashAccountId)).toBe(before.cash);
      expect(await balanceOf(tx, depositAccountId)).toBe(before.deposit);
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: fx.party.id } })).customerDepositBalance)).toBe(0);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: fx.payment.id } })).status).toBe('Cancelled');
    });
  });

  it('finds a supplier deposit journal by its exact ledger narration when the number differs', async () => {
    await inRollback(async (tx) => {
      const depositAccountId = await systemAccounts.getAccountId('VENDOR_DEPOSIT');
      const before = await balanceOf(tx, depositAccountId);
      const fx = await legacyDeposit(tx, 'VendorDeposit', { narration: 'Uang Muka: {n}' });

      const cancel = await callRoute(vendorDepositsRouter, 'patch', '/:id/cancel', { params: { id: fx.payment.id }, userId, role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: fx.journal.id } })).status).toBe('Cancelled');
      for (const r of fx.rows) expect(await isCancelledRow(tx, r.id)).toBe(true);
      expect(await isCancelledRow(tx, fx.otherRow.id)).toBe(false);
      expect(await balanceOf(tx, depositAccountId)).toBe(before);
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: fx.party.id } })).depositBalance)).toBe(0);
    });
  });

  it('does not reverse balances again when the unlinked journal was already cancelled', async () => {
    await inRollback(async (tx) => {
      const depositAccountId = await systemAccounts.getAccountId('CUSTOMER_DEPOSIT');
      const openingEquityId = await systemAccounts.getAccountId('OPENING_EQUITY');
      const before = { deposit: await balanceOf(tx, depositAccountId), equity: await balanceOf(tx, openingEquityId) };
      const fx = await legacyDeposit(tx, 'CustomerDeposit', { entryNumber: 'JV-{n}', narration: 'Uang Muka Pelanggan: {n}', journalStatus: 'Cancelled' });

      const cancel = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: fx.payment.id }, userId, role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect(await balanceOf(tx, depositAccountId)).toBe(before.deposit);
      expect(await balanceOf(tx, openingEquityId)).toBe(before.equity);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: fx.payment.id } })).status).toBe('Cancelled');
    });
  });
});

d('deposit created by a sales return', () => {
  it('rejects cancelling the 1 jt credit of a sales return; the return still owns it', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const customer = await party(tx, 'Customer');
      const invoice = await submitSalesInvoiceInTx(
        tx,
        { date: `${Y}-06-01`, partyId: customer.id, items: [{ itemName: 'Jasa uji retur', itemType: 'service', quantity: 1, rate: 1_000_000 }] } as any,
        userId,
      );
      // Already paid, so the whole return becomes customer credit.
      await tx.salesInvoice.update({ where: { id: invoice.id }, data: { outstanding: 0 } });
      const line = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      const ret = await submitSalesReturnInTx(
        tx,
        { salesInvoiceId: invoice.id, date: `${Y}-06-10`, items: [{ salesInvoiceItemId: line.id, quantity: 1, restock: false }] } as any,
        userId,
      );
      if (!ret) throw new Error('Return not created.');
      const { customerDepositId } = await tx.salesReturn.findUniqueOrThrow({ where: { id: ret.id } });
      if (!customerDepositId) throw new Error('Return created no credit deposit.');
      const balance = Number((await tx.party.findUniqueOrThrow({ where: { id: customer.id } })).customerDepositBalance);

      const cancel = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: customerDepositId }, userId, role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(400);
      expect(cancel.body.code).toBe(DEPOSIT_CANCEL_SALES_RETURN);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: customerDepositId } })).status).toBe('Submitted');
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: customer.id } })).customerDepositBalance)).toBe(balance);
    });
  });
});

d('delivery note full edit audit snapshot', () => {
  it('keeps the old 10,000 kg lines in audit_trail after an edit to 8,000 kg', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const item = await stockItem(tx, 10_000);
      const customer = await party(tx, 'Customer');
      const lines = (quantity: number) => [{ inventoryItemId: item.id, warehouseId, itemName: item.name, quantity, unit: 'kg' }];
      const doc = await submitDeliveryOrderInTx(tx, { date: `${Y}-05-02`, partyId: customer.id, items: lines(10_000) }, userId);

      // The snapshot registry binds its models at import, so load it while the harness tx is set.
      const { auditTrailMiddleware } = await import('../../middleware/auditTrail');
      const req = { method: 'PUT', originalUrl: `/api/delivery-orders/${doc.id}`, user: { userId, role: 'Admin' }, headers: {}, ip: '127.0.0.1' };
      const res = { statusCode: 200, headersSent: false, locals: {}, setHeader() {}, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { return body; } };
      await auditTrailMiddleware(req as any, res as any, () => undefined);

      const edited = await inRouteTx((t) => editDeliveryOrderInTx(t, doc.id, { date: `${Y}-05-03`, partyId: customer.id, items: lines(8_000) }, userId));
      res.json(edited);

      let log = null;
      for (let i = 0; i < 40 && !log; i++) {
        log = await tx.auditLog.findFirst({ where: { entityType: 'delivery-orders', entityId: doc.id, action: 'UPDATE' } });
        if (!log) await new Promise((r) => setTimeout(r, 25));
      }
      expect(log).not.toBeNull();
      const oldItems = (log!.oldValues as { items: Array<{ quantity: string | number }> }).items;
      expect(oldItems.map((it) => Number(it.quantity))).toEqual([10_000]);
      const newItems = await tx.deliveryOrderItem.findMany({ where: { deliveryOrderId: doc.id } });
      expect(newItems.map((it) => Number(it.quantity))).toEqual([8_000]);
    });
  });
});
