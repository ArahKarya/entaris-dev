Toolset **persediaan** memberi AIRA kemampuan membaca dan (dengan persetujuan) mengubah data stok: master item, gudang, kartu stok (pergerakan stok), transfer antar gudang, stok opname, serta dashboard persediaan. Semua pembacaan aman dipanggil otomatis; setiap tool yang mengubah stok atau jurnal diklasifikasikan `critical` karena efeknya langsung (tidak ada tahap draft pada pergerakan stok, transfer, maupun opname).

### Alur bisnis

Persediaan dicatat di tiga lapis:

| Lapis | Tabel (konsep) | Isi |
|-------|----------------|-----|
| Master item | `InventoryItem` | kode, nama, satuan, kategori, `minimumStock`, `averageCost` (WAC/HPP), `currentStock` (total semua gudang, denormalisasi), `accountId` (akun persediaan, kosong = 1.4.0) |
| Saldo per gudang | `InventoryStock` (item x gudang) | `currentStock` per gudang. Biaya (WAC) tetap satu angka per item untuk semua gudang. |
| Kartu stok | `StockMovement` (nomor `SM-...`) | tiap perubahan stok: jenis `In`, `Out`, `AdjustmentIn`, `AdjustmentOut`, `TransferIn`, `TransferOut`; `quantity`, `unitCost`, `totalValue`, `referenceType/Id` (dokumen asal), `isCancelled`, `journalEntryId` |

Sumber pergerakan stok (siapa yang menghasilkan SM):

1. **Pembelian**: STT/BPB (penerimaan barang) = stok masuk + akrual hutang; PI standalone = stok masuk + hutang (lihat toolset pembelian).
2. **Penjualan**: Surat Jalan (DO) / Invoice penjualan = stok keluar (HPP/COGS memakai `unitCost` yang terkunci).
3. **Produksi**: `ProductionRun` = bahan input keluar, produk output masuk (lihat toolset produksi).
4. **Manual** (`inv_mov_create`): stok awal, koreksi, pemakaian lain.
5. **Transfer antar gudang** (`stf_create`): `TransferOut` + `TransferIn` berpasangan.
6. **Stok opname** (`opn_system_stock` lalu `opn_create`): penyesuaian selisih fisik vs stok sistem per tanggal opname, satu gudang per sesi.

Pergerakan yang lahir dari dokumen lain (STT/GoodsReceipt, ProductionRun) **tidak boleh diedit/dibatalkan per baris** lewat `inv_mov_update` / `inv_mov_cancel`; koreksi dilakukan di dokumen sumbernya.

Status dokumen:
- **Transfer stok**: `Submitted` (langsung saat dibuat) -> `Cancelled`. Enum `DocumentStatus` memang punya `Draft`, tetapi API tidak membuat draft transfer.
- **Stok opname**: `Submitted` (langsung final saat dibuat) -> `Cancelled`. `Draft` ada di enum, tetapi pembuatan lewat API sekali jalan; bila ada sesi `Draft` lama, pembuatan baru ditolak.
- **Pergerakan stok**: aktif atau `isCancelled=true` (tidak ada status Draft).
- **Gudang/Item**: `isActive` true/false; gudang punya satu `isDefault`.

### Aturan posting

Kunci ringkas: **stok bergerak = SM**, **jurnal hanya bila ada nilai uang yang berpindah akun**.

| Tool | Efek stok | Efek GL | Efek WAC |
|------|-----------|---------|----------|
| `inv_mov_create` In/AdjustmentIn | + qty (gudang & total) | DR Persediaan (akun item / 1.4.0) / CR akun lawan (wajib); `unitCost` wajib > 0 (`MANUAL_IN_ZERO_COST`), akun lawan wajib (`OFFSET_REQUIRED`) | dihitung ulang: `(stok x WAC lama + qty x unitCost) / (stok + qty)` |
| `inv_mov_create` Out/AdjustmentOut | - qty (ditolak `STOCK_INSUFFICIENT` bila stok gudang < qty) | DR akun lawan (default Selisih Persediaan, role `INVENTORY_VARIANCE`) / CR Persediaan sebesar qty x WAC item; `unitCost` dari input diabaikan | tidak berubah |
| `inv_mov_update` | batal lama + buat baru | jurnal lama dibatalkan, jurnal baru diposting | baris lama dibalik persis sebesar nilainya di buku nilai, baris baru diposting; rata-rata mengikuti nilai buku, COGS backfill diselesaikan ulang |
| `inv_mov_cancel` | dibalik | jurnal terkait Cancelled, saldo akun dikurangi per baris jurnal | baris dibalik persis sebesar nilainya di buku nilai; rata-rata mengikuti nilai buku, COGS backfill dibalik |
| `stf_create` | - qty gudang asal, + qty gudang tujuan; total item tetap | **tidak ada** (akun persediaan sama, net nol) | tidak berubah |
| `stf_cancel` | dibalik | tidak ada | tidak berubah |
| `opn_create` | disesuaikan = stok aktual - stok sistem gudang per tanggal opname, bertanggal opname | lewat jalur posting bersama (`JV-<nomor opname>`, sumber Dokumen sistem): surplus DR Persediaan / CR Selisih Persediaan (role `INVENTORY_VARIANCE`, wajib akun rinci tersendiri) sebesar qty x rata-rata; defisit DR Selisih Persediaan / CR Persediaan sebesar nilai dari buku nilai persediaan | surplus ikut rata-rata; tidak ada revaluasi lewat opname (`unitCost` ditolak) |
| `opn_cancel` | dibalik | jurnal `JV-<nomor opname>` Cancelled; bila barang item sudah keluar sejak opname, jurnal koreksi nilai DR/CR Persediaan lawan HPP bertanggal hari pembatalan | semua baris opname dibalik persis sebesar nilainya, lalu koreksi nilai (true-up) dan sapu sisa nilai saat stok 0 ke HPP; `OPNAME_LEGACY_REVALUATION` untuk opname lama yang revaluasinya dijurnal tanpa baris `Revaluation` |

