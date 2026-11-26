import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { assertStockAvailable, lockInventoryRows } from './inventory/stockLocks';
import { assertPeriodsOpen } from '../utils/periodGuard';
import { logger } from '../lib/logger';
import { reverseDocumentMovements } from './inventory/inventoryLedger';
import { postReversalValueJournals } from './inventory/reversalValueJournal';
import { cancelJournalsInTx, findDocumentJournals } from './ledger/cancelJournals';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';

/** Error code: reversal would drive stock negative; the client offers a forced cancel. */
export const GOODS_RECEIPT_CANCEL_INSUFFICIENT_STOCK = 'GR_CANCEL_INSUFFICIENT_STOCK';
/** Error code: a line of the STT is still billed by a purchase invoice that is not cancelled. */
export const GR_LINE_INVOICED = 'GR_LINE_INVOICED';

type Tx = Prisma.TransactionClient;

interface CancelOptions {
  /** Skip the "enough stock to reverse" guard (the route requires a negativeStockReason). */
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
  /** Optional cancel reason, stored with the user on the STT and its original journal. */
  reason?: string | null;
}

/**
 * Cancel an STT. Rejected for legacy backfill STTs (cancel the PI instead) and while any of its
 * lines is billed by a purchase invoice that is not cancelled (cancel it first; not auto-cancelled
 * because of payment side effects). Reverses its stock movements through the value ledger, voids
 * the STT journal (it and its ledger entries are cancelled and the balances reversed per line; no
 * `-CXL` journal) and decrements PO qtyReceived.
 */
