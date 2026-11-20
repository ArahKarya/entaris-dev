/**
 * Stock movements created by a source document carry that document's journal and stock effect, so
 * editing or cancelling them per row would desync stock, GL and the document. Change the document instead.
 */
export const MOVEMENT_DOCUMENT_LOCKED = 'MOVEMENT_DOCUMENT_LOCKED';
/** referenceType of the Adjustment − rows written by the item vs warehouse drift repair (PR-6.3d). */
export const STOCK_DRIFT_REFERENCE = 'StockDriftRepair';

/** Document types that write their own movements; `page` is where the document is changed. */
const DOCUMENT_LABELS: Record<string, { label: string; page: string }> = {
  GoodsReceipt: { label: 'STT', page: 'STT' },
  DeliveryOrder: { label: 'surat jalan', page: 'Surat Jalan' },
  SalesReturn: { label: 'retur penjualan', page: 'Retur Penjualan' },
  ProductionRun: { label: 'proses produksi', page: 'Produksi' },
  StockOpname: { label: 'stok opname', page: 'Stok Opname' },
  StockTransfer: { label: 'transfer stok', page: 'Transfer Stok' },
  PurchaseInvoice: { label: 'invoice pembelian', page: 'Invoice' },
  SalesInvoice: { label: 'invoice penjualan', page: 'Invoice' },
};

export interface LockableMovement {
  referenceType: string | null | undefined;
  referenceId: string | null | undefined;
  movementType: string;
}

/**
 * Why `mov` cannot be edited or cancelled per row, or null when it can. Locked:
 *  • a movement of a system document (above) that names its document (referenceId set). A manual
 *    movement whose referenceType was typed by a client (no referenceId) stays correctable;
 *  • OpeningBalance, which has no document: correct opening stock with a stock adjustment;
 *  • StockDriftRepair, the write-off of the item vs warehouse drift repair (e3-stock-drift): undoing
 *    it per row would bring the drift back; correct it with a stock adjustment;
 *  • TransferIn / TransferOut whatever their reference: only the transfer reverses both sides.
 */
export function documentMovementLockMessage(mov: LockableMovement, action: 'edit' | 'cancel'): string | null {
  if (mov.referenceType === STOCK_DRIFT_REFERENCE) {
    return action === 'edit'
      ? 'Gerakan stok perbaikan selisih gudang tidak dapat diedit per baris. Koreksi lewat Penyesuaian Stok.'
      : 'Gerakan stok perbaikan selisih gudang tidak dapat dibatalkan per baris. Koreksi lewat Penyesuaian Stok.';
  }
  if (mov.referenceType === 'OpeningBalance') {
    return action === 'edit'
      ? 'Gerakan stok saldo awal tidak dapat diedit per baris. Koreksi stok awal lewat Penyesuaian Stok.'
      : 'Gerakan stok saldo awal tidak dapat dibatalkan per baris. Koreksi stok awal lewat Penyesuaian Stok.';
  }
  const isTransfer = mov.movementType === 'TransferIn' || mov.movementType === 'TransferOut';
  const doc = isTransfer
    ? DOCUMENT_LABELS.StockTransfer
    : mov.referenceType && mov.referenceId ? DOCUMENT_LABELS[mov.referenceType] : undefined;
  if (!doc) return null;
  return action === 'edit'
    ? `Gerakan stok dari ${doc.label} tidak dapat diedit per baris. Ubah atau batalkan dokumennya dari halaman ${doc.page}.`
    : `Gerakan stok dari ${doc.label} tidak dapat dibatalkan per baris. Batalkan dokumennya dari halaman ${doc.page}.`;
}