Aturan wajib:
- Setiap jurnal harus seimbang (debit = kredit); sistem menjaga ini, AIRA tidak perlu menghitung manual.
- Tanggal transaksi harus jatuh di **tahun fiskal yang belum ditutup** (jika tidak: 400 "Tidak ada tahun fiskal aktif").
- Nilai uang dibulatkan 2 desimal; kuantitas sampai 3 desimal.
- Akun sistem 1.4.0 (Persediaan Umum) dan 3.1 (Ekuitas Saldo Awal) tidak boleh diubah (lihat CLAUDE.md).

### Persetujuan

- Modul persediaan **tidak** memakai antrian `ApprovalRequest` (`needsApproval`) untuk pergerakan manual, transfer, maupun opname; keamanannya lewat izin RBAC modul (`inventory`, `stock_transfer`, `stock_opname`) dan capability.
- Capability yang relevan: `doc.cancel` (wajib untuk `inv_mov_cancel`, `opn_cancel`, `wh_delete`), `inventory.negative_stock` (izin melewati validasi stok minus; dipakai di produksi/penjualan, bukan di pergerakan manual).
- Pada rancangan AIRA: semua tool `critical` di toolset ini berstatus **Wajib-Approve** (manusia mengonfirmasi sebelum dieksekusi), tool `write` (master) berstatus Draft/Approve, tool `read` otomatis.
- Peringatan konsistensi: `stf_cancel` hanya butuh izin edit `stock_transfer` (tanpa `doc.cancel`) dan tidak mengecek stok gudang tujuan; manusia sebaiknya meninjau.

### Jebakan umum

