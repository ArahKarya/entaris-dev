-- E3-R6 (PR-6.4a, owner decision #1): every stored unit cost and average cost carries 6 decimals
-- (UNIT_COST_DP in server/src/utils/costPrecision.ts). Rupiah values (total_value, journal lines)
-- stay at 2 dp. Widening only: existing values keep their digits (a 2 or 4 dp value is exact at 6 dp).
-- Columns created by loose SQL (not by a Prisma migration) are widened here too, in the DO block at
-- the end, so the widening does not hang on the loose-SQL run (a failure there is only a warning in
-- the entrypoints). On a fresh database those columns do not exist yet when this folder runs: the
-- block skips them and 20261112100000_inventory_cost_precision_loose.sql widens them right after
-- the loose files that create them.
-- numeric(20,6) leaves 14 integer digits; a stored cost above that fails this migration with
-- "numeric field overflow" rather than being truncated. GA store columns (ga_work_order_parts,
-- ga_material_request_items) are not inventory costs and are left alone.
ALTER TABLE "inventory_items" ALTER COLUMN "average_cost" TYPE DECIMAL(20,6);
ALTER TABLE "stock_movements" ALTER COLUMN "unit_cost" TYPE DECIMAL(20,6);
ALTER TABLE "production_run_items" ALTER COLUMN "unit_price" TYPE DECIMAL(20,6);
ALTER TABLE "stock_opname_items" ALTER COLUMN "unit_cost" TYPE DECIMAL(20,6);
ALTER TABLE "cogs_backfill_queue" ALTER COLUMN "cost_at_sale" TYPE DECIMAL(20,6);
ALTER TABLE "cogs_backfill_settlements" ALTER COLUMN "cost_at_settle" TYPE DECIMAL(20,6);
DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN (VALUES
      ('stock_movements', 'unit_cost_loaded'),
      ('goods_receipt_items', 'locked_unit_cost'),
      ('production_runs', 'computed_hpp'),
      ('production_run_items', 'batch_unit_cost'),
      ('production_run_items', 'nrv_unit_value'),
      ('sales_invoice_items', 'unit_cost_loaded'),
      ('sales_return_items', 'unit_cost_loaded')
    ) AS t(table_name, column_name)
      ON t.table_name = c.table_name AND t.column_name = c.column_name
    WHERE c.table_schema = current_schema()
      AND (c.numeric_precision IS DISTINCT FROM 20 OR c.numeric_scale IS DISTINCT FROM 6)
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE DECIMAL(20,6)', col.table_name, col.column_name);
  END LOOP;
END $$;