export async function cancelGoodsReceiptInTx(
  tx: Tx,
  sttId: string,
  userId: string,
  opts: CancelOptions = {},
) {
  const stt = await tx.goodsReceipt.findUnique({
    where: { id: sttId },
    include: {
      items: { include: { stockMovement: true } },
    },
  });
  if (!stt) throw new BusinessError('STT tidak ditemukan.');
  if (stt.status === 'Cancelled') throw new BusinessError('STT sudah dibatalkan.');
  // First write: a second concurrent cancel gets STALE_STATUS here instead of reversing the stock,
  // the PO qtyReceived and the journal a second time. Any later rejection rolls the claim back.
  const trail = cancelTrail(userId, opts.reason);
  await claimCancel(tx.goodsReceipt, stt.id, { status: 'Cancelled', cancelledAt: new Date(), ...trail });
  // Re-read the PI link under the claim's row lock: a PI submit that linked this STT after the
  // read above (the claim waited for it) must block the cancel like any other linked PI.
  const { invoice } = await tx.goodsReceipt.findUniqueOrThrow({
    where: { id: stt.id },
    select: { invoice: { select: { invoiceNumber: true, status: true } } },
  });
  // The cancel voids the STT's own journal, so the STT's date and stored fiscal year must be open
  // (the journal's own year is checked again when it is voided).
  await assertPeriodsOpen(tx, [{ date: stt.date }, { fiscalYearId: stt.fiscalYearId, date: stt.date }], 'penerimaan barang');

  if (stt.isLegacyBackfill) {
    throw new BusinessError(
      'STT ini adalah backfill otomatis dari PI lama. Untuk membatalkan, batalkan invoice pembelian asal.',
    );
  }

  // Block if PI linked & paid
  if (invoice) {
    if (invoice.status === 'Paid' || invoice.status === 'PartiallyPaid') {
      throw new BusinessError(
        `STT ${stt.sttNumber} terkait invoice ${invoice.invoiceNumber} yang sudah ada pembayaran. ` +
          'Untuk membatalkan STT, batalkan dulu pembayaran + invoice.',
      );
    }
    if (invoice.status === 'Submitted') {
      throw new BusinessError(
        `STT ${stt.sttNumber} terkait invoice ${invoice.invoiceNumber} (Submitted, belum dibayar). ` +
          'Batalkan invoice tersebut dulu.',
      );
    }
  }
  // The header link above names only the first invoice and is cleared when that invoice is
  // cancelled, so check every line: another invoice may still bill one of them (G-19).
  const billed = await tx.purchaseInvoiceItem.findFirst({
    where: { goodsReceiptItem: { goodsReceiptId: stt.id }, purchaseInvoice: { status: { not: 'Cancelled' } } },
    select: { purchaseInvoice: { select: { invoiceNumber: true, status: true } } },
  });
  if (billed) {
    throw new BusinessError(
      `STT ${stt.sttNumber} masih ditagih di invoice pembelian ${billed.purchaseInvoice.invoiceNumber} (${billed.purchaseInvoice.status}). ` +
        'Batalkan invoice tersebut dulu.',
      GR_LINE_INVOICED,
    );
  }

  // Block when an outbound movement already consumes one of these batches (sourceMovementId);
  // cancelling would orphan its cost basis.
  const batchMovementIds = stt.items
    .map((it) => it.stockMovement?.id)
    .filter((id): id is string => !!id);
  if (batchMovementIds.length > 0) {
    const consumers = await tx.stockMovement.findMany({
      where: { sourceMovementId: { in: batchMovementIds }, isCancelled: false },
      select: { movementNumber: true, referenceType: true, referenceNumber: true },
      take: 5,
    });
    if (consumers.length > 0) {
      const ref = consumers
        .map((c) => c.referenceNumber || c.movementNumber)
        .join(', ');
      throw new BusinessError(
        `Tidak dapat membatalkan STT ${stt.sttNumber}: barang dari penerimaan ini sudah dipakai di transaksi lain (${ref}). ` +
          'Batalkan transaksi tersebut terlebih dahulu.',
      );
    }
  }

  // Lock the items, then check the reversal per (item, warehouse of the movement), lines of one
  // item summed. allowNegativeStock logs the shortage instead of throwing.
  const activeMovements = stt.items
    .map((it) => it.stockMovement)
    .filter((sm): sm is NonNullable<typeof sm> => !!sm && !sm.isCancelled);
  await lockInventoryRows(tx, {
    itemIds: activeMovements.map((sm) => sm.itemId),
    pairs: activeMovements.flatMap((sm) => (sm.warehouseId ? [{ itemId: sm.itemId, warehouseId: sm.warehouseId }] : [])),
  });
  await assertStockAvailable(
    tx,
    activeMovements.map((sm) => ({ itemId: sm.itemId, warehouseId: sm.warehouseId, quantity: sm.quantity.toString() })),
    {
      context: 'goodsReceipt.cancel',
      userId,
      allowNegative: opts.allowNegativeStock,
      reason: opts.negativeStockReason,
      error: (s) => new BusinessError(
        `Tidak dapat membatalkan STT ${stt.sttNumber}: stok '${s.itemName}' di ${s.warehouseName ?? 'semua gudang'} tidak mencukupi untuk pembalikan (tersedia ${s.available.toNumber()}, perlu ${s.needed.toNumber()}). ` +
          'Barang sudah keluar (terjual/produksi). Batalkan transaksi tersebut dulu.',
        GOODS_RECEIPT_CANCEL_INSUFFICIENT_STOCK,
      ),
    },
  );

  // Every row the STT owns comes back at its own value_delta (the locked cost the STT journal
  // debited, also for a legacy row whose total_value a purchase invoice overwrote); the journal
  // voided below carries the same amounts. When goods of the item went out since, the value they
  // took differently comes back as a true-up against COGS, and value left at zero stock is swept to
  // COGS (E3-R8), journalled before the STT journal is voided (lock order): book = GL.
  const reversed = await reverseDocumentMovements(
    tx, { referenceType: 'GoodsReceipt', referenceId: stt.id }, { userId, trueUp: 'replay', sweepAtZero: true },
  );
  await postReversalValueJournals(tx, reversed, { userId, documentLabel: `STT ${stt.sttNumber}` });

  for (const grItem of stt.items) {
    const sm = grItem.stockMovement;
    if (!sm || sm.isCancelled || !grItem.purchaseOrderItemId) continue;
    await tx.purchaseOrderItem.update({
      where: { id: grItem.purchaseOrderItemId },
      data: { qtyReceived: { decrement: Number(sm.quantity) } },
    });
  }

  const journals = await findDocumentJournals(tx, `JV-${stt.sttNumber}`);
  const voided = await cancelJournalsInTx(tx, journals, { label: 'penerimaan barang', trail });

  const updated = await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } });

  logger.info({ sttId, sttNumber: stt.sttNumber, voided }, 'Goods receipt cancelled (stock reversed + journal voided)');
  return updated;
}
