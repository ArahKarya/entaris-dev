/**
 * Value math of the inventory value ledger (E3-R6), pure. With services/inventory/inventoryLedger.ts
 * (6.4b2) this is the one value-ledger module: there is no second rule for outbound cost, average
 * or revaluation split.
 *
 * Value is per item (I-43 global average). Each movement carries a signed value_delta (2 dp);
 * inventory_items.stock_value is the sum of the active ones, and average_cost is derived from it.
 * Invariants: (a) stock_value = Σ active value_delta (to 0.005); (b) stock > 0:
 * |stock x average − stock_value| <= invariantTolerance(stock); (c) report only: current_stock =
 * Σ inventory_stocks.
 */
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';

/**
 * Decimal places of every stored unit cost and average cost (owner decision #1):
 * inventory_items.average_cost, stock_movements.unit_cost, goods_receipt_items.locked_unit_cost,
 * production_run_items.unit_price / batch_unit_cost / nrv_unit_value, production_runs.computed_hpp,
 * stock_opname_items.unit_cost, unit_cost_loaded, and the legacy COGS queue costs are numeric(20,6).
 * There is no second scale.
 */
export const UNIT_COST_DP = 6;
/** Decimal places of rupiah values: value_delta, stock_value, total_value, journal lines. */
export const VALUE_DP = 2;

/** Error code (400): an item with stock on hand carries a negative stock_value; nothing is valued out of it. */
export const INVENTORY_VALUE_NEGATIVE = 'INVENTORY_VALUE_NEGATIVE';

const round = (v: Decimal) => v.toDecimalPlaces(VALUE_DP);

/**
 * Value that leaves stock when `qty` (> 0) goes out; positive, 2 dp. The ledger decides it, never
 * the caller.
 * - stock > 0 and qty >= stock: the whole remaining value plus the part past zero at the average,
 *   so stock that reaches 0 leaves no value behind;
 * - stock > 0: the proportional share of stock_value;
 * - stock <= 0 (negative-stock window, settled when goods come in, 6.6): average x qty.
 * A negative stock_value with stock on hand is a broken book: refused (health check), never valued.
 */
export function outboundValue(stock: Decimal.Value, stockValue: Decimal.Value, avg: Decimal.Value, qty: Decimal.Value): Decimal {
  const s = new Decimal(stock);
  const v = new Decimal(stockValue);
  const q = new Decimal(qty);
  if (s.gt(0) && v.lt(0)) {
    throw new BusinessError(
      `Nilai persediaan negatif (${v.toFixed(VALUE_DP)}) padahal stok masih ${s.toString()}. Barang tidak bisa dikeluarkan sampai nilainya diperbaiki.`,
      INVENTORY_VALUE_NEGATIVE,
    );
  }
  if (s.lte(0)) return round(new Decimal(avg).times(q));
  if (q.gte(s)) return v.plus(round(new Decimal(avg).times(q.minus(s))));
  return round(v.times(q).div(s));
}

/**
 * Where a value change (Revaluation) lands: the part stock can absorb goes to inventory, the rest
 * to COGS, posted by the caller in the same journal (until E3-PR7 splits purchase price variance).
 * - stock <= 0: the goods are gone, everything to COGS;
 * - a decrease larger than stock_value: inventory down to 0, the rest to COGS (never clamped away);
 * - otherwise: everything to inventory.
 */
export function revaluationSplit(stock: Decimal.Value, stockValue: Decimal.Value, delta: Decimal.Value): { toInventory: Decimal; toCogs: Decimal } {
  const d = new Decimal(delta);
  const v = new Decimal(stockValue);
  if (new Decimal(stock).lte(0)) return { toInventory: new Decimal(0), toCogs: d };
  if (d.lt(0) && d.abs().gt(v)) return { toInventory: v.negated(), toCogs: d.plus(v) };
  return { toInventory: d, toCogs: new Decimal(0) };
}

/** Average cost after a posting: stock_value / stock at UNIT_COST_DP; with no stock the previous average stays. */
export function averageAfter(stock: Decimal.Value, stockValue: Decimal.Value, prevAvg: Decimal.Value): Decimal {
  const s = new Decimal(stock);
  if (s.gt(0)) return new Decimal(stockValue).div(s).toDecimalPlaces(UNIT_COST_DP);
  return new Decimal(prevAvg);
}

/**
 * Allowed gap of invariant (b), |stock x average − stock_value|: an average stored at 6 dp is off by
 * up to 0.5e-6 per unit, so a flat 0.01 fails above 20.000 units (31.990 kg x 0.5e-6 = 0.016).
 */
export function invariantTolerance(stock: Decimal.Value): Decimal {
  return Decimal.max(new Decimal('0.01'), new Decimal(stock).abs().times('0.0000005'));
}
