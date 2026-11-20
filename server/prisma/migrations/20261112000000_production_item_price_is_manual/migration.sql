-- E6-R8 (PR-6.11b): production_run_items.price_is_manual tells a price the user typed on a main
-- output line from one back-filled with the loaded HPP (services/productionRunLines.ts). An edit
-- refills the back-filled ones from the new HPP instead of freezing the old number. DDL and
-- backfill in one migration, so the code that reads the column never sees an unset row.
-- Idempotent: running it again changes nothing.

ALTER TABLE "production_run_items" ADD COLUMN IF NOT EXISTS "price_is_manual" BOOLEAN NOT NULL DEFAULT false;

-- Main output lines only (line_type 'Output', not by-product); by-product lines stay false since
-- their NRV is always typed and is not an HPP back-fill. A price counts as typed when it is set and
-- the run has no computed HPP, differs from it by more than 0.005 (the stored price has 2 decimals,
-- the HPP 4, so the comparison tolerates rounding and survives a later widening of the scale). A
-- run with a hand-set HPP override is not special: its back-filled price equals the override, which
-- is what the runtime rule (productionCosting.ts) also treats as back-filled.
-- production_runs.computed_hpp comes from a loose SQL file that runs after migrate deploy, so on a
-- fresh database the column is not there yet (and there are no rows to back-fill either).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'production_runs' AND column_name = 'computed_hpp'
  ) THEN
    EXECUTE $q$
      UPDATE "production_run_items" i
         SET "price_is_manual" = true
        FROM "production_runs" r
       WHERE r."id" = i."production_run_id"
         AND i."line_type" = 'Output'
         AND NOT i."is_by_product"
         AND i."unit_price" IS NOT NULL
         AND i."price_is_manual" = false
         AND (r."computed_hpp" IS NULL
              OR ABS(i."unit_price" - r."computed_hpp") > 0.005)
    $q$;
  END IF;
END $$;
