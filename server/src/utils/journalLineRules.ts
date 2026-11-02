// The one journal line validator (E2-R3). Pure: no database, Decimal arithmetic only. Every writer
// that takes journal lines from a person or a file (manual journal, import, recurring template) and
// the shared postJournal run their lines through here, so there is no second balance check with
// its own tolerance. Rules: finite plain numbers, no negatives, at most 2 decimals, below 10^13
// (Decimal(15,2)), one side per line, no 0/0 line, at least 2 lines with an amount, and the debit
// total exactly equal to the credit total.

import { Prisma } from '@prisma/client';
import { BusinessError } from './errors';

export interface JournalLineInput {
  accountId: string;
  /** null, undefined and '' mean 0. */
  debit?: number | string | Prisma.Decimal | null;
  credit?: number | string | Prisma.Decimal | null;
  partyId?: string | null;
  description?: string | null;
}

/** Not `JournalLine`: that name is taken by services/paymentRequestRules.ts. */
export interface NormalizedJournalLine {
  accountId: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  partyId: string | null;
  description: string | null;
}

export type JournalLineIssueCode =
  | 'LINE_AMOUNT_INVALID'
  | 'LINE_AMOUNT_NEGATIVE'
  | 'LINE_AMOUNT_PRECISION'
  | 'LINE_AMOUNT_TOO_LARGE'
  | 'LINE_BOTH_SIDES'
  | 'LINE_EMPTY'
  | 'LINES_TOO_FEW'
  | 'JOURNAL_UNBALANCED';

export interface JournalLineIssue {
  /** 0-based index into the input lines; null for a journal-level issue. */
  index: number | null;
  code: JournalLineIssueCode;
  message: string;
}

export type JournalLineResult =
  | { ok: true; lines: NormalizedJournalLine[]; total: Prisma.Decimal }
  | { ok: false; issues: JournalLineIssue[] };

export interface JournalLineOptions {
  /** Skip 0/0 lines instead of rejecting them (document writers that may produce a zero line). */
  dropEmptyLines?: boolean;
}

/** Decimal(15,2): amounts must stay below 10^13. */
const AMOUNT_LIMIT = new Prisma.Decimal('1e13');
const MAX_DECIMALS = 2;
/** Plain decimal number: digits, optional dot and fraction, optional leading minus. No thousands separators or exponent. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const ZERO = new Prisma.Decimal(0);

type Side = 'debit' | 'kredit';
type AmountResult = { ok: true; value: Prisma.Decimal } | { ok: false; code: JournalLineIssueCode; message: string };

function parseAmount(raw: JournalLineInput['debit'], side: Side): AmountResult {
  if (raw === null || raw === undefined) return { ok: true, value: ZERO };
  let value: Prisma.Decimal | null = null;
  if (Prisma.Decimal.isDecimal(raw)) {
    value = raw.isFinite() ? new Prisma.Decimal(raw) : null;
  } else if (typeof raw === 'number') {
    value = Number.isFinite(raw) ? new Prisma.Decimal(raw) : null;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return { ok: true, value: ZERO };
    value = PLAIN_NUMBER.test(text) ? new Prisma.Decimal(text) : null;
  }
  if (!value) {
    return {
      ok: false,
      code: 'LINE_AMOUNT_INVALID',
      message: `Nilai ${side} "${String(raw)}" bukan angka yang valid. Tulis angka tanpa pemisah ribuan, dengan titik sebagai tanda desimal.`,
    };
  }
  if (value.isNegative() && !value.isZero()) {
    return { ok: false, code: 'LINE_AMOUNT_NEGATIVE', message: `Nilai ${side} tidak boleh negatif.` };
  }
  if (value.decimalPlaces() > MAX_DECIMALS) {
    return { ok: false, code: 'LINE_AMOUNT_PRECISION', message: `Nilai ${side} ${value.toString()} lebih dari 2 angka desimal.` };
  }
  if (value.gte(AMOUNT_LIMIT)) {
    return { ok: false, code: 'LINE_AMOUNT_TOO_LARGE', message: `Nilai ${side} ${value.toFixed()} melebihi batas 9999999999999.99.` };
  }
  return { ok: true, value: value.abs() }; // abs() turns -0 into 0
}

const blankToNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === '' ? null : v);

/**
 * Checks and normalizes journal lines. All line-level issues are collected (an import reports every
 * bad row at once); the journal-level checks (line count, balance) run only when every line is valid,
 * since totals over broken lines would mislead.
 */
export function validateJournalLines(lines: readonly JournalLineInput[], opts: JournalLineOptions = {}): JournalLineResult {
  const issues: JournalLineIssue[] = [];
  const kept: NormalizedJournalLine[] = [];

  lines.forEach((line, index) => {
    const debit = parseAmount(line.debit, 'debit');
    const credit = parseAmount(line.credit, 'kredit');
    if (!debit.ok) issues.push({ index, code: debit.code, message: debit.message });
    if (!credit.ok) issues.push({ index, code: credit.code, message: credit.message });
    if (!debit.ok || !credit.ok) return;

    if (debit.value.gt(0) && credit.value.gt(0)) {
      issues.push({ index, code: 'LINE_BOTH_SIDES', message: 'Satu baris jurnal tidak boleh memiliki debit dan kredit sekaligus.' });
      return;
    }
    if (debit.value.isZero() && credit.value.isZero()) {
      if (!opts.dropEmptyLines) {
        issues.push({ index, code: 'LINE_EMPTY', message: 'Baris jurnal tanpa nilai: isi debit atau kredit.' });
      }
      return;
    }
    kept.push({
      accountId: line.accountId,
      debit: debit.value,
      credit: credit.value,
      partyId: blankToNull(line.partyId),
      description: line.description ?? null,
    });
  });

  if (issues.length > 0) return { ok: false, issues };

  if (kept.length < 2) {
    return { ok: false, issues: [{ index: null, code: 'LINES_TOO_FEW', message: 'Jurnal minimal memiliki 2 baris bernilai.' }] };
  }
  const totalDebit = kept.reduce((s, l) => s.plus(l.debit), ZERO);
  const totalCredit = kept.reduce((s, l) => s.plus(l.credit), ZERO);
  if (!totalDebit.eq(totalCredit)) {
    return {
      ok: false,
      issues: [{
        index: null,
        code: 'JOURNAL_UNBALANCED',
        message: `Jurnal tidak seimbang. Total Debit (${totalDebit.toFixed(2)}) ≠ Total Kredit (${totalCredit.toFixed(2)}).`,
      }],
    };
  }
  return { ok: true, lines: kept, total: totalDebit };
}

/** The message of an issue as shown to a person: line issues name the 1-based line. */
export function journalLineIssueMessage(issue: JournalLineIssue): string {
  return issue.index === null ? issue.message : `Baris ${issue.index + 1}: ${issue.message}`;
}

/** validateJournalLines that throws BusinessError (code = issue code) for the first issue. */
export function assertJournalLines(lines: readonly JournalLineInput[], opts: JournalLineOptions = {}): NormalizedJournalLine[] {
  const result = validateJournalLines(lines, opts);
  if (!result.ok) {
    const first = result.issues[0];
    throw new BusinessError(journalLineIssueMessage(first), first.code);
  }
  return result.lines;
}
