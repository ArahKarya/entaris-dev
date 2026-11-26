/**
 * Refusals of inventoryLedger.reverseMovement (the value ledger, E3-R6 / E3-R8): the train guard of
 * a reversal without a true-up, and the two cases a value replay (trueUp 'replay') cannot value.
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
 * replayed quantity differs from current_stock, or it values stock on hand below 0). The ledger does
 * not guess a correction.
 */
export const TRUE_UP_UNEXPLAINED = 'TRUE_UP_UNEXPLAINED';

export function needsTrueUp(itemName: string, next: BookState): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: '${itemName}' sudah sebagian keluar, jadi nilai persediaannya perlu dikoreksi `
      + `(stok sesudahnya ${next.stock.toString()}, nilai ${next.value.toFixed(VALUE_DP)}). Koreksi nilai otomatis belum tersedia; hubungi akuntan.`,
    REVERSAL_NEEDS_TRUE_UP,
    409,
  );
}

/** Stock 0 with value left and no sweep asked: nothing needs to have gone out for this one. */
export function residueAtZero(itemName: string, next: BookState): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: stok '${itemName}' menjadi 0 tetapi nilai persediaannya masih ${next.value.toFixed(VALUE_DP)}, `
      + 'jadi sisa nilai itu perlu dikoreksi. Koreksi nilai otomatis belum tersedia; hubungi akuntan.',
    REVERSAL_NEEDS_TRUE_UP,
    409,
  );
}

/** Owner decision #20: the row predates the baseline and goods went out since. */
export function preBaseline(itemName: string, movement: StockMovement): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: gerakan stok ${movement.movementNumber} '${itemName}' tercatat sebelum nilai awal buku nilai, `
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
