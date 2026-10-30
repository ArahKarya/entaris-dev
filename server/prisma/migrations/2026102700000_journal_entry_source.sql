-- 2026-10-27: Asal jurnal (source_type/source_key) plus kolom jejak batal dan jurnal balik di
-- journal_entries. Semua kolom nullable tanpa default: NULL berarti "bukan jurnal manual" (asal
-- belum diketahui), jadi jalur batal tetap aman untuk data lama sampai skrip backfill dijalankan.
-- Additive only; aman dijalankan ulang tiap startup (IF NOT EXISTS / DO-block). Tiap pernyataan
-- menjaga dirinya sendiri, karena galat "sudah ada" mencatat seluruh file sebagai terpasang.

DO $$ BEGIN
  CREATE TYPE "JournalSourceType" AS ENUM (
    'MANUAL','CASH_BOOK','RECURRING','IMPORT','OPENING','FY_CLOSE',
    'DEPRECIATION','DEPOSIT_REFUND','DEPOSIT_OFFSET','SYSTEM_DOC'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "source_type" "JournalSourceType";
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "source_key" TEXT;
-- Tanpa FK ke users, sama seperti ga_work_orders.cancelled_by_id.
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "cancelled_by_id" TEXT;
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT;
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "reversed_by_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_reversed_by_id_key"
  ON "journal_entries" ("reversed_by_id");

-- SET NULL: buka-ulang tahun buku dan hapus data dummy menghapus jurnal secara fisik.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_reversed_by_id_fkey'
  ) THEN
    ALTER TABLE "journal_entries"
      ADD CONSTRAINT "journal_entries_reversed_by_id_fkey"
      FOREIGN KEY ("reversed_by_id") REFERENCES "journal_entries"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "journal_entries_source_type_source_key_idx"
  ON "journal_entries" ("source_type", "source_key");
