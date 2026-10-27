// Guard for cancelling a journal from the Journal menu (PATCH /journals/:id/cancel).
// Only hand-made journals may be cancelled there. Journals posted by a module (closing,
// depreciation, stock, deposits, GA, payment requests, guarantees) must be undone from
// that module, otherwise the source document stays "posted" while its ledger lines vanish.
// Journals in a closed fiscal year are never cancellable from the menu.

import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const MODULE_NUMBER_PREFIX = /^(CLOSE|DEP|FA)-/;
// Manual journals are numbered JV-YYYYMM-NNNN; JV-<letters>… is derived from a source document.
const DOCUMENT_NUMBER_PREFIX = /^JV-[A-Z]/;
const MODULE_NARRATION = /^(Aplikasi Uang Muka|Offset UM Vendor:|Refund UM Vendor:)/;
// Purchase-invoice price revisions use a plain JV number and no link column.
const PRICE_REVISION_NARRATION = /^Revisi harga /;

/** Returns the reason the journal cannot be cancelled from the Journal menu, or null. */
export async function journalMenuCancelBlockReason(tx: Tx, journalId: string): Promise<string | null> {
  const entry = await tx.journalEntry.findUnique({
    where: { id: journalId },
    select: {
      entryNumber: true,
      narration: true,
      fiscalYear: { select: { name: true, isClosed: true } },
      payment: { select: { id: true } },
      stockMovement: { select: { id: true } },
      depositApplication: { select: { id: true } },
      gaVehicleServiceLog: { select: { id: true } },
      gaVehicleTax: { select: { id: true } },
      gaMaterialRequest: { select: { id: true } },
      paymentRequest: { select: { id: true } },
      paymentRequestSettlement: { select: { id: true } },
      _count: { select: { depreciationEntries: true, cogsBackfillSettlements: true } },
    },
  });
  if (!entry) return null;

  if (entry.fiscalYear.isClosed) {
    return `Tahun buku ${entry.fiscalYear.name} sudah ditutup. Jurnal di tahun tertutup tidak bisa dibatalkan; buat jurnal koreksi di periode berjalan.`;
  }
  if (entry.payment) {
    return 'Jurnal ini terkait pembayaran. Batalkan dari modul Pembayaran.';
  }
  if (MODULE_NUMBER_PREFIX.test(entry.entryNumber) || DOCUMENT_NUMBER_PREFIX.test(entry.entryNumber)) {
    return 'Jurnal ini dibuat otomatis dari dokumen sumber atau tutup buku. Batalkan dari modul asalnya, bukan dari Buku Besar.';
  }
  if (PRICE_REVISION_NARRATION.test(entry.narration ?? '')) {
    return 'Jurnal ini adalah revisi harga invoice pembelian. Membatalkannya dari Buku Besar membuat nilai invoice dan persediaan tidak cocok; buat jurnal koreksi atau revisi harga baru.';
  }
  if (MODULE_NARRATION.test(entry.narration ?? '')) {
    return 'Jurnal ini dibuat dari modul Uang Muka. Batalkan aplikasinya dari modul Uang Muka; untuk refund atau offset uang muka Supplier, buat jurnal koreksi.';
  }

  const linkedToModule =
    entry.stockMovement ||
    entry.depositApplication ||
    entry.gaVehicleServiceLog ||
    entry.gaVehicleTax ||
    entry.gaMaterialRequest ||
    entry.paymentRequest ||
    entry.paymentRequestSettlement ||
    entry._count.depreciationEntries > 0 ||
    entry._count.cogsBackfillSettlements > 0;
  if (linkedToModule) {
    return 'Jurnal ini terhubung ke dokumen modul lain (stok, uang muka, aset tetap, GA, atau pengajuan dana). Batalkan dari modul asalnya.';
  }

  const [guarantees, guaranteeSettlements] = await Promise.all([
    tx.projectGuarantee.count({ where: { journalEntryId: journalId } }),
    tx.projectGuaranteeSettlement.count({ where: { journalEntryId: journalId } }),
  ]);
  if (guarantees + guaranteeSettlements > 0) {
    return 'Jurnal ini milik modul Uang Jaminan. Batalkan dari modul Uang Jaminan.';
  }

  return null;
}
