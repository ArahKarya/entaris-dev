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

- `set_company_get` mengembalikan record tunggal (slug `default`): nama, alamat, kontak, NPWP, mata uang (`defaultCurrency`, selalu dikembalikan `IDR`), `fiscalYearStartMonth`, logo (base64, bisa berukuran MB), dan `invoiceSettings` (rekening bank/catatan kaki/tanda tangan pada cetak faktur).
- `set_company_update` adalah UPSERT PENUH, bukan patch: field yang tidak dikirim di-reset (alamat, telepon, email, NPWP menjadi kosong; `fiscalYearStartMonth` menjadi 1; `companyName` menjadi "Perusahaan Anda" bila kosong). Selalu ambil nilai sekarang dengan `set_company_get` lalu kirim ulang seluruh nilai, kecuali mata uang: jangan kirim `currency`. `dateFormat` diterima skema tetapi tidak disimpan.
- Pembukuan hanya rupiah: mata uang perusahaan selalu disimpan IDR. `currency` tidak perlu dikirim; nilai selain `IDR` ditolak 400. Hal yang sama berlaku untuk mata uang akun (`coa_create`, `coa_update`) dan pengajuan pembayaran (`payreq_create`, `payreq_update`: "Pengajuan hanya rupiah").
- Diklasifikasikan critical karena memengaruhi dokumen berikutnya (awal tahun fiskal, NPWP, rekening bank yang tercetak di faktur) dan merupakan konfigurasi global.

### Health check (diagnostik integritas)

`hc_run` menjalankan tiga belas pemeriksaan paralel: `ALE vs JournalItem Sync` (baris ledger tiap jurnal vs baris jurnalnya, di seluruh buku; tiap temuan punya sebab: `no-ledger`, `ledger-without-journal`, `cancelled-active-ale`, `legacy-stt-pair` (STT yang dibatalkan dengan cara lama lewat jurnal `-CXL`), `draft-with-ale`, `amount-differs`; `warning` bila semua temuan `legacy-stt-pair` di tahun terbuka, menunggu skrip data STT lama, selain itu `error`), `Account Balance Drift` (`account-balance-drift`: saldo tersimpan akun vs hitungan dari item jurnal), `Unbalanced Journal Entries` (jurnal terposting dengan debit != kredit), `Orphan ALE Entries` (entri ledger yang dokumen sumbernya sudah tidak ada), `Stock vs Movement Mismatch` (stok item vs jumlah pergerakan stok), `Drift Stok per Gudang` (stok total item vs jumlah stok per gudang), `AR vs Subledger` (Piutang di Buku Besar vs sisa tagihan invoice per Customer), `Customer Deposit vs Subledger` (Uang Muka Customer di Buku Besar vs sisa uang muka per Customer; kedua cek ini hanya deteksi dan memakai saldo hari ini), `ALE vs Fiscal Year` (baris ledger sebuah jurnal yang dibukukan ke Fiscal Year selain yang memuat hari bisnis WIB-nya; hanya deteksi, tanpa kode `hc_preview` dan tanpa perbaikan; `warning` selama semua tahun terkait masih terbuka, `error` begitu ada tahun yang sudah ditutup), `Non-Journal Ledger Entries` (baris ledger bertipe dokumen seperti Sales Invoice, Purchase Invoice, atau Payment, bukan jurnal; per tipe, dengan jumlah dokumen yang juga tercatat lewat jurnal sehingga terhitung ganda; `warning`; daftar per dokumen ada di audit ledger, seksi `nonJournalAle`, dan dokumen ganda menahan tutup buku lewat cek `non-journal-ale-duplicate`), `Party Outstanding Drift` (sisa saldo tersimpan mitra vs hitungan saldo awal + invoice + jurnal manual; `warning`), dan `Required Database Triggers` (trigger append-only `audit_trail` ada dan aktif; hanya deteksi, tidak bisa diperbaiki dari aplikasi, pesannya menyebut langkah pemulihan). Status keseluruhan: `ok`, `warning`, atau `error`. `count` tiap pemeriksaan adalah jumlah temuan seluruhnya; `details` paling banyak 20 baris. Semua pemeriksaan hanya mendeteksi; koreksi selisih lewat jurnal di periode berjalan atau skrip perbaikan. Satu-satunya perbaikan otomatis adalah hitung ulang saldo akun (`account-balance-drift`): `hc_preview` (`check` = `account-balance-drift`; check lain ditolak 400) menunjukkan apa yang akan diubah. Perbaikan (`POST /health-check/fix/:check`) sengaja tidak tersedia untuk agen: ia menimpa saldo tersimpan, butuh capability `doc.cancel` (tanpa itu 403), dan ditolak sementara (400 `FIX_DRIFT_CLOSED_YEARS`) bila ada tahun buku tertutup yang punya ALE laba rugi; Admin menjalankannya setelah meninjau pratinjau. Perbaikan massal ALE (`ale-sync`, `orphan-ale`) sudah dihapus.

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
