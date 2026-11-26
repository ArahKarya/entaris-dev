/**
 * Stock as of the end of a business day (plan step 6 §2.5; E3-R11). The one as-of rule: the stock
 * count (routes/stockOpname.ts) and the per-warehouse snapshot (services/stockSnapshot.ts) both
 * read it, and PR-6.13c extends it with the value from value_delta.
 *
 * Forward-summing movements is wrong (opening balances and some legacy adjustments have no
 * movement row), so the quantity anchors on the live inventory_stocks row and walks back:
 *   qty as of D = live − Σ signed active movements dated on or after the start of D + 1
 * where D + 1 starts at businessDayRange(D).lt (WIB midnight, utils/businessDate.ts), never at the
 * server's local midnight. In / AdjustmentIn / TransferIn add stock, Out / AdjustmentOut /
 * TransferOut take it; a Revaluation row moves value only and a cancelled row moved nothing (its
 * reversal already put the live row back), so both stay out.
 *
 * The functions only read. A writer that acts on the figure (the count) calls lockInventoryRows
 * for the items first (LOCK ORDER in stockLocks.ts), so no movement can commit between the read
 * and its write.
 */
import type { Prisma, StockMovementType } from '@prisma/client';
import Decimal from 'decimal.js';
import { businessDayRange } from '../../utils/businessDate';
import { stockKey } from './stockLocks';

type Db = Prisma.TransactionClient;

/** Movement types that add stock to their warehouse. */
export const QTY_IN_TYPES: readonly StockMovementType[] = ['In', 'AdjustmentIn', 'TransferIn'];
/** Movement types that take stock out of their warehouse. Listed, not "not inbound": Revaluation moves no quantity. */
export const QTY_OUT_TYPES: readonly StockMovementType[] = ['Out', 'AdjustmentOut', 'TransferOut'];

/** The quantity a movement added to its warehouse (negative for an outbound one, 0 for Revaluation). */
export function signedQuantity(type: StockMovementType, quantity: Decimal.Value): Decimal {
  if (QTY_IN_TYPES.includes(type)) return new Decimal(quantity);
  if (QTY_OUT_TYPES.includes(type)) return new Decimal(quantity).negated();
  return new Decimal(0);
}

export interface WarehouseQtyQuery {
  warehouseIds: readonly string[];
  /** Limits the result to these items; omitted, every item with a live row or a later movement. */
  itemIds?: readonly string[];
  /** Business day (YYYY-MM-DD), inclusive. */
  day: string;
}

/**
 * Quantity per (item, warehouse) as of the end of `day`, keyed by stockKey(itemId, warehouseId).
 * Every pair with a live row or an active movement after the day is present, also at 0.
 */
export async function qtyAsOfByWarehouse(db: Db, q: WarehouseQtyQuery): Promise<Map<string, Decimal>> {
  const result = new Map<string, Decimal>();
  if (q.warehouseIds.length === 0 || q.itemIds?.length === 0) return result;
  const warehouseId = { in: [...q.warehouseIds] };
  const itemId = q.itemIds ? { in: [...q.itemIds] } : undefined;

  const [live, later] = await Promise.all([
    db.inventoryStock.findMany({ where: { warehouseId, itemId }, select: { itemId: true, warehouseId: true, currentStock: true } }),
    db.stockMovement.groupBy({
      by: ['warehouseId', 'itemId', 'movementType'],
      where: { warehouseId, itemId, isCancelled: false, date: { gte: businessDayRange(q.day).lt } },
      _sum: { quantity: true },
    }),
  ]);
  for (const row of live) result.set(stockKey(row.itemId, row.warehouseId), new Decimal(row.currentStock.toString()));
  for (const row of later) {
    if (!row.warehouseId) continue;
    const key = stockKey(row.itemId, row.warehouseId);
    const added = signedQuantity(row.movementType, row._sum.quantity?.toString() ?? 0);
    // Undo what the later movement did: an inbound one comes off, an outbound one goes back on.
    result.set(key, (result.get(key) ?? new Decimal(0)).minus(added));
  }
  return result;
}

/**
 * Quantity of each item in one warehouse as of the end of `day`: every requested item is present
 * (0 when the warehouse never held it).
 */
export async function qtyAsOf(
  db: Db,
  q: { warehouseId: string; itemIds: readonly string[]; day: string },
): Promise<Map<string, Decimal>> {
  const byPair = await qtyAsOfByWarehouse(db, { warehouseIds: [q.warehouseId], itemIds: q.itemIds, day: q.day });
  return new Map(q.itemIds.map((id) => [id, byPair.get(stockKey(id, q.warehouseId)) ?? new Decimal(0)]));
}
