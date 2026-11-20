/**
 * Decimal places of every stored unit cost and average cost (owner decision #1, E3-R6):
 * inventory_items.average_cost, stock_movements.unit_cost, goods_receipt_items.locked_unit_cost,
 * production_run_items.unit_price / batch_unit_cost / nrv_unit_value, production_runs.computed_hpp,
 * stock_opname_items.unit_cost, unit_cost_loaded, and the legacy COGS queue costs are numeric(20,6).
 * Rupiah values (total_value, journal lines) stay at 2 dp. Moves into inventoryValueMath.ts with the
 * value ledger (6.4b1); there is no second scale.
 */
export const UNIT_COST_DP = 6;
