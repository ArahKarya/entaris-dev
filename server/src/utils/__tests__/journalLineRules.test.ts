import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { BusinessError } from '../errors';
import { translateMessage } from '../../i18n/translateMessage';
import {
  assertJournalLines,
  journalLineIssueMessage,
  validateJournalLines,
  type JournalLineInput,
  type JournalLineIssue,
} from '../journalLineRules';

const dr = (debit: JournalLineInput['debit'], accountId = 'a-dr'): JournalLineInput => ({ accountId, debit });
const cr = (credit: JournalLineInput['credit'], accountId = 'a-cr'): JournalLineInput => ({ accountId, credit });

function issues(lines: JournalLineInput[], opts?: { dropEmptyLines?: boolean }): JournalLineIssue[] {
  const r = validateJournalLines(lines, opts);
  if (r.ok) throw new Error('expected issues');
  return r.issues;
}

function errorOf(fn: () => unknown): BusinessError {
  try {
    fn();
  } catch (e) {
    if (e instanceof BusinessError) return e;
    throw e;
  }
  throw new Error('expected a BusinessError');
}

describe('validateJournalLines: balance', () => {
  it('accepts a balanced journal and returns Decimal lines and the total', () => {
    const r = validateJournalLines([dr('100000.01'), cr(100000.01)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total.toFixed(2)).toBe('100000.01');
    expect(r.lines.map((l) => [l.debit.toString(), l.credit.toString()])).toEqual([['100000.01', '0'], ['0', '100000.01']]);
    expect(r.lines.every((l) => Prisma.Decimal.isDecimal(l.debit))).toBe(true);
  });

  it('rejects one cent of difference: no tolerance', () => {
    expect(issues([dr('100000.01'), cr('100000.00')])).toEqual([{
      index: null,
      code: 'JOURNAL_UNBALANCED',
      message: 'Jurnal tidak seimbang. Total Debit (100000.01) ≠ Total Kredit (100000.00).',
    }]);
  });

  it('0.1 + 0.2 balances 0.3 exactly (Decimal, not float)', () => {
    const r = validateJournalLines([dr(0.1), dr(0.2), cr(0.3)]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.total.toString()).toBe('0.3');
  });

  it('a float sum carried in as a number is rejected for precision, not rounded', () => {
    expect(issues([dr(0.1 + 0.2), cr(0.3)])[0]).toMatchObject({ index: 0, code: 'LINE_AMOUNT_PRECISION' });
  });

  it('accepts Prisma.Decimal input', () => {
    expect(validateJournalLines([dr(new Prisma.Decimal('5.5')), cr(new Prisma.Decimal('5.50'))]).ok).toBe(true);
  });
});

describe('validateJournalLines: line count and empty lines', () => {
  it('rejects a single line', () => {
    expect(issues([dr(100)])).toEqual([{ index: null, code: 'LINES_TOO_FEW', message: 'Jurnal minimal memiliki 2 baris bernilai.' }]);
  });

  it('rejects no lines', () => {
    expect(issues([])[0].code).toBe('LINES_TOO_FEW');
  });

  it('rejects a 0/0 line, null and empty string counting as 0', () => {
    expect(issues([dr(100), cr(100), { accountId: 'x', debit: 0, credit: '' }])).toEqual([
      { index: 2, code: 'LINE_EMPTY', message: 'Baris jurnal tanpa nilai: isi debit atau kredit.' },
    ]);
    expect(issues([dr(100), cr(100), { accountId: 'x' }])[0].code).toBe('LINE_EMPTY');
  });

  it('drops 0/0 lines with dropEmptyLines, then counts only lines with an amount', () => {
    const r = validateJournalLines([dr(100), { accountId: 'x', debit: null, credit: null }, cr(100)], { dropEmptyLines: true });
    expect(r.ok && r.lines.map((l) => l.accountId)).toEqual(['a-dr', 'a-cr']);
    expect(issues([dr(0), cr(0)], { dropEmptyLines: true })[0].code).toBe('LINES_TOO_FEW');
  });
});

describe('validateJournalLines: amounts', () => {
  it('rejects a negative amount', () => {
    expect(issues([dr(-5), cr(5)])).toEqual([{ index: 0, code: 'LINE_AMOUNT_NEGATIVE', message: 'Nilai debit tidak boleh negatif.' }]);
    expect(issues([dr(5), cr('-5')])[0]).toMatchObject({ index: 1, code: 'LINE_AMOUNT_NEGATIVE' });
  });

  it('accepts -0 as zero', () => {
    const r = validateJournalLines([{ accountId: 'a', debit: 5, credit: -0 }, cr(5)]);
    expect(r.ok && r.lines[0].credit.toString()).toBe('0');
  });

  it('rejects debit and credit on one line', () => {
    expect(issues([{ accountId: 'a', debit: 5, credit: 5 }, cr(5)])).toEqual([{
      index: 0, code: 'LINE_BOTH_SIDES', message: 'Satu baris jurnal tidak boleh memiliki debit dan kredit sekaligus.',
    }]);
  });

  it('rejects 3 decimals instead of rounding', () => {
    expect(issues([dr('10.005'), cr('10.005')]).map((i) => i.code)).toEqual(['LINE_AMOUNT_PRECISION', 'LINE_AMOUNT_PRECISION']);
    expect(validateJournalLines([dr('10.50'), cr('10.5')]).ok).toBe(true);
  });

  it('rejects text, thousands separators, exponents and non-finite numbers', () => {
    for (const bad of ['abc', '5.000.000', '5,000,000', '1e5', '12a', '.5']) {
      expect(issues([dr(bad), cr(5)])[0], bad).toMatchObject({ index: 0, code: 'LINE_AMOUNT_INVALID' });
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, new Prisma.Decimal(Number.NaN)]) {
      expect(issues([dr(bad), cr(5)])[0].code).toBe('LINE_AMOUNT_INVALID');
    }
    expect(issues([dr('5.000.000'), cr(5)])[0].message).toBe(
      'Nilai debit "5.000.000" bukan angka yang valid. Tulis angka tanpa pemisah ribuan, dengan titik sebagai tanda desimal.',
    );
  });

  it('trims surrounding spaces of a numeric string', () => {
    expect(validateJournalLines([dr(' 1500.25 '), cr('1500.25')]).ok).toBe(true);
  });

  it('rejects amounts at or above 10^13 (Decimal(15,2))', () => {
    expect(validateJournalLines([dr('9999999999999.99'), cr('9999999999999.99')]).ok).toBe(true);
    expect(issues([dr('10000000000000'), cr('10000000000000')])[0]).toMatchObject({ index: 0, code: 'LINE_AMOUNT_TOO_LARGE' });
  });

  it('collects every line issue with its index and skips the journal-level checks', () => {
    expect(issues([dr('abc'), { accountId: 'b', debit: 1, credit: 1 }, cr(-2), dr('1.234'), { accountId: 'e' }, cr(7)]).map((i) => [i.index, i.code])).toEqual([
      [0, 'LINE_AMOUNT_INVALID'],
      [1, 'LINE_BOTH_SIDES'],
      [2, 'LINE_AMOUNT_NEGATIVE'],
      [3, 'LINE_AMOUNT_PRECISION'],
      [4, 'LINE_EMPTY'],
    ]);
  });

  it('reports both sides of one line separately', () => {
    expect(issues([{ accountId: 'a', debit: 'x', credit: -1 }, cr(1)]).map((i) => [i.index, i.code])).toEqual([
      [0, 'LINE_AMOUNT_INVALID'],
      [0, 'LINE_AMOUNT_NEGATIVE'],
    ]);
  });
});

