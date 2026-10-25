# PRD: Pra-cek ID Argumen Tool Tulis AIRA/MCP

| | |
|---|---|
| Status | Draf untuk disetujui |
| Repo | `ArahKarya/entaris-dev` (private) |
| Basis kode | `main` @ `0a6e9fa` |
| Penemu | Laporan PMD v4.2.0, 25 Okt 2026 (tool `pay_record`) |
| Kelas masalah | Validasi argumen di jalur MCP terlalu longgar sebelum antrean persetujuan |

## 1. Ringkasan

Model AIRA kadang mengisi argumen berakhiran `Id` dengan teks yang diketik pengguna (nama pihak, nomor dokumen, nama akun), bukan ID hasil pencarian. Server menerima argumen itu, membuat pengajuan di antrean Persetujuan, dan menampilkan kartu konfirmasi yang tampak benar. Baru saat disetujui, handler asli menolaknya ("Data mitra tidak ditemukan"). Pengajuan kembali ke Pending, tanpa penyebab yang terlihat oleh pengguna maupun model.

Tidak ada risiko data atau GL (eksekusi selalu gagal sebelum menulis), tetapi antrean terisi pengajuan yang pasti gagal, kartu menyesatkan, dan approver membuang waktu.

## 2. Audit: bukti dan temuan

### 2.1 Kejadian nyata (DB PMD, baca-saja)
- Tabel `approval_requests`, `document_type = ai_tool:pay_record`: 2 baris, keduanya `Rejected` (14:09 dan 14:10), `args.partyId = "Hermanto"`.
- `mcp_call_logs`: 2 panggilan `pay_record` dengan keputusan `queued`.
- Tidak ada jurnal terposting. Sesuai laporan.

### 2.2 Akar masalah di kode (diverifikasi)

| # | Lokasi | Temuan |
|---|---|---|
| A | `server/src/mcp/execute.ts` `validateArgs` | Tipe `string`, `date`, `uuid`, `email` hanya dicek `typeof` string/number. Tipe `uuid` pun tidak dicek formatnya. |
| B | `aira-tool-router.json` | Param ber-ID umumnya dideklarasikan `string`, bukan `uuid` (lihat 2.3). |
| C | `server/src/mcp/queue.ts` `queueToolCall` | Pengajuan dibuat dan kartu dirender dari argumen mentah, sebelum handler asli memvalidasi. `displayArgs` hanya menerjemahkan nilai yang sudah berbentuk UUID/CUID menjadi label. Nilai lain ditampilkan apa adanya, sehingga "Hermanto" terlihat sah. |
| D | `queue.ts` `executeApprovedToolCall` | Pesan gagal dikembalikan ke pemanggil tetapi tidak disimpan di payload. Kartu Detail tidak menampilkan penyebab, dan model tidak diberi tahu. |
| E | Jalur pemanggilan | `checkDomainCall` (`mcp/callTool.ts`) dipakai bersama oleh `pratinjau_tool` dan eksekusi. Satu titik perbaikan menutup keduanya. |

### 2.3 Cakupan (dihitung dari registry, 487 tool, 263 tulis/kritis)
- 482 param ber-ID di tool tulis/kritis (termasuk field bersarang): 351 `string`, 125 `uuid`, 6 `array`.
- 112 param bersarang (mis. `allocations[].invoiceId`, `splits[].accountId`) yang tidak terjangkau cek tingkat atas.
- 275 berada di body, 207 di path. Yang di body dan bukan `uuid`: 150.
- Nama paling sering: `partyId` 15, `itemId` 11, `accountId` 11, `inventoryItemId` 9, `documentId` 8, `expenseAccountId` 7.
- `pay_record`: `partyId`, `accountId`, `allocations[].invoiceId`, `splits[].accountId`, `refundSourcePaymentId` bertipe `string`. Hanya `salesOrderId` yang `uuid`.
- Jadi masalah ini tidak khusus `pay_record`. Pola yang sama ada di puluhan tool tulis.

