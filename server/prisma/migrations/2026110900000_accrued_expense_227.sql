-- 2026-11-09: akun 2.2.7 "Biaya Masih Harus Dibayar" untuk role ACCRUED_EXPENSE (E2-R10, PR-4.14).
-- ACCRUED_EXPENSE sebelumnya dipetakan ke 2.2.6 "Hutang Gaji Karyawan", akun gaji, bukan biaya
-- masih harus dibayar. DB baru sudah mendapat 2.2.7 dari seed; file ini menyamakan DB lama.
-- Dua langkah, keduanya hanya berbuat bila aman, dan idempoten (dijalankan ulang tidak mengubah apa pun):
--   1. Buat 2.2.7 bila belum ada dan induk 2.2 ada.
--   2. Pindahkan pemetaan ACCRUED_EXPENSE dari 2.2.6 ke 2.2.7 hanya bila 2.2.7 memang akun milik file
--      ini (nama 'Biaya Masih Harus Dibayar' di bawah 2.2; 2.2.7 buatan tenant dengan nama lain tidak
--      disentuh) dan role itu masih tepat di
--      2.2.6 dan 2.2.6 belum punya baris buku besar (ALE) maupun baris jurnal (JI). Akun 2.2.6 yang
--      sudah dipakai tidak dipindah; itu pilihan akuntan (e2-system-account-audit melaporkannya).

INSERT INTO accounts (
  id, name, "accountNumber", "accountType", "rootType",
  "isGroup", "isActive", balance, currency, description, "parentId",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'Biaya Masih Harus Dibayar',
  '2.2.7',
  'LIABILITY',
  'LIABILITY',
  false,
  true,
  0,
  'IDR',
  'Biaya yang sudah terjadi tetapi belum dibayar (accrued expense).',
  (SELECT id FROM accounts WHERE "accountNumber" = '2.2' AND "isGroup" = true LIMIT 1),
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE "accountNumber" = '2.2.7')
  AND EXISTS (SELECT 1 FROM accounts WHERE "accountNumber" = '2.2' AND "isGroup" = true);

DO $$
DECLARE
  new_id TEXT;
  old_id TEXT;
BEGIN
  SELECT a.id INTO new_id FROM accounts a
   WHERE a."accountNumber" = '2.2.7' AND a."isGroup" = false AND a."isActive" = true AND a."rootType" = 'LIABILITY'
     AND a.name = 'Biaya Masih Harus Dibayar'
     AND a."parentId" = (SELECT id FROM accounts WHERE "accountNumber" = '2.2' LIMIT 1);
  SELECT id INTO old_id FROM accounts WHERE "accountNumber" = '2.2.6';
  IF new_id IS NULL OR old_id IS NULL THEN
    RETURN;
  END IF;

  -- Only when ACCRUED_EXPENSE is mapped to exactly 2.2.6 and nothing else.
  IF NOT EXISTS (SELECT 1 FROM "system_account_mappings" WHERE role = 'ACCRUED_EXPENSE' AND account_id = old_id)
     OR EXISTS (SELECT 1 FROM "system_account_mappings" WHERE role = 'ACCRUED_EXPENSE' AND account_id <> old_id) THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM "accounting_ledger_entries" WHERE account_id = old_id)
     OR EXISTS (SELECT 1 FROM "journal_entry_accounts" WHERE account_id = old_id) THEN
    RETURN;
  END IF;

  UPDATE "system_account_mappings" SET account_id = new_id, updated_at = now()
   WHERE role = 'ACCRUED_EXPENSE' AND account_id = old_id;
END $$;
