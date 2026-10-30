-- 2026-11-03: Kunci periode bulanan (E1-R7). Satu baris global `period_lock` menyimpan tanggal
-- kunci: posting, edit dan batal bertanggal <= lock_date ditolak PERIOD_LOCKED (utils/periodGuard.ts).
-- NULL = tanpa kunci, jadi tidak ada perubahan perilaku sampai seseorang mengisinya. Tabel sendiri,
-- bukan kolom company_settings: setiap posting mengambil FOR SHARE pada baris ini, dan simpan profil
-- perusahaan tidak boleh ikut antre. `period_lock_logs` mencatat setiap perubahan beserta alasannya.
-- user_id / updated_by tanpa FK ke users, sama seperti cancelled_by_id (2026103000000_cancel_trail.sql).
-- Additive only; aman dijalankan ulang tiap startup (IF NOT EXISTS / ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS "period_lock" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "lock_date" DATE,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "period_lock_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "period_lock_single_row" CHECK ("id" = 1)
);

INSERT INTO "period_lock" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "period_lock_logs" (
    "id" TEXT NOT NULL,
    "old_date" DATE,
    "new_date" DATE,
    "reason" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "period_lock_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "period_lock_logs_created_at_idx" ON "period_lock_logs"("created_at");
