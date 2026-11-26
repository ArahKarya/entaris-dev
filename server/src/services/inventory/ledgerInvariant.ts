/**
 * Value-ledger invariants (E3-R6) of inventoryLedger.ts, read only: (a) stock_value = Σ active
 * value_delta, (b) stock > 0: stock x average = stock_value within invariantTolerance, (c) report only:
 * current_stock = Σ inventory_stocks. Re-exported from inventoryLedger.ts.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { invariantTolerance } from './inventoryValueMath';

type Tx = Prisma.TransactionClient;

/**
 * Which invariant an item breaks: valueSum (a) stock_value vs Σ active value_delta, average (b)
 * stock > 0 and |stock x average − stock_value| over invariantTolerance, warehouseSum (c, report
 * only) current_stock vs Σ inventory_stocks.
 */
export type LedgerDriftKind = 'valueSum' | 'average' | 'warehouseSum';

export interface LedgerDrift {
  itemId: string;
  code: string;
  kind: LedgerDriftKind;
  /** (c) is reported, it does not fail the check. */
  reportOnly: boolean;
  /** stock_value for (a) and (b), current_stock for (c). */
  actual: Decimal;
  /** Σ active value_delta (a), stock x average (b), Σ inventory_stocks (c). */
  expected: Decimal;
  difference: Decimal;
}

interface InvariantRow {
  id: string;
  code: string;
  stock: string;
  stock_value: string;
  average_cost: string;
  movement_value: string;
  warehouse_stock: string;
}

const VALUE_SUM_TOLERANCE = new Decimal('0.005');
const WAREHOUSE_SUM_TOLERANCE = new Decimal('0.0005');

function driftsOf(r: InvariantRow): LedgerDrift[] {
  const stock = new Decimal(r.stock);
  const value = new Decimal(r.stock_value);
  const drift = (kind: LedgerDriftKind, actual: Decimal, expected: Decimal): LedgerDrift => ({
    itemId: r.id, code: r.code, kind, reportOnly: kind === 'warehouseSum', actual, expected, difference: actual.minus(expected),
  });
  const found: LedgerDrift[] = [];
  const movementValue = new Decimal(r.movement_value);
  if (value.minus(movementValue).abs().gt(VALUE_SUM_TOLERANCE)) found.push(drift('valueSum', value, movementValue));
  const atAverage = stock.times(r.average_cost);
  if (stock.gt(0) && value.minus(atAverage).abs().gt(invariantTolerance(stock))) found.push(drift('average', value, atAverage));
  const warehouseStock = new Decimal(r.warehouse_stock);
  if (stock.minus(warehouseStock).abs().gt(WAREHOUSE_SUM_TOLERANCE)) found.push(drift('warehouseSum', stock, warehouseStock));
  return found;
}

/**
 * The value-ledger invariants of the given items (all items when omitted), by item code. Returns the
 * breaks instead of throwing: tests assert through __tests__/helpers/ledgerInvariant.ts, and the
 * health check (PR-6.13a) reports them. Reads only; take lockInventoryRows first for a stable read.
 */
export async function assertLedgerInvariant(db: Tx | PrismaClient, itemIds?: readonly string[]): Promise<LedgerDrift[]> {
  if (itemIds && itemIds.length === 0) return [];
  const filter = itemIds ? Prisma.sql`WHERE i.id = ANY(${[...itemIds]}::text[])` : Prisma.empty;
  const rows = await db.$queryRaw<InvariantRow[]>`
    SELECT i.id, i.code, i.current_stock::text AS stock, i.stock_value::text AS stock_value,
           i.average_cost::text AS average_cost,
           COALESCE((SELECT SUM(m.value_delta) FROM stock_movements m
                     WHERE m.item_id = i.id AND m.is_cancelled = false), 0)::text AS movement_value,
           COALESCE((SELECT SUM(s.current_stock) FROM inventory_stocks s WHERE s.item_id = i.id), 0)::text AS warehouse_stock
    FROM inventory_items i
    ${filter}
    ORDER BY i.code`;
  return rows.flatMap(driftsOf);
}
