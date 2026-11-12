-- E6-R8 (PR-6.11b): production_run_items.price_is_manual tells a price the user typed on a main
-- output line from one back-filled with the loaded HPP (services/productionRunLines.ts). An edit
-- refills the back-filled ones from the new HPP instead of freezing the old number. DDL and
-- backfill in one migration, so the code that reads the column never sees an unset row.
-- Idempotent: running it again changes nothing.

ALTER TABLE "production_run_items" ADD COLUMN IF NOT EXISTS "price_is_manual" BOOLEAN NOT NULL DEFAULT false;

-- Main output lines only (line_type 'Output', not by-product); by-product lines stay false since
-- their NRV is always typed and is not an HPP back-fill. A price counts as typed when it is set and
-- the run has no computed HPP, differs from it by more than 0.005 (the stored price has 2 decimals,
-- the HPP 4, so the comparison tolerates rounding and survives a later widening of the scale), or
-- the run's HPP was overridden by hand.
UPDATE "production_run_items" i
   SET "price_is_manual" = true
  FROM "production_runs" r
 WHERE r."id" = i."production_run_id"
   AND i."line_type" = 'Output'
   AND NOT i."is_by_product"
   AND i."unit_price" IS NOT NULL
   AND i."price_is_manual" = false
   AND (r."computed_hpp" IS NULL
        OR r."hpp_manual_override"
        OR ABS(i."unit_price" - r."computed_hpp") > 0.005);
