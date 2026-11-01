-- 2026-10-03: Security — hapus AIRA serviceToken plaintext dari audit log lama.
-- Sebelum fix, respons PUT /api/ai/config/settings (berisi serviceToken) tersimpan
-- utuh di audit_trail.new_values dan bisa dibaca role dengan izin 'audit'.
-- Catatan: versi awal file ini menyebut tabel `audit_logs` (salah; model AuditLog
-- @@map("audit_trail")) sehingga selalu gagal dan dilewati entrypoint.
-- Idempoten: hanya menyentuh baris yang masih punya key serviceToken.
-- 2026-11-06 (E7-R11): audit_trail kini hanya-tambah (trigger). Transaksi ini menyetel
-- entaris.audit_purge lebih dulu agar scrub tetap jalan, mis. setelah restore dump lama yang
-- masih memuat serviceToken. Migrasi lepas lain yang mengubah audit_trail wajib berpola sama.

BEGIN;
SELECT set_config('entaris.audit_purge', 'on', true);

UPDATE audit_trail
SET new_values = new_values - 'serviceToken'
WHERE new_values IS NOT NULL
  AND jsonb_typeof(new_values) = 'object'
  AND new_values ? 'serviceToken';

UPDATE audit_trail
SET old_values = old_values - 'serviceToken'
WHERE old_values IS NOT NULL
  AND jsonb_typeof(old_values) = 'object'
  AND old_values ? 'serviceToken';

COMMIT;
