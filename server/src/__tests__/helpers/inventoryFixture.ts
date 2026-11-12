import Decimal from 'decimal.js';
import type { Tx } from './routeHarness';

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export interface SeedStockInput {
  itemId: string;
  warehouseId: string;
  qty: Decimal.Value;
  /** Unit cost of the seeded stock; the item's average becomes the blend of its stock and this. */
  avg: Decimal.Value;
  /** Movement date: a business day (YYYY-MM-DD) or a Date; must fall in an existing fiscal year. */
  date: string | Date;
  /** Defaults to the fiscal year that contains `date`. */
  fiscalYearId?: string;
  /** Defaults to the first active Admin. */
  userId?: string;
}

/**
 * Puts `qty` at `avg` into one warehouse the way an inbound posting does: the warehouse row, the
 * item total and average, and a valued `In` movement (so a replay of the item's movements explains
 * the stock), consistently. No journal is written, so the fixture adds no ledger entries.
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

  const item = await db.inventoryItem.findUniqueOrThrow({
    where: { id: input.itemId },
    select: { currentStock: true, averageCost: true },
  });
  const before = new Decimal(item.currentStock.toString());
  const current = new Decimal(item.averageCost.toString());
  let blended = current;
  if (qty.gt(0) && avg.gt(0)) {
    blended = before.lte(0) ? avg : before.times(current).plus(qty.times(avg)).div(before.plus(qty));
  }
  await db.inventoryItem.update({
    where: { id: input.itemId },
    data: { currentStock: { increment: qty.toNumber() }, averageCost: blended.toDecimalPlaces(2).toNumber() },
  });
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
      totalValue: qty.times(avg).toDecimalPlaces(2).toNumber(),
      notes: 'Fixture stok uji',
      fiscalYearId,
      createdById: userId,
    },
  });
  return { movementId: movement.id };
}
