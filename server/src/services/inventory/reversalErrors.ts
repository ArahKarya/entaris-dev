/**
 * Refusals of inventoryLedger.reverseMovement and reviseOutbound (the value ledger, E3-R6 / E3-R8):
 * the train guard of a reversal without a true-up, the two cases a value replay (trueUp 'replay')
 * cannot value, and a raised quantity the replay cannot place.
 */
import type { StockMovement } from '@prisma/client';
import type Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { VALUE_DP } from './inventoryValueMath';

/** Stock and stock_value of the item after the reversal. */
interface BookState {
  stock: Decimal;
  value: Decimal;
}

/**
 * Error code (409) of a reversal without trueUp 'replay' (the train guard, kept for the paths that do
 * not replay yet): reversing this row would leave the book wrong without a value true-up: an inbound
 * reversal with value after goods of the item went out (unless the stock reaches 0 and is swept),
 * one that takes stock_value below 0 or leaves stock on hand with no value, or a reversal that
 * leaves value at zero stock without sweepAtZero.
 */
export const REVERSAL_NEEDS_TRUE_UP = 'REVERSAL_NEEDS_TRUE_UP';

/**
 * Error code (409) of trueUp 'replay': goods of the item went out after the row, and the row lies at
 * or before the item's ValuationBaseline, so no replay can value the correction (owner decision
 * #20). The accountant posts a correcting journal instead.
 */
export const TRUE_UP_PRE_BASELINE = 'TRUE_UP_PRE_BASELINE';

/**
 * Error code (409) of trueUp 'replay': the replay of the item's rows does not explain its stock (the
 * replayed quantity differs from current_stock, or it values stock on hand below 0), or without the
 * row goods would have gone out past zero where they did not (stock <= 0 windows, PR-6.6). The ledger
 * does not guess a correction.
 */
export const TRUE_UP_UNEXPLAINED = 'TRUE_UP_UNEXPLAINED';

/**
 * Error code (409) of a document edit that raises an outbound row's quantity after value entered the
 * item's book (reviseOutbound): the row keeps its place in processing order, so the extra taken out
 * at the average now would stand before that inbound in every later replay. The extra goes on a line
 * of its own, posted now at the average now (owner decision #9).
 */
export const OUTBOUND_INCREASE_AFTER_INBOUND = 'OUTBOUND_INCREASE_AFTER_INBOUND';

export function increaseAfterInbound(itemName: string): BusinessError {
  return new BusinessError(
    `Qty '${itemName}' tidak bisa dinaikkan di baris yang sama: sudah ada barang masuk atau koreksi nilai sesudah baris ini dicatat. `
      + 'Biarkan qty baris ini, lalu tambahkan selisihnya sebagai baris baru (dinilai rata-rata saat ini).',
    OUTBOUND_INCREASE_AFTER_INBOUND,
    409,
  );
}

export function needsTrueUp(itemName: string, next: BookState, forEdit = false): BusinessError {
  if (forEdit) {
    return new BusinessError(
      `Edit ditolak: '${itemName}' sudah sebagian keluar, jadi nilai persediaannya perlu dikoreksi `
        + `(stok sesudahnya ${next.stock.toString()}, nilai ${next.value.toFixed(VALUE_DP)}). Koreksi nilai otomatis belum tersedia; hubungi akuntan.`,
      REVERSAL_NEEDS_TRUE_UP,
      409,
    );
  }
  return new BusinessError(
    `Pembatalan ditolak: '${itemName}' sudah sebagian keluar, jadi nilai persediaannya perlu dikoreksi `
      + `(stok sesudahnya ${next.stock.toString()}, nilai ${next.value.toFixed(VALUE_DP)}). Koreksi nilai otomatis belum tersedia; hubungi akuntan.`,
    REVERSAL_NEEDS_TRUE_UP,
    409,
  );
}

/** Stock 0 with value left and no sweep asked: nothing needs to have gone out for this one. */
export function residueAtZero(itemName: string, next: BookState, forEdit = false): BusinessError {
  const value = next.value.toFixed(VALUE_DP);
  return new BusinessError(
    forEdit
      ? `Edit ditolak: stok '${itemName}' menjadi 0 tetapi nilai persediaannya masih ${value}, `
        + 'jadi sisa nilai itu perlu dikoreksi. Koreksi nilai otomatis belum tersedia; hubungi akuntan.'
      : `Pembatalan ditolak: stok '${itemName}' menjadi 0 tetapi nilai persediaannya masih ${value}, `
        + 'jadi sisa nilai itu perlu dikoreksi. Koreksi nilai otomatis belum tersedia; hubungi akuntan.',
    REVERSAL_NEEDS_TRUE_UP,
    409,
  );
}

/**
 * Owner decision #20: the row predates the baseline and goods went out since. "Before" is processing
 * order: the baseline row was written when the value ledger was deployed, so a row entered before
 * that is in its opening value even when dated on or after the baseline date.
 */
export function preBaseline(itemName: string, movement: StockMovement): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: gerakan stok ${movement.movementNumber} '${itemName}' dicatat sebelum buku nilai dirilis (sudah termasuk nilai awalnya), `
      + 'dan barangnya sudah ikut keluar, jadi koreksi nilainya tidak bisa dihitung otomatis. Minta akuntan membuat jurnal koreksi.',
    TRUE_UP_PRE_BASELINE,
    409,
  );
}

/** The replay does not reproduce the item's stock, or values stock on hand below 0. */
export function unexplained(itemName: string): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: riwayat gerakan stok '${itemName}' tidak menjelaskan stok dan nilainya saat ini, `
      + 'jadi koreksi nilai tidak bisa dihitung otomatis. Hubungi akuntan.',
    TRUE_UP_UNEXPLAINED,
    409,
  );
}

/** Without the row, goods of the item would have gone out past zero (or a Revaluation landed at no stock). */
export function pricedPastZero(itemName: string): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: tanpa gerakan stok ini, barang '${itemName}' yang keluar sesudahnya melebihi stoknya, `
      + 'jadi koreksi nilainya tidak bisa dihitung otomatis. Hubungi akuntan.',
    TRUE_UP_UNEXPLAINED,
    409,
  );
}
