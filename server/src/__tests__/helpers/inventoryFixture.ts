import Decimal from 'decimal.js';
import type { Tx } from './routeHarness';

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export interface SeedStockInput {
  itemId: string;
  warehouseId: string;
  qty: Decimal.Value;
  /** Unit cost of the seeded stock; the item's average becomes the blend of its stock and this. */
  avg: Decimal.Value;
  fiscalYearId: string;
  userId: string;
  /** Movement date, inside the fiscal year. */
  date: Date;
}

/**
 * Puts `qty` at `avg` into one warehouse the way an inbound posting does: the warehouse row, the
 * item total and average, and a valued `In` movement (so a replay of the item's movements explains
 * the stock), consistently. No journal (fixtures write only balanced ledger rows, and none here).
 * Works on a rollback transaction and, for race tests, on a real client (the rows are committed;
 * the test deletes them).
 */
export async function seedStock(db: Tx, input: SeedStockInput): Promise<void> {
  const qty = new Decimal(input.qty);
  const avg = new Decimal(input.avg);
  const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: input.itemId }, select: { currentStock: true, averageCost: true } });
  const before = new Decimal(item.currentStock.toString());
  const blended = before.lte(0)
    ? avg
    : before.times(item.averageCost.toString()).plus(qty.times(avg)).div(before.plus(qty));
  await db.inventoryItem.update({
    where: { id: input.itemId },
    data: { currentStock: { increment: qty.toNumber() }, averageCost: blended.toDecimalPlaces(2).toNumber() },
  });
  await db.inventoryStock.upsert({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    create: { itemId: input.itemId, warehouseId: input.warehouseId, currentStock: qty.toNumber() },
    update: { currentStock: { increment: qty.toNumber() } },
  });
  await db.stockMovement.create({
    data: {
      movementNumber: `IT-SEED-${tag()}`,
      date: input.date,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      movementType: 'In',
      quantity: qty.toNumber(),
      unitCost: avg.toNumber(),
      totalValue: qty.times(avg).toDecimalPlaces(2).toNumber(),
      notes: 'Fixture stok uji',
      fiscalYearId: input.fiscalYearId,
      createdById: input.userId,
    },
  });
}