1. **Stok total vs per gudang**. `inv_items_list` tanpa `warehouseId` menampilkan total semua gudang; dengan `warehouseId` menampilkan saldo gudang itu (0 bila tak ada baris). Jangan menjumlah ulang sendiri.
2. **Harga stok masuk dan keluar**. Stok masuk manual (`In`, `AdjustmentIn`, termasuk "barang ditemukan") wajib `unitCost` > 0 (`MANUAL_IN_ZERO_COST`). Stok keluar (`Out`, `AdjustmentOut`) selalu dinilai dari nilai persediaan item saat disimpan (bagian nilai sebanding qty, sisa penuh bila stok habis); `unitCost` yang dikirim diabaikan, jadi jangan menjanjikan nilai lain kepada user. Stok awal diisi lewat impor stok awal dan dijurnal sebesar nilai yang sama.
3. **Akun lawan**. Stok masuk wajib `offsetAccountId` (`OFFSET_REQUIRED`); tidak ada lagi default Ekuitas Saldo Awal 3.1. Stok keluar tanpa akun lawan dibukukan ke akun Selisih Persediaan (role `INVENTORY_VARIANCE`); selama role itu dipetakan ke akun grup atau ke akun yang sama dengan akun Pembulatan, sistem menolak (`INVENTORY_VARIANCE_UNSAFE`) dan Pemeriksaan Sistem memberi peringatan "Akun Selisih Persediaan tersendiri". Akun lawan yang ditolak: 3.1 Ekuitas Saldo Awal, akun kontrol (piutang, hutang, uang muka, persediaan, hutang belum ditagih), akun pajak, akun grup, akun nonaktif, dan akun di kelompok persediaan (`STOCK_OFFSET_INVENTORY`).
4. **Edit = batal + buat ulang**. `inv_mov_update` bukan edit draft; pergerakan lama dibatalkan, pergerakan baru bernomor SM baru (id baru di respons), dan jurnal lama berstatus Cancelled. Edit atau batal stok masuk manual ditolak 409 `REVERSAL_NEEDS_TRUE_UP` bila barang item itu sudah keluar sesudahnya: nilai persediaan perlu dikoreksi akuntan, koreksi otomatis untuk mutasi manual belum tersedia. Pembatalan dokumen (`gr_cancel`, `do_cancel`, `sret_cancel`, `si_cancel`, `pi_cancel`) mengoreksi nilainya otomatis (true-up): satu jurnal per gerakan yang dibalik, bertanggal hari pembatalan (periodenya harus terbuka), Persediaan item lawan COGS; sisa nilai saat stok jadi 0 ikut disapu ke COGS.
5. **Transfer langsung berlaku**. `stf_create` tidak punya draft; kesalahan harus diperbaiki dengan `stf_cancel` lalu buat ulang. `stf_update` hanya mengubah metadata cetak (mobil, supir, penerima, catatan).
6. **Opname langsung final, hanya baris yang diubah**. `opn_create` memposting penyesuaian dan jurnal saat itu juga. Gudang wajib. Ambil stok sistem per tanggal lewat `opn_system_stock` tepat sebelum posting, lalu kirim hanya baris yang diubah dengan `expectedSystemStock` = angka itu. Bila stok berubah sejak diambil, `opn_create` ditolak `409 OPNAME_STOCK_CHANGED` dengan daftar barisnya: ambil ulang dan periksa lagi, jangan menebak. Stok aktual negatif ditolak.
7. **Opname bukan revaluasi**. `unitCost` pada baris opname ditolak (400); penurunan nilai persediaan akan menjadi dokumen tersendiri. Opname bertanggal mundur membandingkan stok per tanggal itu (STT sesudahnya tidak mengganggu), tetapi defisitnya diambil dari stok gudang saat ini.
8. **Pembatalan butuh stok di gudangnya**. `inv_mov_cancel`/`inv_mov_update` untuk pergerakan masuk, `opn_cancel` untuk surplus, dan `gr_cancel` ditolak (`STOCK_INSUFFICIENT` / `GR_CANCEL_INSUFFICIENT_STOCK`) bila stok **di gudang mutasi itu** tidak cukup untuk dibalik; stok di gudang lain tidak dihitung. Baris item yang sama dalam satu dokumen dijumlah (juga di `stf_create`). Mutasi lama tanpa gudang dicek terhadap total item.
9. **Stok sedang diproses (`STOCK_BUSY`, 409)**. Transaksi stok atas item yang sama berjalan berurutan; bila menunggu lebih dari 5 detik, permintaan ditolak tanpa perubahan apa pun. Ulangi sebentar lagi, jangan ubah isinya.
10. **Hapus master**. `inv_item_delete` menghapus permanen item + pergerakan batalnya, dan ditolak bila ada mutasi aktif/dipakai invoice. `wh_delete` ditolak untuk gudang default/bersaldo/berriwayat; nonaktifkan saja (`wh_update isActive=false`).
11. **Batch**. `inv_item_batches` hanya melacak pemakaian yang tertaut `sourceMovementId`; jumlah sisa batch tidak selalu sama dengan stok fisik.
12. **Data referensi terbuka**. GET items, gudang tidak butuh izin khusus (semua user login boleh membaca) sehingga tool `read` untuk master tersedia bagi semua role; hanya penulisan butuh `edit`.
13. **Stok minus** (hasil penjualan/produksi dengan bypass) dipantau di dashboard "Stok Minus Aktif"; COGS penjualan yang tertunda diselesaikan otomatis (COGS backfill) ketika stok masuk berikutnya tercatat.

### Peta istilah

| Istilah bisnis | Padanan sistem |
|----------------|----------------|
| Barang / item / bahan / produk | `InventoryItem` (kode, nama, satuan) |
| Gudang | `Warehouse` (kode, `isDefault`) |
| Kartu stok / mutasi stok | `StockMovement` (nomor `SM-...`) |
| Stok masuk / keluar | movementType `In` / `Out` |
| Penyesuaian stok | `AdjustmentIn` / `AdjustmentOut` |
| Transfer / mutasi antar gudang / SJG (Surat Jalan Antar Gudang) | `StockTransfer` (`TransferOut` + `TransferIn`) |
| Stok opname / hitung fisik | `StockOpname` (nomor `SO-...`; jangan tertukar dengan Sales Order) |
| Selisih opname | `difference` = stok aktual - stok sistem per tanggal opname; akun Selisih Persediaan (6.38) |
| HPP / harga pokok rata-rata / WAC | `averageCost` (Weighted Average Cost, satu angka per item) |
| Nilai persediaan | stok x `averageCost` |
| Stok minimum / stok rendah | `minimumStock`; status stok `low` / `out` / `ok` |
| Batch / lot | pergerakan masuk aktif + sisa tersedia (`inv_item_batches`) |
| Akun persediaan umum | 1.4.0 |
| Tahun fiskal terbuka | `FiscalYear.isClosed=false` yang mencakup tanggal transaksi |
| Bypass stok minus | capability `inventory.negative_stock` |
