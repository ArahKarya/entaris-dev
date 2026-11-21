-- E3-R6 (PR-6.4b1): inventory value ledger. Every stock movement carries a signed value_delta and
-- every item a stock_value = Σ value_delta of its active movements (services/inventory/
-- inventoryValueMath.ts). DDL, then the data the ledger code needs before it runs: the backfill of
-- every movement and the valuation baseline (plan §2.10, owner decisions #18 and #19).
--
-- The data part between the value-ledger-data markers is the ONE source of that SQL:
-- scripts/repair/e3-value-baseline.ts and valuationBaseline.integration.test.ts read it from this
-- file (services/inventory/valueBaselineSql.ts). Keep it a single DO block and safe to run again:
-- a second run adds a row only for what changed since (0 rows on a database the ledger keeps).
-- A condition it cannot meet stops it with RAISE EXCEPTION (caught on the dump rehearsal, §8 7c),
-- never a silent skip. goods_receipt_items and purchase_invoice_items.goods_receipt_item_id come
-- from loose SQL, which runs after this folder: on a fresh database they are not there yet (and
-- there is no data either), so the STT steps check information_schema first.

ALTER TABLE "stock_movements" ADD COLUMN "value_delta" DECIMAL(20,2) NOT NULL DEFAULT 0;
ALTER TABLE "stock_movements" ADD COLUMN "adjusts_movement_id" TEXT;
ALTER TABLE "inventory_items" ADD COLUMN "stock_value" DECIMAL(20,2) NOT NULL DEFAULT 0;

CREATE INDEX "stock_movements_adjusts_movement_id_idx" ON "stock_movements"("adjusts_movement_id");
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_adjusts_movement_id_fkey"
  FOREIGN KEY ("adjusts_movement_id") REFERENCES "stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- value-ledger-data:begin
DO $value_ledger$
DECLARE
  has_stt boolean;
  bad text;
  needed integer;
  baseline_day timestamp(3);
  baseline_fy text;
  creator text;
BEGIN
  has_stt := EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'goods_receipt_items' AND column_name = 'stock_movement_id')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'purchase_invoice_items' AND column_name = 'goods_receipt_item_id');

  -- (1) Pre-check, decision #18: the baseline values current_stock, so it must equal the stock the
  -- warehouses hold. Fix with scripts/repair/e3-stock-drift.ts (accountant's plan), never here.
  SELECT string_agg(format('%s (item %s, warehouses %s)', i."code", i."current_stock", COALESCE(w.qty, 0)), ', ' ORDER BY i."code")
    INTO bad
    FROM "inventory_items" i
    LEFT JOIN (SELECT "item_id", SUM("current_stock") AS qty FROM "inventory_stocks" GROUP BY "item_id") w ON w."item_id" = i."id"
   WHERE ABS(i."current_stock" - COALESCE(w.qty, 0)) > 0.0005;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'value ledger: item stock differs from the sum of its warehouses (decision #18; run scripts/repair/e3-stock-drift first): %', bad;
  END IF;

  -- (2) Backfill value_delta on every row, cancelled ones included, so a later reversal takes back the
  -- right amount. Only rows still at 0 (a re-run leaves values already set alone). An STT receipt is
  -- valued at the STT locked cost, not total_value, which a purchase invoice may have overwritten
  -- with its landed cost or revised price: that delta becomes a Revaluation row in (3).
  IF has_stt THEN
    UPDATE "stock_movements" sm
       SET "value_delta" = ROUND(gri."locked_unit_cost" * sm."quantity", 2)
      FROM "goods_receipt_items" gri
     WHERE gri."stock_movement_id" = sm."id" AND sm."movement_type" = 'In' AND sm."value_delta" = 0;
    UPDATE "stock_movements" sm
       SET "value_delta" = CASE WHEN sm."movement_type" IN ('In', 'AdjustmentIn') THEN sm."total_value" ELSE -sm."total_value" END
     WHERE sm."value_delta" = 0
       AND sm."movement_type" IN ('In', 'AdjustmentIn', 'Out', 'AdjustmentOut')
       AND NOT EXISTS (SELECT 1 FROM "goods_receipt_items" g WHERE g."stock_movement_id" = sm."id");
  ELSE
    UPDATE "stock_movements" sm
       SET "value_delta" = CASE WHEN sm."movement_type" IN ('In', 'AdjustmentIn') THEN sm."total_value" ELSE -sm."total_value" END
     WHERE sm."value_delta" = 0
       AND sm."movement_type" IN ('In', 'AdjustmentIn', 'Out', 'AdjustmentOut');
  END IF;
  -- TransferOut / TransferIn keep 0: a transfer moves quantity between warehouses, not value.

  -- (3) One Revaluation per active STT receipt whose purchase invoice is still live (not Draft, not
  -- Cancelled) and moved its value away from the locked cost: value = total_value − locked value,
  -- adjusting the STT movement, dated and numbered after the invoice. A cancelled invoice unlinks its
  -- lines (invoiceCancellation.ts), so its leftover delta gets no row and lands in the baseline (5).
  -- Landed cost and a later price revision both overwrite total_value, so one row per receipt carries
  -- their net, referenced to the invoice (reference_type 'PurchaseInvoice').
  IF has_stt THEN
    INSERT INTO "stock_movements" (
      "id", "movement_number", "date", "item_id", "warehouse_id", "movement_type", "quantity", "unit_cost",
      "total_value", "value_delta", "notes", "reference_type", "reference_id", "reference_number",
      "fiscal_year_id", "created_by_id", "is_cancelled", "adjusts_movement_id", "created_at", "updated_at")
    SELECT gen_random_uuid()::text, 'SM-RV-' || sm."movement_number", pi."date", sm."item_id", NULL, 'Revaluation'::"StockMovementType", 0, 0,
           ABS(d.delta), d.delta,
           'Selisih harga Invoice pembelian ' || pi."invoice_number" || ' atas ' || sm."movement_number" || ' (awal buku nilai)',
           'PurchaseInvoice', pi."id", pi."invoice_number", pi."fiscal_year_id", pi."created_by", false, sm."id", now(), now()
      FROM "stock_movements" sm
      JOIN "goods_receipt_items" gri ON gri."stock_movement_id" = sm."id"
      JOIN "purchase_invoice_items" pii ON pii."goods_receipt_item_id" = gri."id"
      JOIN "purchase_invoices" pi ON pi."id" = pii."purchase_invoice_id" AND pi."status" NOT IN ('Draft', 'Cancelled')
      CROSS JOIN LATERAL (SELECT sm."total_value" - ROUND(gri."locked_unit_cost" * sm."quantity", 2) AS delta) d
     WHERE sm."movement_type" = 'In' AND NOT sm."is_cancelled" AND d.delta <> 0
       AND NOT EXISTS (SELECT 1 FROM "stock_movements" r WHERE r."adjusts_movement_id" = sm."id");
  END IF;

  -- (4) stock_value = stock x average, where it is not already within invariant (b)'s tolerance
  -- (inventoryValueMath.invariantTolerance), so a re-run leaves a value the ledger keeps alone.
  UPDATE "inventory_items"
     SET "stock_value" = ROUND("current_stock" * "average_cost", 2)
   WHERE ABS("stock_value" - ROUND("current_stock" * "average_cost", 2))
         > GREATEST(0.01, ABS("current_stock") * 0.0000005);

  -- (5) Baseline: one Revaluation 'ValuationBaseline' per item whose stock_value differs from the sum
  -- of its active movements, with no journal (decision #15: the old gap to the GL stays visible in
  -- the inventory vs GL check). Dated at the later of the cut-over date and the start of the earliest
  -- open fiscal year (decision #19), in the open year that contains that day. Created by the first
  -- active Admin, else any active user. Numbered SM-VB-<item code>-<n>, n after the highest taken.
  SELECT COUNT(*) INTO needed
    FROM "inventory_items" i
   WHERE i."stock_value" <> COALESCE((SELECT SUM(m."value_delta") FROM "stock_movements" m
                                      WHERE m."item_id" = i."id" AND NOT m."is_cancelled"), 0);
  IF needed > 0 THEN
    SELECT GREATEST((SELECT MIN("start_date") FROM "fiscal_years" WHERE NOT "is_closed"),
                    (SELECT MAX("cutover_date")::timestamp(3) FROM "company_settings"))
      INTO baseline_day;
    SELECT "id" INTO baseline_fy
      FROM "fiscal_years"
     WHERE NOT "is_closed" AND baseline_day IS NOT NULL
       AND "start_date"::date <= baseline_day::date AND "end_date"::date >= baseline_day::date
     ORDER BY "start_date" LIMIT 1;
    IF baseline_fy IS NULL THEN
      RAISE EXCEPTION 'value ledger: % item(s) need a valuation baseline, but no open fiscal year contains the baseline date % (later of the cut-over date and the start of the earliest open fiscal year)', needed, COALESCE(baseline_day::date::text, 'none');
    END IF;
    SELECT "id" INTO creator
      FROM "users" WHERE "is_active"
     ORDER BY ("role" = 'Admin') DESC, "created_at", "id" LIMIT 1;
    IF creator IS NULL THEN
      RAISE EXCEPTION 'value ledger: % item(s) need a valuation baseline, but there is no active user to create it under', needed;
    END IF;

    INSERT INTO "stock_movements" (
      "id", "movement_number", "date", "item_id", "warehouse_id", "movement_type", "quantity", "unit_cost",
      "total_value", "value_delta", "notes", "reference_type", "fiscal_year_id", "created_by_id",
      "is_cancelled", "created_at", "updated_at")
    SELECT gen_random_uuid()::text,
           'SM-VB-' || i."code" || '-' || (COALESCE((
             SELECT MAX(substr(m."movement_number", length('SM-VB-' || i."code" || '-') + 1)::integer)
               FROM "stock_movements" m
              WHERE starts_with(m."movement_number", 'SM-VB-' || i."code" || '-')
                AND substr(m."movement_number", length('SM-VB-' || i."code" || '-') + 1) ~ '^[0-9]{1,9}$'), 0) + 1),
           baseline_day, i."id", NULL, 'Revaluation'::"StockMovementType", 0, 0, ABS(g.gap), g.gap,
           'Nilai awal buku nilai: stok x rata-rata per ' || to_char(baseline_day, 'YYYY-MM-DD') || ' (tanpa jurnal)',
           'ValuationBaseline', baseline_fy, creator, false, now(), now()
      FROM "inventory_items" i
      CROSS JOIN LATERAL (SELECT i."stock_value" - COALESCE((SELECT SUM(m."value_delta") FROM "stock_movements" m
                                                             WHERE m."item_id" = i."id" AND NOT m."is_cancelled"), 0) AS gap) g
     WHERE g.gap <> 0;
  END IF;

  -- (6) Self-check, invariant (a): stock_value = Σ active value_delta for every item.
  SELECT string_agg(i."code", ', ' ORDER BY i."code") INTO bad
    FROM "inventory_items" i
   WHERE ABS(i."stock_value" - COALESCE((SELECT SUM(m."value_delta") FROM "stock_movements" m
                                         WHERE m."item_id" = i."id" AND NOT m."is_cancelled"), 0)) > 0.005;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'value ledger: stock_value differs from the sum of active movement values after the baseline: %', bad;
  END IF;
END
$value_ledger$;
-- value-ledger-data:end
