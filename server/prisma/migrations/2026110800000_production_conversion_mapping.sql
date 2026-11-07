-- 2026-11-08: PRODUCTION_CONVERSION dipetakan ke 5.12 (E2-R9, PR-4.13a). Posting konversi produksi
-- sekarang membaca role ini; kode lama hardcode 5.12 dan tidak pernah membaca pemetaan, jadi
-- pemetaan lama ke 6.39 tidak pernah dipakai posting dan aman diganti.
-- Hanya berbuat bila 5.12 ada, bukan akun grup, aktif, bertipe EXPENSE, dan role belum dipetakan
-- atau hanya dipetakan ke 6.39. Pemetaan lain (pilihan akuntan) tidak disentuh; e2-system-account-audit
-- melaporkannya. Idempoten: dijalankan ulang tidak mengubah apa pun.

DO $$
DECLARE
  target_id TEXT;
  legacy_id TEXT;
BEGIN
  SELECT id INTO target_id FROM "accounts"
   WHERE "accountNumber" = '5.12' AND "isGroup" = false AND "isActive" = true AND "rootType" = 'EXPENSE';
  IF target_id IS NULL THEN
    RETURN;
  END IF;

  -- Role mapped to anything other than 6.39 / 5.12: leave it to the accountant.
  IF EXISTS (
    SELECT 1 FROM "system_account_mappings" m JOIN "accounts" a ON a.id = m.account_id
     WHERE m.role = 'PRODUCTION_CONVERSION' AND a."accountNumber" NOT IN ('6.39', '5.12')
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO legacy_id FROM "accounts" WHERE "accountNumber" = '6.39';
  IF legacy_id IS NOT NULL THEN
    DELETE FROM "system_account_mappings" WHERE role = 'PRODUCTION_CONVERSION' AND account_id = legacy_id;
  END IF;

  INSERT INTO "system_account_mappings" (id, role, account_id, sort_order, created_at, updated_at)
  SELECT gen_random_uuid()::text, 'PRODUCTION_CONVERSION', target_id, 0, now(), now()
   WHERE NOT EXISTS (SELECT 1 FROM "system_account_mappings" WHERE role = 'PRODUCTION_CONVERSION' AND account_id = target_id);
END $$;
