import { describe, expect, it } from 'vitest';
import { importDateToInstant, parseImportAmount, parseImportDate } from '../importDate';
import { businessDayOf } from '../businessDate';

describe('parseImportDate', () => {
  it('reads YYYY-MM-DD', () => {
    expect(parseImportDate('2026-03-05')).toEqual({ ok: true, day: '2026-03-05' });
  });

  it('reads DD/MM/YYYY as day first: 05/03/2026 is 5 March', () => {
    expect(parseImportDate('05/03/2026')).toEqual({ ok: true, day: '2026-03-05' });
    expect(parseImportDate('5/3/2026')).toEqual({ ok: true, day: '2026-03-05' });
    expect(parseImportDate('31/12/2026')).toEqual({ ok: true, day: '2026-12-31' });
  });

  it('takes an Excel date cell by its UTC day', () => {
    expect(parseImportDate(new Date('2026-03-05T00:00:00.000Z'))).toEqual({ ok: true, day: '2026-03-05' });
    expect(parseImportDate(new Date('invalid')).ok).toBe(false);
  });

  it('refuses other layouts as AMBIGUOUS', () => {
    for (const raw of ['05-03-2026', '3/5/26', '2026/03/05', '05.03.2026']) {
      expect(parseImportDate(raw)).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    }
  });

  it('refuses days that are not on the calendar and free text as INVALID', () => {
    for (const raw of ['2026-02-30', '31/04/2026', '2026-13-01', '00/01/2026', 'besok', '', '5 Maret 2026']) {
      expect(parseImportDate(raw)).toMatchObject({ ok: false, code: 'INVALID' });
    }
    expect(parseImportDate(undefined)).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('accepts 29 February only in a leap year', () => {
    expect(parseImportDate('29/02/2028').ok).toBe(true);
    expect(parseImportDate('29/02/2027').ok).toBe(false);
  });
});

describe('importDateToInstant', () => {
  it('is the start of the business day', () => {
    expect(businessDayOf(importDateToInstant('2026-03-05'))).toBe('2026-03-05');
  });
});

describe('parseImportAmount', () => {
  it('accepts plain text amounts and blank as zero', () => {
    expect(parseImportAmount('5000000')).toEqual({ ok: true, value: '5000000' });
    expect(parseImportAmount('1500.5')).toEqual({ ok: true, value: '1500.5' });
    expect(parseImportAmount('-5000000')).toEqual({ ok: true, value: '-5000000' });
    expect(parseImportAmount('  ')).toEqual({ ok: true, value: '0' });
    expect(parseImportAmount(undefined)).toEqual({ ok: true, value: '0' });
  });

  it('refuses thousands separators, 3 decimals, commas, exponents and words in text', () => {
    for (const raw of ['5.000.000', '5,000,000', '1,5', '1.234', '1e6', 'abc', 'Rp 5000', '.5']) {
      expect(parseImportAmount(raw).ok).toBe(false);
    }
  });

  it('rounds a float from a number or formula cell when it is within 1e-6 of 2 decimals', () => {
    expect(parseImportAmount('110000.00000000001', { fromNumberCell: true })).toEqual({ ok: true, value: '110000.00' });
    expect(parseImportAmount('0.30000000000000004', { fromNumberCell: true })).toEqual({ ok: true, value: '0.30' });
    expect(parseImportAmount('5000000', { fromNumberCell: true })).toEqual({ ok: true, value: '5000000.00' });
    expect(parseImportAmount('-5000000', { fromNumberCell: true })).toEqual({ ok: true, value: '-5000000.00' });
  });

  it('refuses a number cell with real extra decimals or a non-number', () => {
    expect(parseImportAmount('100.005', { fromNumberCell: true }).ok).toBe(false);
    expect(parseImportAmount('100.0000011', { fromNumberCell: true }).ok).toBe(false);
    expect(parseImportAmount('NaN', { fromNumberCell: true }).ok).toBe(false);
    expect(parseImportAmount('Infinity', { fromNumberCell: true }).ok).toBe(false);
  });

  it('turns -0 into 0', () => {
    expect(parseImportAmount('-0.0000001', { fromNumberCell: true })).toEqual({ ok: true, value: '0.00' });
  });
});
