/**
 * Integration test: the inbound stock paths on the value ledger (E3-R6, E3-R7, PR-6.4c1), on
 * fixtures made here inside a rollback transaction (helpers/salesFlowFixture.ts):
 * - STT submit books each line at quantity x its cost, the STT journal debits the same amount;
 *   cancelling an STT takes back exactly the inventory debit of its journal, and GL = stock_value;
 * - a legacy STT whose total_value a purchase invoice overwrote (value_delta = the locked cost, as
 *   the value-ledger backfill sets it): cancelling it takes back the locked cost, not total_value;
 * - an STT whose goods partly went out since: the value true-up (PR-6.5a) re-values what went out,
 *   one journal against COGS on the day of the cancel;
 * - customer-owned goods (owner decision #5): refused into an item that holds own goods, accepted at
 *   value 0 into an item that holds none; own goods refused into an item that holds customer goods;
 * - opening stock import: the journal debit and the ledger value are the same 2 dp amount;
 * - manual movements: In at the body cost, Out valued from the book, an edit cancels the row and
 *   posts a new one, a cancel takes the row back exactly; an inbound edited or cancelled after goods
 *   went out is taken back with the value true-up against COGS (PR-6.5b); an In picked as a
 *   transfer's batch cannot be edited or cancelled;
 * - the demo wipe resets stock, stock_value and average together.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2110.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import { bookOf, createSalesFlowWorld, deliver, glBalance, receiveStock, type SalesFlowWorld } from '../helpers/salesFlowFixture';
import { sourceKeys } from '../../services/ledger/journalSource';
import { systemAccounts } from '../../services/systemAccounts';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({ tx: null as Tx | null, today: null as string | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
// "Today" of a cancel's value true-up journal (owner decision #3): the fixture year when set.
vi.mock('../../utils/businessDate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/businessDate')>();
  return { ...actual, businessToday: (...args: Parameters<typeof actual.businessToday>) => state.today ?? actual.businessToday(...args) };
});

import { prisma as appPrisma } from '../../lib/prisma';
import { GR_CUSTOMER_OWNED_OWN_STOCK, submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';
import { postOpeningStockInTx } from '../../services/openingStockImport';
import {
  cancelManualMovementInTx, createManualMovementInTx, editManualMovementInTx,
} from '../../services/inventory/manualMovement';
import { resetDerivedBalances } from '../../services/demoData/wipe';
import { submitStockTransferInTx } from '../../services/stockTransfer';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2110;
const DAY = `${YEAR}-05-11`;

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

async function inWorld(fn: (tx: Tx, w: SalesFlowWorld) => Promise<string[] | void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        const w = await createSalesFlowWorld(tx, YEAR);
        const more = await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id, ...(more ?? [])], { warehouses: true });
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

/** The inventory debit of the STT journal JV-<sttNumber> on the world's item account. */
async function sttInventoryDebit(tx: Tx, w: SalesFlowWorld, goodsReceiptId: string): Promise<string> {
  const stt = await tx.goodsReceipt.findUniqueOrThrow({ where: { id: goodsReceiptId } });
  const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${stt.sttNumber}` }, include: { items: true } });
  return money(je.items.find((i) => i.accountId === w.accounts.inventory.id)!.debit.toString());
}

/** An expense leaf the manual movements post against (STOCK_OFFSET_RULE accepts it). */
function offsetAccount(tx: Tx) {
  const code = `IT-IB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return tx.account.create({ data: { name: `Beban uji ${code}`, accountNumber: code, accountType: 'EXPENSE', rootType: 'EXPENSE' } });
}

