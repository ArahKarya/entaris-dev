-- 2026-11-05: Baseline daftar cek tutup buku (E1-R8, PR-8b). Selisih buku besar yang sudah ada saat
-- fitur rilis dicatat sekali di sini (scripts/repair/e1-close-baseline.ts --apply). Cek tutup buku
-- yang memblokir mengabaikan butir yang ada di baseline dengan nominal yang sama; selisih baru, atau
-- selisih lama yang nominalnya berubah, tetap memblokir.
-- item_key unik per cek (sudah memuat id tahun buku bila perlu), jadi PK (check_id, item_key).
-- Additive only; aman dijalankan ulang tiap startup (IF NOT EXISTS / DO blocks).

CREATE TABLE IF NOT EXISTS "close_check_baselines" (
    "check_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "fiscal_year_id" TEXT,
    "amount" DECIMAL(20,2) NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "close_check_baselines_pkey" PRIMARY KEY ("check_id", "item_key")
);

DO $$ BEGIN
  ALTER TABLE "close_check_baselines" ADD CONSTRAINT "close_check_baselines_fiscal_year_id_fkey"
    FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "close_check_baselines_fiscal_year_id_idx"
    ON "close_check_baselines"("fiscal_year_id");
