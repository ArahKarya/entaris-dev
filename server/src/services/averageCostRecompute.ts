import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { logger } from '../lib/logger';
import { replayWeightedAverage, type ReplayMovement } from '../utils/weightedAverageReplay';

type Tx = Prisma.TransactionClient;

const STOCK_TOLERANCE = new Decimal('0.001');

export interface ReplayedAverage {
  averageCost: number;
  /** False when the movements do not explain the item's stock; averageCost is then the stored one. */
  explained: boolean;
}

/**
 * The average the item's active movements replay to, without writing it. `excludeMovementIds`
 * leaves rows out whose stock the caller has already reversed but not yet rewritten (a manual
 * movement edit). Not explained (warning logged) when the replayed stock misses the item's stock.
 */
export async function replayAverageCost(
  tx: Tx,
  itemId: string,
  opts: { excludeMovementIds?: string[] } = {},
): Promise<ReplayedAverage | null> {
  const item = await tx.inventoryItem.findUnique({
    where: { id: itemId },
    select: { averageCost: true, currentStock: true },
  });
  if (!item) return null;

  const rows = await tx.stockMovement.findMany({
    where: { itemId, isCancelled: false, ...(opts.excludeMovementIds?.length ? { id: { notIn: opts.excludeMovementIds } } : {}) },
    select: { id: true, movementType: true, quantity: true, unitCost: true, createdAt: true, referenceType: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const movements: ReplayMovement[] = rows.map((r) => ({
    id: r.id,
    movementType: r.movementType,
    quantity: r.quantity.toString(),
    unitCost: r.unitCost.toString(),
    createdAt: r.createdAt,
    referenceType: r.referenceType,
  }));

  const { averageCost, stock } = replayWeightedAverage(movements, {
    fallbackAverageCost: new Decimal(item.averageCost.toString()),
  });

  // Replay is only trustworthy when the movements explain the item's stock.
  // A residual means stock that entered without a movement (legacy/direct
  // opening balance, unknown cost): replaying from zero would mis-weight it,
  // so keep the stored average and flag it for review.
  const residual = new Decimal(item.currentStock.toString()).minus(stock);
  if (residual.abs().gt(STOCK_TOLERANCE)) {
    logger.warn(
      { itemId, currentStock: item.currentStock.toString(), replayedStock: stock, residual: residual.toString() },
      'Average cost recompute skipped: item stock not explained by movements (opening balance without movement)',
    );
    return { averageCost: Number(item.averageCost), explained: false };
  }
  return { averageCost, explained: true };
}

/**
 * Re-derive averageCost by replaying the item's active movements; historical COGS/journals stay.
 * Skipped (stored average kept) when movements don't explain the stock. Call after the movements
 * were cancelled/edited in the same transaction.
 */
export async function recomputeAverageCostFromReplay(tx: Tx, itemId: string): Promise<number> {
  const replayed = await replayAverageCost(tx, itemId);
  if (!replayed) return 0;
  if (replayed.explained) await tx.inventoryItem.update({ where: { id: itemId }, data: { averageCost: replayed.averageCost } });
  return replayed.averageCost;
}
