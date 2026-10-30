// Un-posting one depreciation entry of a fixed asset (E1-R5).
//
// Posting (POST /fixed-assets/:id/depreciate and /depreciate-bulk) writes one DEP-… journal per
// schedule row, marks the row isPosted with its journalEntryId and moves the asset's
// accumulatedDepreciation and bookValue by the row amount. Cancelling does the opposite for the
// newest posted row only: the journal is voided (not deleted, so the count()-based DEP numbers never
// repeat), the row goes back to unposted and the asset figures are restored. The schedule stays a
// sequence: an older row cannot be un-posted while a later one is posted.
//
// Order is periodDate until the schedule gets its own sequence column (E8-R2).

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { voidJournalInTx } from '../utils/journalCancel';
import { STALE_STATUS, type CancelTrail } from '../utils/cancelClaim';

type Tx = Prisma.TransactionClient;

/** Error code: the schedule row is not one of this asset's rows. */
export const DEPRECIATION_ENTRY_NOT_FOUND = 'DEPRECIATION_ENTRY_NOT_FOUND';
/** Error code: a later row of the same asset is still posted; un-post that one first. */
export const DEPRECIATION_NOT_LAST = 'DEPRECIATION_NOT_LAST';
/** Error code: the asset is no longer Active (disposed); undo the disposal first. */
export const FIXED_ASSET_NOT_ACTIVE = 'FIXED_ASSET_NOT_ACTIVE';
/** Error code: the posted row has no live journal (missing, or voided outside this module). */
export const DEPRECIATION_JOURNAL_MISSING = 'DEPRECIATION_JOURNAL_MISSING';

const NOT_POSTED_MESSAGE =
  'Penyusutan periode ini belum diposting atau postingnya sudah dibatalkan. Muat ulang halaman lalu coba lagi.';
const JOURNAL_MISSING_MESSAGE =
  'Jurnal penyusutan periode ini tidak ditemukan atau sudah dibatalkan di luar modul Aset Tetap, jadi posting tidak bisa dibatalkan di sini. Koreksi dengan jurnal manual.';

export interface CancelDepreciationEntryResult {
  /** The asset id (also the audit trail's entity id). */
  id: string;
  entryId: string;
  journalEntryId: string;
  entryNumber: string;
  amount: number;
  accumulatedDepreciation: number;
  bookValue: number;
}

function formatPeriod(date: Date): string {
  return date.toISOString().substring(0, 7);
}

/**
 * Un-post one depreciation row of an asset inside the caller's transaction: void its journal
 * (ledger rows cancelled, account balances reversed, cancelledById/cancelReason from `trail`),
 * mark the row unposted again and take its amount off accumulatedDepreciation and back onto
 * bookValue. The row can then be posted again, which writes a new DEP number.
 *
 * Rejects (BusinessError, 400): a row that is not this asset's (DEPRECIATION_ENTRY_NOT_FOUND), a row
 * that is not posted, including the loser of a double click (STALE_STATUS), a disposed asset
 * (FIXED_ASSET_NOT_ACTIVE), a row with a later posted row (DEPRECIATION_NOT_LAST), a closed fiscal
 * year of the journal (PERIOD_CLOSED) and a row whose journal is missing or already voided
 * (DEPRECIATION_JOURNAL_MISSING). The asset row is locked first, so two cancels on one asset run
 * one after the other.
 */
export async function cancelDepreciationEntryInTx(
  tx: Tx,
  assetId: string,
  entryId: string,
  trail: CancelTrail,
): Promise<CancelDepreciationEntryResult> {
  await tx.$queryRaw`SELECT id FROM fixed_assets WHERE id = ${assetId} FOR UPDATE`;
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId }, select: { id: true, status: true } });
  if (!asset) throw new BusinessError('Aset tidak ditemukan.');

  const entry = await tx.depreciationEntry.findUnique({ where: { id: entryId } });
  if (!entry || entry.fixedAssetId !== asset.id) {
    throw new BusinessError('Jadwal penyusutan ini bukan milik aset tersebut.', DEPRECIATION_ENTRY_NOT_FOUND);
  }
  if (!entry.isPosted) throw new BusinessError(NOT_POSTED_MESSAGE, STALE_STATUS);
  if (asset.status !== 'Active') {
    throw new BusinessError(
      'Aset ini sudah tidak aktif (dilepas). Batalkan pelepasannya dulu sebelum membatalkan posting penyusutan.',
      FIXED_ASSET_NOT_ACTIVE,
    );
  }

  const later = await tx.depreciationEntry.findFirst({
    where: { fixedAssetId: asset.id, isPosted: true, periodDate: { gt: entry.periodDate } },
    orderBy: { periodDate: 'desc' },
    select: { periodDate: true },
  });
  if (later) {
    throw new BusinessError(
      `Penyusutan periode ${formatPeriod(later.periodDate)} masih terposting. Batalkan posting mulai dari periode terakhir.`,
      DEPRECIATION_NOT_LAST,
    );
  }

  const journal = entry.journalEntryId
    ? await tx.journalEntry.findUnique({ where: { id: entry.journalEntryId }, include: { items: true } })
    : null;
  if (!journal) throw new BusinessError(JOURNAL_MISSING_MESSAGE, DEPRECIATION_JOURNAL_MISSING);

  // The row claim is the first write: of two cancels only one gets count 1 (the asset lock already
  // serialises them; this also covers a post or cancel path that does not take that lock).
  const claimed = await tx.depreciationEntry.updateMany({
    where: { id: entry.id, isPosted: true },
    data: { isPosted: false, journalEntryId: null },
  });
  if (claimed.count !== 1) throw new BusinessError(NOT_POSTED_MESSAGE, STALE_STATUS);

  // Checks the journal's fiscal year (PERIOD_CLOSED) before anything moves on the ledger.
  const voided = await voidJournalInTx(tx, journal, 'penyusutan', trail);
  if (!voided) throw new BusinessError(JOURNAL_MISSING_MESSAGE, DEPRECIATION_JOURNAL_MISSING);

  const amount = Number(entry.amount);
  const updated = await tx.fixedAsset.update({
    where: { id: asset.id },
    data: {
      accumulatedDepreciation: { decrement: amount },
      bookValue: { increment: amount },
    },
    select: { accumulatedDepreciation: true, bookValue: true },
  });

  return {
    id: asset.id,
    entryId: entry.id,
    journalEntryId: journal.id,
    entryNumber: journal.entryNumber,
    amount,
    accumulatedDepreciation: Number(updated.accumulatedDepreciation),
    bookValue: Number(updated.bookValue),
  };
}
