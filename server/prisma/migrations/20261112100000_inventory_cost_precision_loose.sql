-- E3-R6 (PR-6.4a): the part of 20261112100000_inventory_cost_precision/ for columns that loose SQL creates
-- (20260517, 20260518, 20260518b, 20260602b). On an existing database the folder's DO block already
-- widened them. `prisma migrate deploy` runs before loose SQL, so on a fresh database these columns do
-- not exist yet when that folder runs and this file widens them. Same widening: numeric(20,6),
-- existing digits kept; re-running is harmless. A stored cost above 14 integer digits fails with
-- "numeric field overflow" rather than being truncated.
ALTER TABLE "stock_movements" ALTER COLUMN "unit_cost_loaded" TYPE DECIMAL(20,6);
ALTER TABLE "goods_receipt_items" ALTER COLUMN "locked_unit_cost" TYPE DECIMAL(20,6);
ALTER TABLE "production_runs" ALTER COLUMN "computed_hpp" TYPE DECIMAL(20,6);
ALTER TABLE "production_run_items" ALTER COLUMN "batch_unit_cost" TYPE DECIMAL(20,6);
ALTER TABLE "production_run_items" ALTER COLUMN "nrv_unit_value" TYPE DECIMAL(20,6);
ALTER TABLE "sales_invoice_items" ALTER COLUMN "unit_cost_loaded" TYPE DECIMAL(20,6);
ALTER TABLE "sales_return_items" ALTER COLUMN "unit_cost_loaded" TYPE DECIMAL(20,6);
