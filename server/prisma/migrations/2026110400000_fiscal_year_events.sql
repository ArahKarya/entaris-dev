-- 2026-11-04: Riwayat tutup buku dan buka kembali per tahun buku (E1-R8). Setiap close dan reopen
-- menulis satu baris: siapa, kapan, alasan (wajib saat reopen), jurnal CLOSE yang diposting atau
-- dibatalkan, dan laba yang ditutup. Reopen sekarang membatalkan jurnal CLOSE (status Cancelled),
-- tidak lagi menghapusnya, jadi riwayat ini bisa dicocokkan dengan jurnalnya.
-- user_id / close_journal_id tanpa FK, sama seperti cancelled_by_id (2026103000000_cancel_trail.sql).
-- Additive only; aman dijalankan ulang tiap startup (IF NOT EXISTS / DO blocks).

CREATE TABLE IF NOT EXISTS "fiscal_year_events" (
    "id" TEXT NOT NULL,
    "fiscal_year_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" TEXT,
    "close_journal_id" TEXT,
    "profit" DECIMAL(20,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fiscal_year_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_action_check"
    CHECK ("action" IN ('close', 'reopen'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_fiscal_year_id_fkey"
    FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "fiscal_year_events_fiscal_year_id_created_at_idx"
    ON "fiscal_year_events"("fiscal_year_id", "created_at");
