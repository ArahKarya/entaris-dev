-- 2026-10-30: Jejak batal (siapa dan alasan) di goods_receipts, payments, project_guarantees dan
-- project_guarantee_settlements, sama seperti journal_entries.cancelled_by_id/cancel_reason
-- (2026102700000_journal_entry_source.sql). Kolom nullable tanpa default dan tanpa FK ke users:
-- data lama tetap NULL. Additive only; aman dijalankan ulang tiap startup (IF NOT EXISTS).

ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "cancelled_by_id" TEXT;
ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT;

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "cancelled_by_id" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT;

ALTER TABLE "project_guarantees" ADD COLUMN IF NOT EXISTS "cancelled_by_id" TEXT;
ALTER TABLE "project_guarantees" ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT;

ALTER TABLE "project_guarantee_settlements" ADD COLUMN IF NOT EXISTS "cancelled_by_id" TEXT;
ALTER TABLE "project_guarantee_settlements" ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT;
