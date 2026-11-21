import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { systemAccounts } from '../../services/systemAccounts';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { createFiscalYear } from './periodFixture';

type Tx = Prisma.TransactionClient;

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

export interface SalesFlowWorld {
  year: number;
  fyId: string;
  userId: string;
  warehouseA: { id: string };
  warehouseB: { id: string };
  customer: { id: string };
  supplier: { id: string };
  /** Leaf accounts: the item's inventory account, COGS (mapped to the role inside the tx), and a
   *  counter account for the journals a test writes by hand (a stand-in for Hutang Belum Ditagih). */
  accounts: { inventory: { id: string }; cogs: { id: string }; receiptOffset: { id: string } };
  item: { id: string; name: string };
}

async function leaf(tx: Tx, label: string, type: 'ASSET' | 'EXPENSE' | 'LIABILITY') {
  return tx.account.create({
    data: { name: `IT-SF ${label}`, accountNumber: `IT-SF-${label}-${tag()}`, accountType: type, rootType: type },
  });
}

/**
 * Self-contained sales-flow fixture, built inside a rollback transaction: a fiscal year, two
 * warehouses, a customer, a Supplier, an item on its own leaf inventory account, and a leaf COGS account mapped
 * to the COGS role (a database may map COGS to a group account, which posting refuses). Invalidate
 * the system-account cache again once the transaction has rolled back.
 */
export async function createSalesFlowWorld(tx: Tx, year: number): Promise<SalesFlowWorld> {
  const fy = await createFiscalYear(tx, { year });
  const user = await tx.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' } });
  const t = tag();
  const [inventory, cogs, receiptOffset] = [await leaf(tx, 'INV', 'ASSET'), await leaf(tx, 'COGS', 'EXPENSE'), await leaf(tx, 'GRNI', 'LIABILITY')];
  await tx.systemAccountMapping.deleteMany({ where: { role: 'COGS' } });
  await tx.systemAccountMapping.create({ data: { role: 'COGS', accountId: cogs.id } });
  systemAccounts.invalidateCache();
  const warehouseA = await tx.warehouse.create({ data: { code: `SF-A-${t}`, name: `SF A ${t}` } });
  const warehouseB = await tx.warehouse.create({ data: { code: `SF-B-${t}`, name: `SF B ${t}` } });
  const customer = await tx.party.create({ data: { name: `IT-SF Customer ${t}`, partyType: 'Customer', isActive: true } });
  const supplier = await tx.party.create({ data: { name: `IT-SF Supplier ${t}`, partyType: 'Supplier', isActive: true } });
  const item = await tx.inventoryItem.create({
    data: { code: `SF-${t}`, name: `Beras SF ${t}`, unit: 'kg', isActive: true, accountId: inventory.id },
  });
  return {
    year, fyId: fy.id, userId: user.id, warehouseA, warehouseB, customer, supplier,
    accounts: { inventory, cogs, receiptOffset }, item: { id: item.id, name: item.name },
  };
}

/**
 * Goods received through the real STT service (submitGoodsReceiptInTx, value ledger since PR-6.4c1):
 * `qty` at `avg` into the warehouse, an In row with value_delta = round(qty x avg, 2) and the STT
 * journal of the same amount, DR the item's inventory account / CR Hutang Belum Tagih.
 */
export async function receiveStock(
  tx: Tx,
  w: SalesFlowWorld,
  input: { warehouseId: string; qty: Decimal.Value; avg: Decimal.Value; day: string },
): Promise<{ movementId: string; value: Decimal; goodsReceiptId: string }> {
  const stt = await submitGoodsReceiptInTx(tx, {
    date: input.day,
    partyId: w.supplier.id,
    items: [{
      inventoryItemId: w.item.id, warehouseId: input.warehouseId, itemName: w.item.name,
      quantity: Number(input.qty), unit: 'kg', lockedUnitCost: Number(input.avg),
    }],
  }, w.userId);
  const line = await tx.goodsReceiptItem.findFirstOrThrow({ where: { goodsReceiptId: stt.id }, include: { stockMovement: true } });
  return { movementId: line.stockMovementId!, value: new Decimal(line.stockMovement!.valueDelta.toString()), goodsReceiptId: stt.id };
}

/** A delivery order of the world's item through the real service, one line per quantity. */
export function deliver(tx: Tx, w: SalesFlowWorld, day: string, lines: { qty: number; warehouseId?: string }[]) {
  return submitDeliveryOrderInTx(tx, {
    date: day,
    partyId: w.customer.id,
    items: lines.map((l) => ({
      inventoryItemId: w.item.id, warehouseId: l.warehouseId ?? w.warehouseA.id, itemName: w.item.name, quantity: l.qty, unit: 'kg',
    })),
  }, w.userId);
}

/**
 * An invoice that bills every line of the delivery order through the real service; `qty` overrides
 * the billed quantity of every line (an invoice quantity that differs from the note).
 */
export function invoiceDelivery(
  tx: Tx,
  w: SalesFlowWorld,
  day: string,
  doc: { items: { id: string; quantity: Prisma.Decimal | number }[] },
  opts: { rate: number; qty?: number },
) {
  return submitSalesInvoiceInTx(tx, {
    date: day,
    partyId: w.customer.id,
    items: doc.items.map((line) => ({
      itemName: w.item.name, itemType: 'product' as const, inventoryItemId: w.item.id, deliveryOrderItemId: line.id,
      quantity: opts.qty ?? Number(line.quantity), unit: 'kg', rate: opts.rate,
    })),
  }, w.userId);
}

/** Σ debit − credit of the account's live ledger entries (the GL balance of an ASSET or EXPENSE account). */
export async function glBalance(tx: Tx, accountId: string): Promise<Decimal> {
  const sum = await tx.accountingLedgerEntry.aggregate({ where: { accountId, isCancelled: false }, _sum: { debit: true, credit: true } });
  return new Decimal(sum._sum.debit?.toString() ?? 0).minus(sum._sum.credit?.toString() ?? 0);
}

/** The item's stored book: stock, stock_value and average as fixed strings. */
export async function bookOf(tx: Tx, itemId: string) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  return { stock: item.currentStock.toFixed(3), value: item.stockValue.toFixed(2), average: item.averageCost.toFixed(6) };
}
