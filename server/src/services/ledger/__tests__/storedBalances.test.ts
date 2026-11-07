import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  classifyStoredBalance,
  MAX_COMBINED_YEARS,
  STORED_BALANCE_TOLERANCE,
  type RecalcYear,
  type YearContribution,
} from '../storedBalances';

const year = (name: string, isClosed: boolean, reopened = false): RecalcYear => ({ fiscalYearId: `fy-${name}`, name, isClosed, reopened });
const contrib = (y: RecalcYear, amount: string): YearContribution => ({ year: y, contribution: new Prisma.Decimal(amount) });

const closed2024 = year('2024', true);
const closed2025 = year('2025', true);
const reopened2026 = year('2026', false, true);
const open2027 = year('2027', false);

describe('classifyStoredBalance', () => {
  it('is ok within half a cent, whatever the contributions', () => {
    expect(classifyStoredBalance('0', [])).toEqual({ class: 'ok', explanation: null });
    expect(classifyStoredBalance('0.005', [contrib(closed2024, '100')])).toEqual({ class: 'ok', explanation: null });
    expect(classifyStoredBalance('-0.005', [])).toEqual({ class: 'ok', explanation: null });
    expect(STORED_BALANCE_TOLERANCE.toString()).toBe('0.005');
  });

  it('explains a closed year subtracted by the close (stored - ledger = -contribution)', () => {
    expect(classifyStoredBalance('-1000000000', [contrib(closed2024, '1000000000'), contrib(closed2025, '200000000')]))
      .toEqual({ class: 'closed-year', explanation: '-2024' });
  });

  it('explains two closed years together', () => {
    expect(classifyStoredBalance('-1200000000', [contrib(closed2024, '1000000000'), contrib(closed2025, '200000000')]))
      .toEqual({ class: 'closed-year', explanation: '-2024 -2025' });
  });

  it('explains a reopened year added back after a recalculation, combined with a closed one', () => {
    // close 2026, recalculate, reopen 2026 (+), close 2025 (-)
    expect(classifyStoredBalance('300', [contrib(closed2025, '200'), contrib(reopened2026, '500')]))
      .toEqual({ class: 'closed-year', explanation: '-2025 +2026' });
  });

  it('gives a closed year only the minus sign and an open year none', () => {
    expect(classifyStoredBalance('1000', [contrib(closed2024, '1000')]).class).toBe('unexplained');
    expect(classifyStoredBalance('-500', [contrib(reopened2026, '500')]).class).toBe('unexplained');
    expect(classifyStoredBalance('-700', [contrib(open2027, '700')]).class).toBe('unexplained');
  });

  it('treats a negative contribution (an expense refund year) by its sign', () => {
    expect(classifyStoredBalance('250.50', [contrib(closed2024, '-250.50')]))
      .toEqual({ class: 'closed-year', explanation: '-2024' });
  });

  it('accepts the sum within the tolerance and refuses beyond it', () => {
    expect(classifyStoredBalance('-100.004', [contrib(closed2024, '100')]).class).toBe('closed-year');
    expect(classifyStoredBalance('-100.01', [contrib(closed2024, '100')]).class).toBe('unexplained');
  });

  it('is unexplained for a balance-sheet style difference without contributions', () => {
    expect(classifyStoredBalance('12345.67', [])).toEqual({ class: 'unexplained', explanation: null });
  });

  it('prefers the smallest set of years', () => {
    // -300 is -C alone and also -A -B; the single year is reported.
    const a = year('A', true);
    const b = year('B', true);
    const c = year('C', true);
    expect(classifyStoredBalance('-300', [contrib(a, '100'), contrib(b, '200'), contrib(c, '300')]))
      .toEqual({ class: 'closed-year', explanation: '-C' });
  });

  it('does not combine more than MAX_COMBINED_YEARS years', () => {
    const many = Array.from({ length: MAX_COMBINED_YEARS + 1 }, (_, i) => contrib(year(`Y${i}`, true), '1'));
    expect(classifyStoredBalance('-1', many)).toEqual({ class: 'unexplained', explanation: null });
  });
});
