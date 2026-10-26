-- 2026-10-21: CRM Tahap 1 (kontak per Customer, riwayat aktivitas, PIC sales, radar pesan ulang,
-- pengaturan pengingat). Idempotent: loose .sql files re-run on every boot.
-- No GL, stock or amount changes.

DO $$ BEGIN
  CREATE TYPE "CrmActivityType" AS ENUM ('Telepon', 'WhatsApp', 'Kunjungan', 'Email', 'Catatan');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. Party: PIC sales, siklus order manual, jeda radar.
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "sales_owner_id" TEXT;
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "reorder_cycle_days" INTEGER;
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "reorder_snoozed_until" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "parties_sales_owner_id_idx" ON "parties"("sales_owner_id");
DO $$ BEGIN
  ALTER TABLE "parties" ADD CONSTRAINT "parties_sales_owner_id_fkey"
    FOREIGN KEY ("sales_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Inquiry: PIC sales dan penanda follow-up selesai.
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "sales_owner_id" TEXT;
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "follow_up_done_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "inquiries_sales_owner_id_idx" ON "inquiries"("sales_owner_id");
CREATE INDEX IF NOT EXISTS "inquiries_follow_up_date_idx" ON "inquiries"("follow_up_date");
DO $$ BEGIN
  ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_sales_owner_id_fkey"
    FOREIGN KEY ("sales_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Kontak PIC per Customer.
CREATE TABLE IF NOT EXISTS "party_contacts" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "party_contacts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "party_contacts_party_id_idx" ON "party_contacts"("party_id");
CREATE INDEX IF NOT EXISTS "party_contacts_phone_idx" ON "party_contacts"("phone");
-- At most one primary contact per Customer (partial index; not expressible in schema.prisma).
CREATE UNIQUE INDEX IF NOT EXISTS "party_contacts_one_primary" ON "party_contacts"("party_id") WHERE "is_primary";
DO $$ BEGIN
  ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4. Riwayat aktivitas sales.
CREATE TABLE IF NOT EXISTS "crm_activities" (
    "id" TEXT NOT NULL,
    "party_id" TEXT,
    "inquiry_id" TEXT,
    "contact_id" TEXT,
    "type" "CrmActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "outcome" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_follow_up_date" TIMESTAMP(3),
    "follow_up_done_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'form',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "crm_activities_party_id_occurred_at_idx" ON "crm_activities"("party_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "crm_activities_inquiry_id_idx" ON "crm_activities"("inquiry_id");
CREATE INDEX IF NOT EXISTS "crm_activities_next_follow_up_date_idx" ON "crm_activities"("next_follow_up_date");
DO $$ BEGIN
  ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Deleting an Inquiry keeps its sales history on the Customer (link cleared).
ALTER TABLE "crm_activities" DROP CONSTRAINT IF EXISTS "crm_activities_inquiry_id_fkey";
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_inquiry_id_fkey"
  FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DO $$ BEGIN
  ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "party_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5. Pengaturan CRM (singleton).
CREATE TABLE IF NOT EXISTS "crm_settings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT 'default',
    "reminder_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reminder_time" TEXT NOT NULL DEFAULT '07:30',
    "reminder_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "quotation_no_reply_days" INTEGER NOT NULL DEFAULT 3,
    "reorder_tolerance_factor" DECIMAL(4,2) NOT NULL DEFAULT 1.5,
    "reorder_min_invoices" INTEGER NOT NULL DEFAULT 3,
    "last_reminder_on" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_settings_slug_key" ON "crm_settings"("slug");
