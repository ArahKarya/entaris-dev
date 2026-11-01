Toolset **sistem** memuat fungsi pendukung yang aman diakses agen: Jejak Audit, notifikasi pribadi, pencarian universal, profil perusahaan, diagnostik integritas data (health check), dan metadata lampiran. Hampir semuanya read-only. Fungsi administratif yang berbahaya (login, user/role, backup, reset data, konfigurasi AI/Telegram, unggah berkas) sengaja TIDAK tersedia sebagai tool; lihat bagian "Yang sengaja tidak dibuka" dan `DENYLIST.md`.

### Peta tool

| Kebutuhan | Tool | Risiko | Izin |
|---|---|---|---|
| Siapa mengubah apa dan kapan | `audit_list`, `audit_get`, `audit_summary`, `audit_facets` | read | modul `audit` (view; default Admin) |
| Notifikasi saya | `notif_list`, `notif_types`, `notif_unread_count` | read | semua user login (milik sendiri) |
| Tandai notifikasi dibaca | `notif_read`, `notif_read_all` | write | semua user login (milik sendiri) |
| Cari dokumen/mitra/akun | `search_global` | read | semua user login, hasil difilter izin |
| Profil perusahaan | `set_company_get` | read | semua user login |
| Ubah profil perusahaan | `set_company_update` | critical | modul `settings` (edit; default Admin) |
| Cek integritas data | `hc_run`, `hc_preview` | read | modul `audit` (view; default Admin) |
| Metadata lampiran dokumen | `att_list`, `att_counts`, `att_invoice_related` | read | semua user login |

### Jejak Audit

- Middleware `auditTrail` mencatat otomatis mutasi (`POST`, `PUT`, `PATCH`, `DELETE`) dari user yang login yang BERHASIL (status 2xx) dan dijawab dengan JSON; baris audit ditulis sebelum respons dikirim. Percobaan yang ditolak (4xx) atau gagal (5xx) tidak tercatat. Bila penulisan baris audit gagal, transaksinya tetap berhasil dan kegagalan dicatat di log server dengan request id. Reset data dan restore backup hanya dicatat di log server (beserta nama cadangan pengamannya), bukan di jejak audit. Baris audit tidak bisa diubah atau dihapus (trigger database). Satu baris berisi: `userId` (+ nama/email), `action` (`CREATE` untuk POST, `UPDATE` untuk PUT/PATCH, `DELETE`), `entityType` (segmen pertama URL, mis. `sales`, `purchase`, `payments`, `payment-requests`), `entityId` (id dari respons, atau dari snapshot sebelum perubahan, atau `N/A`), `oldValues` (snapshot sebelum perubahan untuk dokumen/master terdaftar), `newValues` (isi respons), `ipAddress`, `userAgent`, `createdAt`.
- Nilai rahasia (password, token, service token, bot token, dsb.) di-redact menjadi `[REDACTED]` sebelum disimpan.
- `audit_list` memfilter `userId`, `action`, `entityType`, `search` (ID entitas), `startDate`/`endDate`; paging default 50, maks. 200; urut terbaru. `audit_facets` memberi pilihan nilai filter; `audit_summary` menghitung per aksi dengan filter yang sama.
- Pembacaan (GET) tidak dicatat. Aksi AIRA lewat tool juga tercatat sebagai mutasi biasa pada user yang diwakili.
- Karena `entityType` berasal dari URL, penelusuran dokumen tertentu paling mudah dengan `search=<id dokumen>`.

### Notifikasi

- Notifikasi bersifat per user; tool hanya menyentuh milik pemanggil.
- Jenis yang dibuat sistem antara lain `invoice_overdue` (faktur jatuh tempo), `low_stock` (stok di bawah minimum), `guarantee_due` (jaminan proyek jatuh tempo), `po_overdue` (PO melewati tanggal kirim). Pemeriksaan harian berjalan 07:00 WIB lewat scheduler dengan dedup 24 jam; pemicu manual `POST /notifications/check` tidak dibuka sebagai tool.
- `notif_list` tanpa parameter = 50 terbaru + `unreadCount`; dengan `page/limit/isRead/type/search` = daftar berpaging (default 25, maks. 100).
- `notif_read` dan `notif_read_all` hanya membalik flag `isRead`; tidak ada efek GL/stok. Dua tool ini tetap risk write agar tercatat di audit dan tunduk pada kebijakan tier.

### Pencarian universal (`search_global`)

- Minimal 2 karakter (kurang dari itu = hasil kosong). `limit` default 10, maks. 20 per jenis.
- Selalu mencari mitra dan akun COA; faktur penjualan (no. faktur/catatan), faktur pembelian, pembayaran, dan jurnal hanya jika pemanggil punya izin view modulnya (`sales_invoice`, `purchase_invoice`, `payment`, `journal`). Pengecekan gagal = jenis itu dikosongkan (fail-closed).
- Gunakan sebagai langkah pertama untuk menerjemahkan nama/nomor yang disebut user menjadi ID, lalu panggil tool detail.

### Profil perusahaan