d('goods receipt (STT) on the value ledger', () => {
  it('cancel takes back exactly the inventory debit of the STT journal; GL = stock_value', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      // 500 x 12.345,678 = 6.172.839,00 on top of 12.000.000,00.
      const second = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 500, avg: 12_345.678, day: DAY });
      expect(money(second.value)).toBe('6172839.00');
      expect(await sttInventoryDebit(tx, w, second.goodsReceiptId)).toBe('6172839.00');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1500.000', value: '18172839.00', average: '12115.226000' });

      await inRouteTx((t) => cancelGoodsReceiptInTx(t, second.goodsReceiptId, w.userId));
      const row = await tx.stockMovement.findUniqueOrThrow({ where: { id: second.movementId } });
      expect(row.isCancelled).toBe(true);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1000.000', value: '12000000.00', average: '12000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('12000000.00');
      expect(await tx.inventoryStock.findUniqueOrThrow({
        where: { itemId_warehouseId: { itemId: w.item.id, warehouseId: w.warehouseA.id } },
      }).then((s) => s.currentStock.toFixed(3))).toBe('1000.000');
    });
  });

  it('a legacy STT whose total_value a purchase invoice overwrote is cancelled at its locked cost', async () => {
    await inWorld(async (tx, w) => {
      const base = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 200, avg: 9_000, day: DAY });
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      // The old landed-cost code rewrote the STT row's unit_cost / total_value (10.500 / 1.050.000);
      // the value-ledger backfill keeps value_delta at the locked cost (1.000.000), and the invoice
      // was cancelled, so no Revaluation row carries the delta.
      await tx.stockMovement.update({ where: { id: stt.movementId }, data: { unitCost: 10_500, totalValue: 1_050_000 } });
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '300.000', value: '2800000.00', average: '9333.333333' });

      await inRouteTx((t) => cancelGoodsReceiptInTx(t, stt.goodsReceiptId, w.userId));
      expect(await sttInventoryDebit(tx, w, stt.goodsReceiptId)).toBe('1000000.00');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '200.000', value: '1800000.00', average: '9000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('1800000.00');
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: base.movementId } })).isCancelled).toBe(false);
    });
  });

  it('cancel after goods of the item went out: the value true-up re-values what went out against COGS', async () => {
    await inWorld(async (tx, w) => {
      state.today = DAY;
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const stt = await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 10_000, day: DAY });
      await deliver(tx, w, DAY, [{ qty: 100 }]);
      const before = await bookOf(tx, w.item.id);
      expect(before).toEqual({ stock: '1900.000', value: '20900000.00', average: '11000.000000' });

      try {
        await inRouteTx((t) => cancelGoodsReceiptInTx(t, stt.goodsReceiptId, w.userId));
      } finally {
        state.today = null;
      }
      // Without the 10.000 receipt the 100 went out at 12.000: 100.000 more COGS, CR inventory.
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '900.000', value: '10800000.00', average: '12000.000000' });
      const trueUp = await tx.journalEntry.findFirstOrThrow({ where: { sourceKey: sourceKeys.inventoryTrueUp(stt.movementId) }, include: { items: true } });
      expect(trueUp.date.toISOString().slice(0, 10)).toBe(DAY);
      expect(trueUp.items.find((i) => i.accountId === w.accounts.inventory.id)?.credit.toFixed(2)).toBe('100000.00');
      expect(trueUp.items.find((i) => i.accountId === w.accounts.cogs.id)?.debit.toFixed(2)).toBe('100000.00');
      // The delivery note is not invoiced: GL = book + its 1.100.000.
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('11900000.00');
      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.goodsReceiptId } })).status).toBe('Cancelled');
    });
  });

  it('customer-owned goods are refused into an item that holds own goods (decision #5)', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 12_000, day: DAY });
      const titipan = (itemId: string, itemName: string) => inRouteTx((t) => submitGoodsReceiptInTx(t, {
        date: DAY, partyId: w.supplier.id, isCustomerOwned: true,
        items: [{ inventoryItemId: itemId, warehouseId: w.warehouseA.id, itemName, quantity: 500, unit: 'kg' }],
      }, w.userId));
      expect(await codeOf(titipan(w.item.id, w.item.name))).toBe(GR_CUSTOMER_OWNED_OWN_STOCK);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '1000.000', value: '12000000.00', average: '12000.000000' });

      // A separate item that holds no own goods takes them at value 0, twice, and gives them back on cancel.
      const consigned = await tx.inventoryItem.create({
        data: { code: `IT-IB-TTP-${Date.now()}`, name: 'Gabah titipan', unit: 'kg', isActive: true, accountId: w.accounts.inventory.id },
      });
      const first = await titipan(consigned.id, consigned.name);
      await titipan(consigned.id, consigned.name);
      expect(await bookOf(tx, consigned.id)).toEqual({ stock: '1000.000', value: '0.00', average: '0.000000' });
      expect(await tx.journalEntry.count({ where: { entryNumber: `JV-${first.sttNumber}` } })).toBe(0);
      await inRouteTx((t) => cancelGoodsReceiptInTx(t, first.id, w.userId));
      expect(await bookOf(tx, consigned.id)).toEqual({ stock: '500.000', value: '0.00', average: '0.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('12000000.00');
      return [consigned.id];
    });
  });

  it('own goods are refused into an item that holds customer-owned goods (decision #5, reverse)', async () => {
    await inWorld(async (tx, w) => {
      const consigned = await tx.inventoryItem.create({
        data: { code: `IT-IB-TTP2-${Date.now()}`, name: 'Gabah titipan 2', unit: 'kg', isActive: true, accountId: w.accounts.inventory.id },
      });
      const line = (isCustomerOwned: boolean) => inRouteTx((t) => submitGoodsReceiptInTx(t, {
        date: DAY, partyId: w.supplier.id, isCustomerOwned,
        items: [{
          inventoryItemId: consigned.id, warehouseId: w.warehouseA.id, itemName: consigned.name, quantity: 1_000, unit: 'kg',
          lockedUnitCost: isCustomerOwned ? undefined : 10_000,
        }],
      }, w.userId));
      const customer = await line(true);
      expect(await codeOf(line(false))).toBe(GR_CUSTOMER_OWNED_OWN_STOCK);
      expect(await bookOf(tx, consigned.id)).toEqual({ stock: '1000.000', value: '0.00', average: '0.000000' });

      // Once the customer goods are gone (the STT cancelled here), own goods come in again.
      await inRouteTx((t) => cancelGoodsReceiptInTx(t, customer.id, w.userId));
      await line(false);
      expect(await bookOf(tx, consigned.id)).toEqual({ stock: '1000.000', value: '10000000.00', average: '10000.000000' });
      return [consigned.id];
    });
  });
});