### 2.4 Bentuk ID nyata
- Skema Prisma: 130 model. 91 memakai UUID, 36 memakai CUID, 3 tanpa kolom `id`.
- DB PMD: `accounts`, `parties`, `sales_invoices`, `inventory_items` semuanya UUID.
- `mcp/docLabels.ts` sudah mengenal dua bentuk (`UUID`, `CUID = /^c[a-z0-9]{20,32}$/`).
- Konsekuensi: pra-cek tidak boleh memaksa UUID murni. Modul GA memakai CUID. Memaksa UUID akan salah memblokir tool GA.

### 2.5 Kemampuan pencarian ID bagi model
- Tersedia tool baca: `party_search`, `coa_flat`, `coa_list`, `gi_items`, `je_list`, dan lainnya (63 tool baca bertema pencarian/daftar).
- Faktur: `si_list` (filter `partyId`, `status`, tanggal), `si_summary` (punya `search`), `pi_list`, `pi_summary`, dan `pay_ledger` (punya `search`) sudah ada. Model dapat mencari ID faktur lewat tool tersebut; peta petunjuk lapis 1 memakai `invoiceId→si_summary/si_list` (penjualan) dan `pi_summary/pi_list` (pembelian). Diverifikasi dari registry.

## 3. Tujuan dan non-tujuan

**Tujuan**
1. Argumen ID yang jelas bukan ID ditolak sebelum masuk antrean, dengan pesan yang mengarahkan model ke tool baca yang tepat.
2. Penyebab gagal eksekusi tersimpan dan terlihat di kartu Detail Persetujuan.
3. Perilaku tool baca dan alur UI manusia tidak berubah.

**Non-tujuan**
- Tidak mengubah arsitektur MCP, RBAC, `needsApproval`, atau urutan eksekusi lewat loopback.
- Tidak mengubah tipe di registry secara massal (487 tool, mengubah katalog yang dilihat model).
- Tidak memperbaiki persona engine AIRA. Itu mitigasi sementara di luar repo, bukan pengganti.

## 4. Desain

### Lapis 1: Pra-cek bentuk ID (inti)
Di `validateArgs` (dipakai `checkDomainCall`, jadi berlaku untuk eksekusi dan `pratinjau_tool`):
- Berlaku hanya untuk tool dengan `risk !== 'read'`.
- Param dianggap ber-ID jika tipe registry `uuid`, atau nama (leaf) cocok `/(Id|Ids)$/` atau `id`. Dihitung rekursif ke `array<object>` dan `object` (`allocations[].invoiceId`).
- Nilai wajib cocok UUID atau CUID (regex bersama dengan `docLabels.ts`, dipindah ke satu util).
- Pesan galat menyebut nama param dan nilai (dipotong 40 karakter) serta petunjuk: "`partyId` harus berupa ID (UUID) hasil `party_search`, bukan nama atau nomor dokumen."
- Peta petunjuk `namaParam -> tool baca` kecil dan eksplisit: `partyId→party_search`, `accountId/cashAccountId/expenseAccountId/...→coa_flat`, `itemId/inventoryItemId→(tool item yang relevan)`, `invoiceId→` (lihat Q3).
- **Daftar pengecualian eksplisit** (param ber-nama `…Id` yang bukan ID entitas, atau memang berupa kode): disusun dari audit 482 param, disimpan sebagai data (bukan ditebak), diuji.

### Lapis 2: Pra-cek keberadaan (fase 2, opsional)
Untuk daftar kecil yang jelas pemetaannya (`partyId→Party`, `accountId→Account`, `invoiceId→SalesInvoice/PurchaseInvoice`) cek `findUnique`/`count` sebelum antre. Tool di luar daftar tidak dicek. Satu query batch dengan batas waktu pendek. Gagal-terbuka bila DB lambat, agar tidak memblok semua panggilan.

### Lapis 3: Pesan gagal terlihat
- `QueuedToolPayload` mendapat `lastError?: { message, status, at }`. Diisi saat `executeApprovedToolCall` gagal, dihapus saat sukses.
- Kartu Detail di halaman Persetujuan menampilkan `lastError`.
- Pesan galat handler diterjemahkan menjadi petunjuk bila cocok pola ("Data mitra tidak ditemukan" → "partyId tidak ditemukan; cari ID lewat party_search").

