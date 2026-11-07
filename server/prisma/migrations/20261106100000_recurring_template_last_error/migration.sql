-- E2-R3 / R1 S-9 (PR-4.5a): a recurring template that fails to post keeps the reason, so a failing
-- template shows its error instead of silently not running. DDL only; existing rows stay NULL.
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "last_error" TEXT;
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "last_error_at" TIMESTAMP(3);
