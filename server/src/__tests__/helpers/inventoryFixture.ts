import Decimal from 'decimal.js';
import { averageAfter } from '../../services/inventory/inventoryValueMath';
import type { Tx } from './routeHarness';

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Adds `qty` and `value` to the item total and stock_value; the average is re-derived (averageAfter). */
async function addItemStock(db: Tx, itemId: string, qty: Decimal, value: Decimal): Promise<void> {
  const item = await db.inventoryItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { currentStock: true, averageCost: true, stockValue: true },
  });
  const stock = new Decimal(item.currentStock.toString()).plus(qty);
  const stockValue = new Decimal(item.stockValue.toString()).plus(value);
  await db.inventoryItem.update({
    where: { id: itemId },
    data: {
      currentStock: stock.toString(),
      stockValue: stockValue.toString(),
      averageCost: averageAfter(stock, stockValue, item.averageCost.toString()).toString(),
    },
  });
}

export interface SeedStockInput {
  itemId: string;
  warehouseId: string;
  qty: Decimal.Value;
  /** Unit cost of the seeded stock; the item's average becomes stock_value / stock afterwards. */
  avg: Decimal.Value;
  /** Movement date: a business day (YYYY-MM-DD) or a Date; must fall in an existing fiscal year. */
  date: string | Date;
  /** Defaults to the fiscal year that contains `date`. */
  fiscalYearId?: string;
  /** Defaults to the first active Admin. */
  userId?: string;
}

/**
 * Puts `qty` at `avg` into one warehouse the way an inbound posting of the value ledger does: the
 * warehouse row, the item total, stock_value (+ round(qty x avg, 2)) and the average derived from
 * it, and a valued `In` movement whose value_delta is that amount (so a replay explains the stock
 * and assertLedgerInvariant holds), consistently. No journal is written, so the fixture adds no
 * ledger entries.
 * Works on a rollback transaction and, for race tests, on a real client (the rows are committed;
 * the test deletes them). Integration tests use this instead of writing `currentStock` /
 * `averageCost` directly.
 */
export async function seedStock(db: Tx, input: SeedStockInput): Promise<{ movementId: string }> {
  const qty = new Decimal(input.qty);
  const avg = new Decimal(input.avg);
  const day = typeof input.date === 'string' ? new Date(`${input.date}T00:00:00.000Z`) : input.date;
  const fiscalYearId = input.fiscalYearId
    ?? (await db.fiscalYear.findFirstOrThrow({ where: { startDate: { lte: day }, endDate: { gte: day } } })).id;
  const userId = input.userId
    ?? (await db.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true } })).id;

  const value = qty.times(avg).toDecimalPlaces(2);
  await addItemStock(db, input.itemId, qty, value);
  await db.inventoryStock.upsert({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    create: { itemId: input.itemId, warehouseId: input.warehouseId, currentStock: qty.toNumber() },
    update: { currentStock: { increment: qty.toNumber() } },
  });
  const movement = await db.stockMovement.create({
    data: {
      movementNumber: `IT-SEED-${tag()}`,
      date: day,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      movementType: 'In',
      quantity: qty.toNumber(),
      unitCost: avg.toNumber(),
      totalValue: value.abs().toNumber(),
      valueDelta: value.toNumber(),
      notes: 'Fixture stok uji',
      fiscalYearId,
      createdById: userId,
    },
  });
  return { movementId: movement.id };
}

/**
 * Item vs warehouse drift the way legacy paths left it (PR-6.3d): `qty` at `avg` on the item total
 * and average with a valued `In` movement that has no warehouse, and no warehouse row. The item
 * then holds stock that no warehouse holds. No journal is written.
 */
export async function seedUnplacedStock(db: Tx, input: Omit<SeedStockInput, 'warehouseId'>): Promise<{ movementId: string }> {
  const qty = new Decimal(input.qty);
  const avg = new Decimal(input.avg);
  const day = typeof input.date === 'string' ? new Date(`${input.date}T00:00:00.000Z`) : input.date;
  const fiscalYearId = input.fiscalYearId
    ?? (await db.fiscalYear.findFirstOrThrow({ where: { startDate: { lte: day }, endDate: { gte: day } } })).id;
  const userId = input.userId
    ?? (await db.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true } })).id;
  const value = qty.times(avg).toDecimalPlaces(2);
  await addItemStock(db, input.itemId, qty, value);
  const movement = await db.stockMovement.create({
    data: {
      movementNumber: `IT-LOOSE-${tag()}`, date: day, itemId: input.itemId, warehouseId: null, movementType: 'In',
      quantity: qty.toNumber(), unitCost: avg.toNumber(), totalValue: value.abs().toNumber(), valueDelta: value.toNumber(),
      notes: 'Fixture stok tanpa gudang', fiscalYearId, createdById: userId,
    },
  });
  return { movementId: movement.id };
}
