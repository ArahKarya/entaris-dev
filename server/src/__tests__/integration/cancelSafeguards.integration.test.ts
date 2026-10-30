/**
 * Integration test: transfer and deposit cancel safeguards and the delivery note audit snapshot
 * (E1-R3).
 *
 * - A stock transfer cannot be cancelled once the destination used the goods: either an active
 *   movement picked the TransferIn batch, or the destination stock fell below the transferred qty
 *   (only inventory.negative_stock may force the second case).
 * - A customer or supplier deposit with a refund cannot be cancelled; the remainder stays usable.
 * - A legacy deposit without a journal soft-cancels only its own ledger rows (by referenceId).
 * - A full delivery note edit leaves the old lines in audit_trail.oldValues.
 *
 * Route handlers and services run through the route harness, whose `$transaction` is a
 * savepoint; everything runs in a rollback transaction in a far-future year.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
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
import { DEPOSIT_CANCEL_REFUNDED } from '../../services/depositCancelGuard';
import { invalidatePermissionCache } from '../../services/permissionService';
import stockTransfersRouter from '../../routes/stockTransfers';
import customerDepositsRouter from '../../routes/customerDeposits';
import vendorDepositsRouter from '../../routes/vendorDeposits';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;
let warehouseId: string;
let cashAccountId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
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

      const rejected = await callRoute(stockTransfersRouter, 'patch', '/:id/cancel', { params: { id: transfer.id }, userId });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
      expect(rejected.body.code).toBe(STOCK_TRANSFER_CANCEL_INSUFFICIENT_STOCK);
      expect(await stockAt(tx, item.id, b.id)).toBe(200);
      expect(await stockAt(tx, item.id, warehouseId)).toBe(0);

      // The harness user is Admin, which holds inventory.negative_stock.
      const forced = await callRoute(stockTransfersRouter, 'patch', '/:id/cancel', {
        params: { id: transfer.id },
        body: { allowNegativeStock: true, negativeStockReason: 'Koreksi transfer salah gudang' },
        userId,
      });
      expect(forced.status, JSON.stringify(forced.body)).toBe(200);
      expect(forced.body.status).toBe('Cancelled');
      expect(await stockAt(tx, item.id, b.id)).toBe(-800);
      expect(await stockAt(tx, item.id, warehouseId)).toBe(1_000);
    });
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
        userId,
      });
      expect(refund.status, JSON.stringify(refund.body)).toBe(200);

      const cancel = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId });
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
        userId,
      });
      expect(refund.status, JSON.stringify(refund.body)).toBe(200);

      const cancel = await callRoute(vendorDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(400);
      expect(cancel.body.code).toBe(DEPOSIT_CANCEL_REFUNDED);

      expect((await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('Submitted');
      expect(Number((await tx.party.findUniqueOrThrow({ where: { id: supplier.id } })).depositBalance)).toBe(6_000_000);
    });
  });

  it('a legacy deposit without a journal cancels only its own ledger rows', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      const customer = await party(tx, 'Customer');
      await tx.party.update({ where: { id: customer.id }, data: { customerDepositBalance: 5_000_000 } });
      const payment = await tx.payment.create({
        data: {
          paymentNumber: `PAY-E1R3-${tag()}`,
          date: new Date(`${Y}-04-01`),
          paymentType: 'CustomerDeposit',
          partyId: customer.id,
          accountId: cashAccountId,
          amount: 5_000_000,
          status: 'Submitted',
          createdBy: userId,
          fiscalYearId: fy.id,
          submittedAt: new Date(),
        },
      });
      const row = (referenceId: string) => ({
        date: new Date(`${Y}-04-01`), accountId: cashAccountId, debit: 5_000_000, credit: 0,
        referenceType: 'Payment', referenceId, description: `UM lama ${payment.paymentNumber}`, fiscalYearId: fy.id,
      });
      const own = await tx.accountingLedgerEntry.create({ data: row(payment.id) });
      // Another document that only mentions the number in its description.
      const other = await tx.accountingLedgerEntry.create({ data: row('00000000-0000-4000-8000-000000000000') });

      const cancel = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', { params: { id: payment.id }, userId });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect((await tx.accountingLedgerEntry.findUniqueOrThrow({ where: { id: own.id } })).isCancelled).toBe(true);
      expect((await tx.accountingLedgerEntry.findUniqueOrThrow({ where: { id: other.id } })).isCancelled).toBe(false);
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
      const res = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { return body; } };
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
