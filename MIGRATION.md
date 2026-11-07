# Panduan Update & Migrasi — Entaris

Dokumen ini untuk operator/admin yang sudah deploy Entaris di server sendiri dan ingin menarik update dari repo ini tanpa merusak data production.

## TL;DR — Prosedur update aman

```bash
# 1. Backup dulu (WAJIB)
bash scripts/backup.sh

# 2. Pilih versi stabil, bukan main
git fetch --tags
git checkout vX.Y.Z          # lihat tag di GitHub Releases

# 3. Rebuild
docker compose build
docker compose up -d

# 4. Migrasi DB otomatis jalan via entrypoint (prisma migrate deploy)

# 5. Verifikasi
curl -fsS http://localhost:3001/health
docker compose logs -f app | head -40
```

Kalau salah satu step gagal, restore dari backup:

```bash
bash scripts/restore.sh simple_erp_YYYY-MM-DD_HHMMSS.sql.gz
```

## Versi & Semver

Repo ini mengikuti [Semantic Versioning](https://semver.org):

| Bagian | Contoh | Arti |
|---|---|---|
| **MAJOR** | `2.0.0` | Breaking change — butuh tindakan manual (baca changelog) |
| **MINOR** | `1.3.0` | Fitur baru, 100% kompatibel dengan DB lama |
| **PATCH** | `1.2.5` | Bugfix saja, aman auto-update |

Rekomendasi:
- **Production** — pin ke tag PATCH terbaru dalam MINOR yang sama
- **Staging** — ikut MINOR terbaru
- **Development** — boleh ikut `main`

## Yang TIDAK berubah saat update

- Data di database (user, transaksi, COA, invoice, payment, journal entry, dll.)
- File `.env` (tidak pernah di-commit)
- Volume upload (`uploads/`)
- `company_settings` — nama perusahaan, logo, bank account, NPWP
- Konfigurasi branding via DB (lihat _Branding Multi-Industri_ di bawah)

## Yang BISA berubah saat update

1. **Kode aplikasi** — logic server + UI client
2. **Schema DB** — via Prisma migration di `server/prisma/migrations/`
3. **Dependency library** — dari `package.json`
4. **Static asset** — logo default, favicon, template PDF
5. **Docker image** — base, runtime, entrypoint

## Checklist sebelum release MAJOR/MINOR

Kalau kamu fork repo ini dan rilis untuk user lain, pastikan:

- [ ] Semua migration **additive-only** (tambah kolom nullable, tambah tabel, tambah index)
- [ ] Jangan `DROP COLUMN` kolom yang dipakai user — pakai pola **expand → contract**:
  1. Release N: tambah kolom baru, sync dua arah di code
  2. Release N+1: migrate data dari kolom lama ke baru
  3. Release N+2 (major): baru drop kolom lama
- [ ] Rename kolom/tabel pakai `ALTER ... RENAME` (preserve data), dan update semua referensi code di PR yang sama
- [ ] Perubahan business logic akuntansi (GL posting, balance calculation) WAJIB backward-compatible — tidak boleh mengubah interpretasi transaksi historis
- [ ] Tambahkan entry di `CHANGELOG.md` + bagian _Breaking Changes_ kalau ada
- [ ] Test di staging dengan DB clone dari production sebelum tag release

## Branding Multi-Industri

Aplikasi ini didesign supaya **1 repo bisa dipakai banyak industri** tanpa fork:

| Elemen branding | Sumber | Cara ganti |
|---|---|---|
| Nama perusahaan | DB `company_settings.companyName` | Pengaturan → Perusahaan |
| Logo invoice/PDF | DB `company_settings.logoUrl` | Pengaturan → Perusahaan (upload) |
| Alamat, NPWP, kontak | DB `company_settings.*` | Pengaturan → Perusahaan |
| Info rekening bank invoice | DB `invoice_settings.sales.bankAccounts` | Pengaturan → Invoice |
| Login page (nama + logo) | API `/api/public/branding` (baca dari DB) | Otomatis dari Pengaturan → Perusahaan |
| Sidebar header | DB `company_settings.companyName` | Otomatis |
| Document title tab browser | DB `company_settings.companyName` | Otomatis |
| Favicon & PWA icon | Static di `client/public/` | Fork repo atau build image custom |
| PWA manifest name | Build-time `client/vite.config.ts` | Fork repo atau build image custom |

Yang masih perlu fork/custom build: favicon, PWA icon, PWA manifest name. Sisanya cukup set di UI Pengaturan.

## Kalau migration gagal

Migration Prisma jalan otomatis di `docker-app-entrypoint.sh` via `npx prisma migrate deploy`. Kalau gagal:

1. Container app restart-loop — cek log: `docker compose logs app`
2. Cek migration file paling akhir di `server/prisma/migrations/`
3. Kalau perlu rollback: **restore backup**, jangan edit `_prisma_migrations` manual
4. Report issue dengan log error lengkap

### Migrasi trigger jejak audit (`20261106000000_audit_trail_append_only`)

Migrasi ini hanya DDL: membuat fungsi `entaris_audit_trail_append_only()` dan dua trigger di
`audit_trail` agar baris audit tidak bisa diubah atau dihapus. Penyebab gagal yang paling mungkin:
user database aplikasi bukan pemilik tabel `audit_trail` (`CREATE TRIGGER` butuh owner). Prisma lalu
menandai migrasi gagal (P3009) dan container restart-loop.

1. Baca galatnya: `docker compose logs app`.
2. Perbaiki penyebabnya, mis. `ALTER TABLE audit_trail OWNER TO <user_aplikasi>;` sebagai superuser.
3. Tandai migrasi gagal itu sebagai dibatalkan, lalu restart agar dijalankan ulang:
   ```bash
   docker compose run --rm app sh -c "cd /app/server && npx prisma migrate resolve --rolled-back 20261106000000_audit_trail_append_only"
   docker compose restart app
   ```
4. Buka halaman Pemeriksaan Sistem: cek "Trigger database wajib" harus OK.

Kalau cek itu merah padahal migrasi sudah tercatat berhasil, restart tidak membantu
(`prisma migrate deploy` melewati migrasi yang sudah tercatat). Ikuti pesan cek itu:

- **Trigger nonaktif** (mis. setelah `ALTER TABLE audit_trail DISABLE TRIGGER ...` saat perawatan):
  aktifkan lagi tiap trigger yang disebut, sebagai pemilik tabel:
  ```sql
  ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_append_only_row;
  ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_append_only_truncate;
  ```
- **Trigger hilang** (di-drop manual): jalankan ulang SQL migrasinya. SQL itu aman diulang
  (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` lalu `CREATE TRIGGER`), jadi juga
  memulihkan trigger yang nonaktif:
  ```bash
  docker compose run --rm app sh -c "cd /app/server && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261106000000_audit_trail_append_only/migration.sql"
  ```
  Jangan pakai `migrate resolve --rolled-back` untuk kasus ini: perintah itu hanya untuk migrasi yang
  gagal.

Catatan: setelah restore cadangan lama (dibuat sebelum trigger ada), cek itu merah sampai aplikasi
dimulai ulang, karena migrasi baru berjalan lagi saat boot. Migrasi SQL lepas yang mengubah
`audit_trail` wajib menjalankan `SELECT set_config('entaris.audit_purge', 'on', true)` di awal
transaksinya sendiri (`BEGIN; ... COMMIT;`), seperti `20261003000000_scrub_ai_service_token_audit.sql`.

### Migrasi trigger buku besar (`ledger_balance_triggers`)

Migrasi ini (belum dirilis; di-gate di rencana langkah 5) hanya DDL: dua trigger tertunda yang
menolak transaksi yang membuat satu grup buku besar (`accounting_ledger_entries`, per
`reference_type` + `reference_id`) tidak seimbang atau terpecah tahun buku, dan jurnal
(`journal_entry_accounts`) yang debit dan kreditnya berbeda walau 0,01. Penolakan terjadi saat
COMMIT dan sampai ke klien sebagai 409 `LEDGER_UNBALANCED`. Penyebab gagal yang paling mungkin sama
dengan trigger jejak audit: user database aplikasi bukan pemilik tabel (`CREATE TRIGGER` butuh
owner), sehingga Prisma menandai migrasi gagal (P3009) dan container restart-loop.

1. Baca galatnya: `docker compose logs app`.
2. Perbaiki penyebabnya, mis. `ALTER TABLE accounting_ledger_entries OWNER TO <user_aplikasi>;` dan
   `ALTER TABLE journal_entry_accounts OWNER TO <user_aplikasi>;` sebagai superuser.
3. Tandai migrasi gagal itu sebagai dibatalkan, lalu restart agar dijalankan ulang:
   ```bash
   docker compose run --rm app sh -c "cd /app/server && npx prisma migrate resolve --rolled-back <folder_migrasi_trigger_buku_besar>"
   docker compose restart app
   ```
4. Buka halaman Pemeriksaan Sistem: cek "Trigger database wajib" harus OK.

Darurat (trigger menolak koreksi yang sah, dan datanya sudah diperiksa akuntan): matikan trigger
sebagai pemilik tabel, jalankan koreksinya, lalu aktifkan lagi. Cek "Trigger database wajib" merah
selama trigger nonaktif, dan itu disengaja.

```sql
ALTER TABLE accounting_ledger_entries DISABLE TRIGGER trg_ale_group_balanced;
-- koreksi data di sini
ALTER TABLE accounting_ledger_entries ENABLE TRIGGER trg_ale_group_balanced;
```

Kalau cek itu merah padahal migrasi sudah tercatat berhasil, restart tidak membantu:

- **Trigger nonaktif**: `ALTER TABLE <tabel> ENABLE TRIGGER <nama>;` untuk tiap trigger yang disebut
  pesan cek (tabel dan nama tertulis di sana).
- **Trigger hilang** (di-drop manual): jalankan ulang SQL migrasinya. SQL itu aman diulang
  (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` lalu `CREATE CONSTRAINT TRIGGER`):
  ```bash
  docker compose run --rm app sh -c "cd /app/server && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/<folder_migrasi_trigger_buku_besar>/migration.sql"
  ```

Catatan restore: cadangan dibuat dengan `pg_dump --clean --if-exists` (`services/backupService.ts`).
Restore dump yang dibuat sebelum trigger buku besar ada menghapus trigger itu dari database,
sedangkan `_prisma_migrations` ikut kembali ke keadaan dump. Cek "Trigger database wajib" merah
sampai aplikasi dimulai ulang dan `prisma migrate deploy` menjalankan migrasinya lagi saat boot.

Gerbang sebelum migrasi ini dirilis: audit buku besar harian (contoh cron:
`scripts/ops/ledger-audit-daily.sh`) harus bersih selama satu siklus rilis.

## Backup rutin

Script backup otomatis sudah disediakan:

```bash
bash scripts/setup-backup.sh    # one-time: install cron daily jam 02:00
bash scripts/backup.sh          # manual backup sekarang
bash scripts/restore.sh         # list backup tersedia
bash scripts/restore.sh <file>  # restore spesifik
```

Backup disimpan di branch `backups` repo git, max 3 file (auto-rotate).

## FAQ

**Q: Kalau saya pull dari `main` tanpa pin tag, apa risikonya?**
A: Kamu akan terima perubahan eksperimental yang belum rilis stabil. Boleh untuk staging, **hindari di production**.

**Q: Apakah data lama saya aman kalau saya update dari v1.x ke v2.x?**
A: Baca `CHANGELOG.md` bagian _Breaking Changes_. MAJOR version selalu butuh backup dulu dan kemungkinan tindakan manual.

**Q: Saya sudah customize nama perusahaan di UI Pengaturan. Kalau update, apakah hilang?**
A: Tidak. `seed.ts` pakai `upsert ... update: {}` — row existing tidak disentuh. Yang di DB tetap.

**Q: Saya fork repo ini, mau ganti favicon/PWA icon. Bagaimana cara merge update upstream tanpa konflik?**
A: Taruh asset custom di `client/public/` pakai nama berbeda (`favicon-custom.png`), lalu update `index.html` + `vite.config.ts` di fork saja. Saat merge upstream, konflik terbatas di 2 file itu.
