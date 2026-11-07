import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  classifyStoredBalance,
  MAX_COMBINATIONS,
  MAX_COMBINED_YEARS,
  STORED_BALANCE_TOLERANCE,
  type RecalcYear,
  type YearContribution,
  type YearEvent,
} from '../storedBalances';

const year = (name: string, isClosed: boolean, reopened = false): RecalcYear => ({ fiscalYearId: `fy-${name}`, name, isClosed, reopened });
const ev = (action: YearEvent['action'], amount: string): YearEvent => ({ action, contribution: new Prisma.Decimal(amount) });
/** Without explicit events: a closed year was closed once, a reopened one closed and reopened, at today's amount. */
const contrib = (y: RecalcYear, amount: string, events?: YearEvent[]): YearContribution => ({
  year: y,
  contribution: new Prisma.Decimal(amount),
  events: events ?? (y.isClosed ? [ev('close', amount)] : y.reopened ? [ev('close', amount), ev('reopen', amount)] : []),
});

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

  it('uses the amount a reopen added back, not the year as it stands after later postings', () => {
    // close 2026 at 500, recalculate, reopen (+500), post 80 more: the year is now 580.
    const after = contrib(reopened2026, '580', [ev('close', '500'), ev('reopen', '500')]);
    expect(classifyStoredBalance('500', [after])).toEqual({ class: 'closed-year', explanation: '+2026' });
    expect(classifyStoredBalance('580', [after]).class).toBe('unexplained');
  });

  it('explains a year reopened after a recalculation and closed again by its last two events', () => {
    // close at 500, recalculate, reopen (+500), post 80, close again (-580): stored - ledger = -80.
    const again = contrib(year('2025', true, true), '580', [ev('close', '500'), ev('reopen', '500'), ev('close', '580')]);
    expect(classifyStoredBalance('-80', [again])).toEqual({ class: 'closed-year', explanation: '+2025 -2025' });
    // Without the recalculation every event counts: -500 +500 -580.
    expect(classifyStoredBalance('-580', [again])).toEqual({ class: 'closed-year', explanation: '-2025' });
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

  it('does not try more than MAX_COMBINATIONS combinations', () => {
    // Seven years with three candidates each: 4^7 combinations.
    const busy = Array.from({ length: 7 }, (_, i) =>
      contrib(year(`B${i}`, true, true), '3', [ev('close', '1'), ev('reopen', '1'), ev('close', '3')]));
    expect(4 ** 7).toBeGreaterThan(MAX_COMBINATIONS);
    expect(classifyStoredBalance('-3', busy)).toEqual({ class: 'unexplained', explanation: null });
  });
});
