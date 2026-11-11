import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { calcWeightedAverage } from '../../utils/weightedAverage';

type Tx = Prisma.TransactionClient;

export interface SeedStockInput {
  itemId: string;
  warehouseId: string;
  qty: number;
  /** Unit cost of the seeded stock; blended into the item's weighted average. */
  avg: number;
  /** Business day (YYYY-MM-DD) of the opening movement; must fall in an existing fiscal year. */
  date: string;
  /** Defaults to the first active Admin. */
  userId?: string;
}

/**
 * Plants stock the way the rest of the system expects to find it: the item total, the
 * (item, warehouse) row and a valued `In` movement agree, so a weighted-average replay does not
 * skip the item (averageCostRecompute.ts reads the movements). No journal is written, so the
 * fixture adds no ledger entries. Integration tests use this instead of writing
 * `currentStock` / `averageCost` directly.
 */
export async function seedStock(tx: Tx, input: SeedStockInput): Promise<{ movementId: string }> {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: input.itemId } });
  const day = new Date(`${input.date}T00:00:00.000Z`);
  const fiscalYear = await tx.fiscalYear.findFirstOrThrow({
    where: { startDate: { lte: day }, endDate: { gte: day } },
  });
  const userId = input.userId ?? (await tx.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true } })).id;

  const newAvg = input.qty > 0 && input.avg > 0
    ? calcWeightedAverage(item.currentStock, item.averageCost, input.qty, input.avg)
    : Number(item.averageCost);
  await tx.inventoryItem.update({
    where: { id: input.itemId },
    data: { currentStock: { increment: input.qty }, averageCost: newAvg },
  });
  await tx.inventoryStock.upsert({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    create: { itemId: input.itemId, warehouseId: input.warehouseId, currentStock: input.qty },
    update: { currentStock: { increment: input.qty } },
  });
  const movement = await tx.stockMovement.create({
    data: {
      movementNumber: `SM-SEED-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: day,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      movementType: 'In',
      quantity: input.qty,
      unitCost: input.avg,
      totalValue: new Decimal(input.qty).mul(input.avg).toDecimalPlaces(2).toNumber(),
      notes: 'IT seedStock',
      fiscalYearId: fiscalYear.id,
      createdById: userId,
    },
  });
  return { movementId: movement.id };
}
