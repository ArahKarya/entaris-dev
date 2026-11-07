// Save-time rules of recurring templates (E7-R5). Pure: no database. The route runs these before a
// template is written, so a template that could never post is refused when it is saved instead of
// failing silently on its due date. Journal lines go through the one line validator.

import { BusinessError } from './errors';
import { businessDayOf, businessToday, parseDateParam } from './businessDate';
import { journalLineIssueMessage, validateJournalLines } from './journalLineRules';

export const RECURRING_DATE_INVALID = 'RECURRING_DATE_INVALID';
export const RECURRING_DATE_PAST = 'RECURRING_DATE_PAST';
export const RECURRING_DATE_BEFORE_LAST_RUN = 'RECURRING_DATE_BEFORE_LAST_RUN';
export const RECURRING_TYPE_MISMATCH = 'RECURRING_TYPE_MISMATCH';
/** Run of a template whose type has no automatic execution (only 'journal' posts). */
export const RECURRING_TYPE_UNSUPPORTED = 'RECURRING_TYPE_UNSUPPORTED';
export const RECURRING_PARTY_NOT_ALLOWED = 'PARTY_NOT_ALLOWED';

export interface NextRunDateInput {
  /** YYYY-MM-DD as sent by the client. */
  nextRunDate: string;
  now?: Date;
  /** Stored last run; the next run must be after the day of the last run, so a posted period is never queued again. */
  lastRunDate?: Date | null;
  /** Stored next run; sending it back unchanged (an edit that leaves the date alone) is always accepted. */
  previousNextRunDate?: Date | null;
}

export type NextRunDateResult =
  | { ok: true; date: Date }
  | { ok: false; code: string; message: string };

export function checkNextRunDate(input: NextRunDateInput): NextRunDateResult {
  const parsed = parseDateParam(input.nextRunDate);
  // parseDateParam lets a day that does not exist roll over (2026-02-30 -> 2 March); compare the round trip.
  const day = parsed && new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) === parsed ? parsed : null;
  if (!day) {
    return { ok: false, code: RECURRING_DATE_INVALID, message: 'Tanggal berikutnya harus berupa tanggal kalender yang valid (YYYY-MM-DD).' };
  }
  const date = new Date(`${day}T00:00:00.000Z`);
  // The edit form sends back the UTC day of the stored instant, which is the day before the WIB day for
  // runs the scheduler advanced at 02:00 WIB; either form of the stored value counts as unchanged.
  const prev = input.previousNextRunDate;
  if (prev && (businessDayOf(prev) === day || prev.toISOString().slice(0, 10) === day)) return { ok: true, date: prev };
  if (day < businessToday(input.now)) {
    return { ok: false, code: RECURRING_DATE_PAST, message: 'Tanggal berikutnya tidak boleh sudah lewat.' };
  }
  if (input.lastRunDate && day <= businessDayOf(input.lastRunDate)) {
    return { ok: false, code: RECURRING_DATE_BEFORE_LAST_RUN, message: 'Tanggal berikutnya harus setelah tanggal eksekusi terakhir.' };
  }
  return { ok: true, date };
}

export interface JournalTemplateItemInput {
  accountId: string;
  debit: number | string;
  credit: number | string;
  partyId?: string | null;
  description?: string;
}

export interface JournalTemplateDataInput {
  narration: string;
  items: readonly JournalTemplateItemInput[];
}

export interface NormalizedJournalTemplateData {
  narration: string;
  /** Amounts are stored as plain 2-decimal strings, never as floating-point numbers. */
  items: { accountId: string; debit: string; credit: string; description?: string }[];
}

/**
 * Journal template data: no party on any line (owner decision #3), and the lines pass the one line
 * validator (finite plain amounts, at most 2 decimals, one side per line, at least 2 lines, exact balance).
 * Throws BusinessError with the validator's code. Returns the data normalized for storage.
 */
export function validateJournalTemplateData(data: JournalTemplateDataInput): NormalizedJournalTemplateData {
  if (data.items.some((item) => item.partyId != null && item.partyId !== '')) {
    throw new BusinessError('Template jurnal berulang tidak boleh membawa pihak; kosongkan pihak di semua baris.', RECURRING_PARTY_NOT_ALLOWED);
  }
  const result = validateJournalLines(data.items);
  if (!result.ok) {
    const first = result.issues[0];
    throw new BusinessError(journalLineIssueMessage(first), first.code);
  }
  const keep = data.items.map((item) => item.description);
  return {
    narration: data.narration,
    items: result.lines.map((line, i) => ({
      accountId: line.accountId,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2),
      ...(keep[i] ? { description: keep[i] } : {}),
    })),
  };
}
