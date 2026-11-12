-- E3-R6 (PR-6.4a, owner decision #1): every stored unit cost and average cost carries 6 decimals
-- (UNIT_COST_DP in server/src/utils/costPrecision.ts). Rupiah values (total_value, journal lines)
-- stay at 2 dp. Widening only: existing values keep their digits (a 2 or 4 dp value is exact at 6 dp).
-- Columns created by loose SQL (not by a Prisma migration) are widened in
-- 20261112100000_inventory_cost_precision_loose.sql, which runs after this folder on a fresh database.
-- numeric(20,6) leaves 14 integer digits; a stored cost above that fails this migration with
-- "numeric field overflow" rather than being truncated. GA store columns (ga_work_order_parts,
-- ga_material_request_items) are not inventory costs and are left alone.
ALTER TABLE "inventory_items" ALTER COLUMN "average_cost" TYPE DECIMAL(20,6);
ALTER TABLE "stock_movements" ALTER COLUMN "unit_cost" TYPE DECIMAL(20,6);
ALTER TABLE "production_run_items" ALTER COLUMN "unit_price" TYPE DECIMAL(20,6);
ALTER TABLE "stock_opname_items" ALTER COLUMN "unit_cost" TYPE DECIMAL(20,6);
ALTER TABLE "cogs_backfill_queue" ALTER COLUMN "cost_at_sale" TYPE DECIMAL(20,6);
ALTER TABLE "cogs_backfill_settlements" ALTER COLUMN "cost_at_settle" TYPE DECIMAL(20,6);