d('opening stock import on the value ledger', () => {
  it('the journal debit and the ledger value are the same 2 dp amount', async () => {
    await inWorld(async (tx, w) => {
      // 3 x 3.333,3333 = 9.999,9999: booked 10.000,00 on both sides, unit cost 3.333,333333.
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: w.warehouseA.id } });
      const { movementId, journalEntryId } = await inRouteTx((t) => postOpeningStockInTx(t, {
        item: { id: w.item.id, code: 'IT-IB' }, quantity: 3, unitCost: 3_333.3333, totalValue: 9_999.9999,
        warehouseCode: warehouse.code, userId: w.userId, now: new Date(`${DAY}T03:00:00.000Z`),
      }));
      const row = await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } });
      expect([money(row.valueDelta.toString()), row.unitCost.toFixed(6), row.referenceType, row.journalEntryId])
        .toEqual(['10000.00', '3333.333333', 'OpeningBalance', journalEntryId]);
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('10000.00');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '3.000', value: '10000.00', average: '3333.333333' });
    });
  });
});

d('manual movements on the value ledger', () => {
  /** 10.000 kg @6.000 through an STT, and a Stock In of 1.000 @12.000: 72.000.000,00 on 11.000 kg. */
  async function stocked(tx: Tx, w: SalesFlowWorld) {
    await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 10_000, avg: 6_000, day: DAY });
    const offset = await offsetAccount(tx);
    const inbound = await inRouteTx((t) => createManualMovementInTx(t, {
      itemId: w.item.id, warehouseId: w.warehouseA.id, movementType: 'In', quantity: 1_000, unitCost: 12_000,
      date: DAY, offsetAccountId: offset.id,
    }, w.userId));
    expect(await bookOf(tx, w.item.id)).toEqual({ stock: '11000.000', value: '72000000.00', average: '6545.454545' });
    return { offset, inbound };
  }

  it('an Out is valued from the book, whatever cost the client sends; the journal carries the same amount', async () => {
    await inWorld(async (tx, w) => {
      const { offset } = await stocked(tx, w);
      const out = await inRouteTx((t) => createManualMovementInTx(t, {
        itemId: w.item.id, warehouseId: w.warehouseA.id, movementType: 'Out', quantity: 1_000, unitCost: 5_000,
        date: DAY, offsetAccountId: offset.id,
      }, w.userId));
      // round(72.000.000 x 1.000 / 11.000, 2) = 6.545.454,55.
      expect([money(out.valueDelta.toString()), money(out.totalValue.toString()), out.unitCost.toFixed(6)])
        .toEqual(['-6545454.55', '6545454.55', '6545.454550']);
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: out.journalEntryId! }, include: { items: true } });
      expect(je.items.map((i) => [i.accountId, money(i.debit.toString()), money(i.credit.toString())]).sort()).toEqual([
        [offset.id, '6545454.55', '0.00'],
        [w.accounts.inventory.id, '0.00', '6545454.55'],
      ].sort());
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '10000.000', value: '65454545.45', average: '6545.454545' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('65454545.45');
    });
  });

  it('an edit cancels the row and posts a new one valued from the book after the reversal', async () => {
    await inWorld(async (tx, w) => {
      const { offset } = await stocked(tx, w);
      const out = await inRouteTx((t) => createManualMovementInTx(t, {
        itemId: w.item.id, warehouseId: w.warehouseA.id, movementType: 'Out', quantity: 1_000, date: DAY, offsetAccountId: offset.id,
      }, w.userId));
      const edited = await inRouteTx((t) => editManualMovementInTx(t, out.id, {
        movementType: 'Out', quantity: 400, unitCost: 1, date: DAY, offsetAccountId: offset.id,
      }, w.userId));
      expect(edited.id).not.toBe(out.id);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: out.id } })).isCancelled).toBe(true);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: out.journalEntryId! } })).status).toBe('Cancelled');
      // Back to 72.000.000 on 11.000 kg, then round(72.000.000 x 400 / 11.000, 2) = 2.618.181,82.
      expect(money(edited.valueDelta.toString())).toBe('-2618181.82');
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '10600.000', value: '69381818.18', average: '6545.454545' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('69381818.18');
    });
  });

  it('an In edited before anything went out takes its own value back; cancel restores the receipt', async () => {
    await inWorld(async (tx, w) => {
      const { offset, inbound } = await stocked(tx, w);
      const edited = await inRouteTx((t) => editManualMovementInTx(t, inbound.id, {
        movementType: 'AdjustmentIn', quantity: 1_000, unitCost: 9_000, date: DAY, offsetAccountId: offset.id,
      }, w.userId));
      // (60.000.000 + 9.000.000) / 11.000 = 6.272,727273.
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '11000.000', value: '69000000.00', average: '6272.727273' });
      await inRouteTx((t) => cancelManualMovementInTx(t, edited.id, w.userId));
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '10000.000', value: '60000000.00', average: '6000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('60000000.00');
    });
  });

  /** stocked() plus 100 kg out at round(72.000.000 x 100 / 11.000, 2) = 654.545,45, against the offset account. */
  async function soldAfterInbound(tx: Tx, w: SalesFlowWorld) {
    const stock = await stocked(tx, w);
    await inRouteTx((t) => createManualMovementInTx(t, {
      itemId: w.item.id, warehouseId: w.warehouseA.id, movementType: 'Out', quantity: 100, date: DAY, offsetAccountId: stock.offset.id,
    }, w.userId));
    expect(await bookOf(tx, w.item.id)).toEqual({ stock: '10900.000', value: '71345454.55', average: '6545.454546' });
    return stock;
  }

  /** The true-up journal of taking `movementId` back: [inventory debit, COGS credit]. */
  async function trueUpLines(tx: Tx, w: SalesFlowWorld, movementId: string) {
    const je = await tx.journalEntry.findFirstOrThrow({ where: { sourceKey: sourceKeys.inventoryTrueUp(movementId) }, include: { items: true } });
    expect(je.date.toISOString().slice(0, 10)).toBe(DAY);
    return [
      je.items.find((i) => i.accountId === w.accounts.inventory.id)?.debit.toFixed(2),
      je.items.find((i) => i.accountId === w.accounts.cogs.id)?.credit.toFixed(2),
    ];
  }

  // Without the 12.000 inbound the 100 kg went out at 6.000 (600.000), with it at 654.545,45: the
  // 54.545,45 they took of it comes back to the book against COGS (E3-R8, PR-6.5b).
  it('an In edited after goods went out is taken back with the value true-up, then posted anew', async () => {
    await inWorld(async (tx, w) => {
      const { offset, inbound } = await soldAfterInbound(tx, w);
      state.today = DAY;
      try {
        const edited = await inRouteTx((t) => editManualMovementInTx(t, inbound.id, {
          movementType: 'In', quantity: 1_000, unitCost: 9_000, date: DAY, offsetAccountId: offset.id,
        }, w.userId));
        expect(money(edited.valueDelta.toString())).toBe('9000000.00');
      } finally {
        state.today = null;
      }
      expect(await trueUpLines(tx, w, inbound.id)).toEqual(['54545.45', '54545.45']);
      // 71.345.454,55 − 12.000.000 + 54.545,45 = 59.400.000 on 9.900 kg, then + 9.000.000 on 1.000 kg.
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '10900.000', value: '68400000.00', average: '6275.229358' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('68400000.00');
      expect(money(await glBalance(tx, w.accounts.cogs.id))).toBe('-54545.45');
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: inbound.id } })).isCancelled).toBe(true);
    });
  });

  it('an In cancelled after goods went out is taken back with the value true-up', async () => {
    await inWorld(async (tx, w) => {
      const { inbound } = await soldAfterInbound(tx, w);
      state.today = DAY;
      try {
        await inRouteTx((t) => cancelManualMovementInTx(t, inbound.id, w.userId));
      } finally {
        state.today = null;
      }
      expect(await trueUpLines(tx, w, inbound.id)).toEqual(['54545.45', '54545.45']);
      expect(await bookOf(tx, w.item.id)).toEqual({ stock: '9900.000', value: '59400000.00', average: '6000.000000' });
      expect(money(await glBalance(tx, w.accounts.inventory.id))).toBe('59400000.00');
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: inbound.id } })).isCancelled).toBe(true);
    });
  });

  it('an In picked as the batch of a transfer cannot be edited or cancelled', async () => {
    await inWorld(async (tx, w) => {
      const { offset, inbound } = await stocked(tx, w);
      await inRouteTx((t) => submitStockTransferInTx(t, {
        date: DAY, fromWarehouseId: w.warehouseA.id, toWarehouseId: w.warehouseB.id,
        items: [{ itemId: w.item.id, quantity: 500, sourceMovementId: inbound.id }],
      }, w.userId));
      const before = await bookOf(tx, w.item.id);
      const refused = async (p: Promise<unknown>) => {
        await expect(p).rejects.toThrow(/sudah dipakai di transaksi lain/);
      };
      await refused(inRouteTx((t) => editManualMovementInTx(t, inbound.id, {
        movementType: 'In', quantity: 1_000, unitCost: 9_000, date: DAY, offsetAccountId: offset.id,
      }, w.userId)));
      await refused(inRouteTx((t) => cancelManualMovementInTx(t, inbound.id, w.userId)));
      expect(await bookOf(tx, w.item.id)).toEqual(before);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: inbound.id } })).isCancelled).toBe(false);
    });
  });
});

d('demo wipe', () => {
  it('resets stock, stock_value and average together', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      await resetDerivedBalances(tx);
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: w.item.id } });
      expect([item.currentStock.toFixed(3), item.stockValue.toFixed(2), item.averageCost.toFixed(6)]).toEqual(['0.000', '0.00', '0.000000']);
      // The wipe truncates the movements and warehouse rows themselves; this test keeps them, so it
      // cancels them here to leave a whole book for the closing invariant check.
      await tx.stockMovement.updateMany({ where: { itemId: w.item.id }, data: { isCancelled: true } });
      await tx.inventoryStock.updateMany({ where: { itemId: w.item.id }, data: { currentStock: 0 } });
    });
  });
});
