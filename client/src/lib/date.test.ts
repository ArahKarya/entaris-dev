import { afterEach, describe, expect, it, vi } from 'vitest';
import { toLocalIsoDate, todayLocal } from './date';

describe('local calendar dates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the local calendar fields, not the UTC day', () => {
    // Built from local fields, so it is 1 Feb 02:00 wherever the test runs.
    expect(toLocalIsoDate(new Date(2026, 1, 1, 2, 0))).toBe('2026-02-01');
    expect(toLocalIsoDate(new Date(2026, 11, 31, 23, 30))).toBe('2026-12-31');
  });

  it('gives today and shifted days across month and year ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 1, 0));
    expect(todayLocal()).toBe('2026-12-31');
    expect(todayLocal(1)).toBe('2027-01-01');
    expect(todayLocal(30)).toBe('2027-01-30');
  });
});
