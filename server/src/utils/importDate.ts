// Dates and amounts read from an uploaded sheet. Two date formats only (YYYY-MM-DD and DD/MM/YYYY,
// so 05/03/2026 is 5 March) and plain amounts, never a guess: a value that could mean two things is refused.
import { startOfBusinessDay } from './businessDate';

export type ImportDateResult =
  | { ok: true; day: string }
  | { ok: false; code: 'AMBIGUOUS' | 'INVALID'; message: string };

export type ImportAmountResult = { ok: true; value: string } | { ok: false; message: string };

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** Looks like a date in some other layout (05-03-2026, 3/5/26, 2026/03/05): could be read two ways. */
const OTHER_DATE_LAYOUT = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;
const TEXT_AMOUNT = /^-?\d+(\.\d{1,2})?$/;
const NUMBER_CELL_TOLERANCE = 1e-6;

const pad = (n: number) => String(n).padStart(2, '0');

function realDay(year: number, month: number, day: number): string | null {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** A business day (YYYY-MM-DD) from a cell. An Excel date cell arrives as a Date (its UTC day is the sheet day). */
export function parseImportDate(raw: string | Date | null | undefined): ImportDateResult {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, code: 'INVALID', message: 'Tanggal tidak valid.' };
    return { ok: true, day: raw.toISOString().slice(0, 10) };
  }
  const text = (raw ?? '').trim();
  const iso = ISO_DAY.exec(text);
  const dayFirst = DAY_FIRST.exec(text);
  const day = iso
    ? realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : dayFirst
      ? realDay(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]))
      : undefined;
  if (day) return { ok: true, day };
  if (iso || dayFirst) return { ok: false, code: 'INVALID', message: `Tanggal "${text}" tidak ada di kalender.` };
  if (OTHER_DATE_LAYOUT.test(text)) {
    return { ok: false, code: 'AMBIGUOUS', message: `Format tanggal "${text}" bisa dibaca dua cara. Tulis YYYY-MM-DD atau DD/MM/YYYY.` };
  }
  return { ok: false, code: 'INVALID', message: `Tanggal "${text}" tidak valid. Tulis YYYY-MM-DD atau DD/MM/YYYY.` };
}

/** The journal date as an instant: the start of that business day (WIB), what period checks read back. */
export function importDateToInstant(day: string): Date {
  return startOfBusinessDay(day);
}

/**
 * An amount as a plain decimal string for the journal line validator.
 * Text cells: only -?digits with up to 2 decimals ("5.000.000" is refused, it is not 5 million
 * in every locale). Number and formula cells (`fromNumberCell`): a float such as 110000.00000000001
 * is rounded to 2 decimals when it is within 1e-6 of that value, anything else is refused.
 */
export function parseImportAmount(raw: string | null | undefined, opts: { fromNumberCell?: boolean } = {}): ImportAmountResult {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: true, value: '0' };
  if (opts.fromNumberCell) {
    const n = Number(text);
    const rounded = Math.round(n * 100) / 100;
    if (!Number.isFinite(n) || Math.abs(n - rounded) >= NUMBER_CELL_TOLERANCE) {
      return { ok: false, message: `Nilai "${text}" bukan angka dengan paling banyak 2 desimal.` };
    }
    return { ok: true, value: (Object.is(rounded, -0) ? 0 : rounded).toFixed(2) };
  }
  if (!TEXT_AMOUNT.test(text)) {
    return {
      ok: false,
      message: `Nilai "${text}" bukan angka yang valid. Tulis angka tanpa pemisah ribuan, dengan titik sebagai tanda desimal.`,
    };
  }
  return { ok: true, value: text };
}