describe('validateJournalLines: normalized fields', () => {
  it('keeps accountId and description, blank partyId becomes null', () => {
    const r = validateJournalLines([
      { accountId: 'a', debit: 10, partyId: 'p-1', description: 'Sewa' },
      { accountId: 'b', credit: 10, partyId: '  ' },
    ]);
    expect(r.ok && r.lines).toEqual([
      { accountId: 'a', debit: new Prisma.Decimal(10), credit: new Prisma.Decimal(0), partyId: 'p-1', description: 'Sewa' },
      { accountId: 'b', debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(10), partyId: null, description: null },
    ]);
  });
});

describe('assertJournalLines', () => {
  it('returns the normalized lines when valid', () => {
    expect(assertJournalLines([dr(1), cr(1)])).toHaveLength(2);
  });

  it('throws the first issue with its code, naming the 1-based line', () => {
    const e = errorOf(() => assertJournalLines([dr(1), cr(-1), dr('x')]));
    expect(e.code).toBe('LINE_AMOUNT_NEGATIVE');
    expect(e.message).toBe('Baris 2: Nilai kredit tidak boleh negatif.');
  });

  it('journal-level issues carry no line number', () => {
    const e = errorOf(() => assertJournalLines([dr(2), cr(1)]));
    expect(e.code).toBe('JOURNAL_UNBALANCED');
    expect(e.message).toBe(journalLineIssueMessage({ index: null, code: 'JOURNAL_UNBALANCED', message: e.message }));
  });

  it('has no rounding tolerance anywhere', () => {
    expect(errorOf(() => assertJournalLines([dr('0.01'), dr('100'), cr('100')])).code).toBe('JOURNAL_UNBALANCED');
  });
});

describe('messages translate to English', () => {
  it.each([
    ['Baris 2: Nilai kredit tidak boleh negatif.', 'Line 2: The credit amount cannot be negative.'],
    ['Nilai debit tidak boleh negatif.', 'The debit amount cannot be negative.'],
    [
      'Baris 1: Nilai debit "5.000.000" bukan angka yang valid. Tulis angka tanpa pemisah ribuan, dengan titik sebagai tanda desimal.',
      'Line 1: The debit amount "5.000.000" is not a valid number. Write the number without thousands separators, with a dot as the decimal mark.',
    ],
    ['Baris 3: Nilai kredit 10.005 lebih dari 2 angka desimal.', 'Line 3: The credit amount 10.005 has more than 2 decimal places.'],
    ['Nilai debit 10000000000000 melebihi batas 9999999999999.99.', 'The debit amount 10000000000000 exceeds the limit of 9999999999999.99.'],
    ['Baris 4: Baris jurnal tanpa nilai: isi debit atau kredit.', 'Line 4: The journal line has no amount: fill in a debit or a credit.'],
    ['Jurnal minimal memiliki 2 baris bernilai.', 'A journal needs at least 2 lines with an amount.'],
    ['Baris 1: Satu baris jurnal tidak boleh memiliki debit dan kredit sekaligus.', 'Line 1: A journal line cannot have both a debit and a credit.'],
  ])('%s', (id, en) => {
    expect(translateMessage(id, 'en')).toBe(en);
  });
});