### Registry
- `pay_record`: `partyId`, `accountId`, `allocations[].invoiceId`, `splits[].accountId` ditandai `uuid` sebagai contoh. Tidak ada perubahan massal.
- Setelah itu `npm run ai-tools:docs` dan commit hasilnya (aturan repo).

## 5. Kriteria penerimaan
1. Tool tulis dengan `partyId = "Hermanto"` ditolak 400 sebelum antre. Tidak ada baris `approval_requests` baru. Tidak ada notifikasi admin.
2. `invoiceId = "SI-202610-0053"` di dalam `allocations[]` ditolak dengan petunjuk.
3. UUID dan CUID yang valid lolos. UUID palsu berbentuk benar tetap diterima lapis 1 (ditangani lapis 2).
4. Tool baca dengan argumen bebas (mis. `party_search search="Hermanto"`) tidak terpengaruh.
5. Tool GA (CUID) tidak terblokir.
6. Gagal eksekusi menyimpan `lastError` dan kartu Detail menampilkannya.
7. `pratinjau_tool` memberi hasil penolakan yang sama.
8. Suite tes server lulus. `ai-tools:check`, lint, dan `tsc` lulus.

## 6. Tes
- Unit `validateArgs`: nama, nomor dokumen, kosong, UUID, CUID, angka, array berisi ID, objek bersarang, tool baca, pengecualian.
- Unit `queueToolCall`: argumen tidak valid tidak membuat `ApprovalRequest`.
- Integrasi `callTool`: `pay_record` dengan nama pihak ditolak, dengan UUID diantre.
- Unit `executeApprovedToolCall`: gagal → `lastError` terisi.
- Klien: kartu Detail merender `lastError`.
- Regresi: seluruh tes `mcp/__tests__` yang ada.

## 7. Rencana kerja dan rilis
1. Audit pengecualian: keluarkan daftar 482 param, tandai yang bukan ID entitas (tinjau manual).
2. Tes dulu (merah), lalu lapis 1.
3. Lapis 3 (+ UI kartu).
4. Registry `pay_record` + `ai-tools:docs`.
5. PR ke `entaris-dev`, uji di demo RPi5 lewat panel `/aira` (alur sama dengan laporan: pembayaran atas nama pelanggan).
6. Lapis 2 sebagai PR kedua.
7. Teruskan ke repo publik `ENTARIS` dan rilis patch 4.2.1 (backup pra-update, deploy KSO dan PMD).

## 8. Risiko
| Risiko | Mitigasi |
|---|---|
| Salah blok param yang sah (kode, bukan ID) | Daftar pengecualian dari audit, diuji. Fail-safe: bila ragu, lolos dan ditangani handler. |
| Model terus mengulang argumen salah | Pesan galat mengarahkan ke tool baca. Tidak ada retry otomatis. |
| Lapis 2 menambah beban DB | Daftar kecil, satu query batch, batas waktu, gagal-terbuka. |
| Perubahan pesan tampil mengubah snapshot tes | Perbarui tes terkait. |

## 9. Pertanyaan terbuka
- **Q1.** Pengecualian: apakah ada param `…Id` yang memang berupa kode (mis. nomor akun "1.1.5")? Dijawab oleh audit tahap 1.
- **Q2.** Lapis 2 masuk rilis yang sama atau menyusul? Rekomendasi: menyusul.
- **Q3.** `si_list` tidak punya filter `search` bernomor dokumen (hanya `si_summary`). Apakah param `search` ditambahkan ke `si_list` agar model bisa mencari faktur dari nomor `SI-…` dengan satu tool, atau cukup `si_summary`?
- **Q4.** Apakah pesan galat dibuat dua bahasa atau cukup Indonesia (UI saat ini Indonesia)?
- **Q5.** Perlu menambah mitigasi di sisi persona engine (sudah ada) untuk tenant lain (KSO)?