- `set_company_get` mengembalikan record tunggal (slug `default`): nama, alamat, kontak, NPWP, mata uang, `fiscalYearStartMonth`, logo (base64, bisa berukuran MB), dan `invoiceSettings` (rekening bank/catatan kaki/tanda tangan pada cetak faktur).
- `set_company_update` adalah UPSERT PENUH, bukan patch: field yang tidak dikirim di-reset (alamat, telepon, email, NPWP menjadi kosong; `fiscalYearStartMonth` menjadi 1; mata uang menjadi IDR; `companyName` menjadi "Perusahaan Anda" bila kosong). Selalu ambil nilai sekarang dengan `set_company_get` lalu kirim ulang seluruh nilai. `dateFormat` diterima skema tetapi tidak disimpan.
- Diklasifikasikan critical karena memengaruhi dokumen berikutnya (mata uang, awal tahun fiskal, NPWP, rekening bank yang tercetak di faktur) dan merupakan konfigurasi global.

### Health check (diagnostik integritas)

`hc_run` menjalankan sembilan pemeriksaan paralel: `ALE vs JournalItem Sync` (kode preview `ale-sync`), `Account Balance Drift` (`account-balance-drift`: saldo tersimpan akun vs hitungan dari item jurnal), `Unbalanced Journal Entries` (jurnal terposting dengan debit != kredit), `Orphan ALE Entries` (`orphan-ale`: entri ledger yang dokumen sumbernya sudah tidak ada), `Stock vs Movement Mismatch` (stok item vs jumlah pergerakan stok), `Drift Stok per Gudang` (stok total item vs jumlah stok per gudang), `AR vs Subledger` (Piutang di Buku Besar vs sisa tagihan invoice per Customer), `Customer Deposit vs Subledger` (Uang Muka Customer di Buku Besar vs sisa uang muka per Customer; kedua cek ini hanya deteksi dan memakai saldo hari ini), dan `Required Database Triggers` (trigger append-only `audit_trail` ada dan aktif; hanya deteksi, tidak bisa diperbaiki dari aplikasi, pesannya menyebut langkah pemulihan). Status keseluruhan: `ok`, `warning`, atau `error`. `hc_preview` (`check` = `ale-sync`, `account-balance-drift`, `orphan-ale`) menunjukkan apa yang akan diubah perbaikan otomatis. Perbaikan (`POST /health-check/fix/:check`) sengaja tidak tersedia untuk agen: ia memutasi data massal tanpa dokumen sumber dan harus dijalankan Admin setelah meninjau pratinjau. Perbaikan `ale-sync` dan `orphan-ale` saat ini dinonaktifkan di aplikasi (selalu ditolak 400) karena bisa mengubah buku besar tahun yang sudah ditutup; selisihnya dikoreksi lewat jurnal di periode berjalan.

### Lampiran (metadata saja)

- `att_list(referenceType, referenceId)`: metadata berkas yang melekat pada satu dokumen. Jenis referensi yang diizinkan saat unggah: `payment`, `journal`, `purchase_invoice`, `sales_invoice`, `sales_order`, `delivery_order`, `goods_receipt`, `approval_request`, dan beberapa lainnya.
- `att_counts`: jumlah lampiran per daftar ID (POST hanya karena membawa array; tidak mengubah data, di katalog `safeNonGet`).
- `att_invoice_related(type=sales|purchase, id)`: lampiran faktur + bukti pembayaran/deposit yang dialokasikan ke faktur itu.
- Unggah, unduh isi berkas, dan hapus lampiran tidak tersedia sebagai tool (berkas biner). Respons metadata juga memuat path internal berkas; abaikan, jangan diteruskan ke pengguna akhir.

### Yang sengaja tidak dibuka

Autentikasi (`/api/auth/*`), administrasi user dan role (`/api/users`, `/api/roles`), backup/restore, reset & data dummy, impor massal, konfigurasi AIRA/Telegram, endpoint publik (QR aset, formulir inquiry), unggah/unduh berkas, probe `/health` dan `/api/version`, `GET /api/settings/runtime` (info server), `GET /api/settings/check-update` (menjalankan git fetch), ekspor `.xlsx`, dan pemicu job notifikasi. Alasan tiap entri ada di `DENYLIST.md`.

### Jebakan umum

- Jejak audit memuat `oldValues`/`newValues` yang bisa berisi data sensitif (nama, email, nilai transaksi). Ringkas, jangan menempelkan seluruh JSON ke chat grup.
- `audit_*` dan `hc_*` default hanya untuk Admin; Accountant mendapat 403 kecuali izin `audit` diberikan.
- `att_list` tidak memeriksa izin per jenis dokumen (semua user login boleh membaca metadata) sehingga hormati kebijakan data-access AIRA pada lapisan atas.
- `set_company_update` tanpa membaca nilai lama akan menghapus data profil (lihat di atas).

### Peta istilah

| Istilah Indonesia | Istilah kode/sistem |
|---|---|
| Jejak Audit | `AuditLog` / tabel `audit_trail` |
| Notifikasi | `Notification` |
| Profil perusahaan | `CompanySettings` (slug `default`) |
| Tahun fiskal | `fiscalYearStartMonth` |
| Lampiran | `TransactionAttachment` |
| Cek kesehatan data | health check (`/api/health-check`) |
| ALE | `AccountingLedgerEntry` (entri buku besar) |
