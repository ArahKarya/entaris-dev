// Status mapping of the "ALE vs Fiscal Year" health check: warning while every year involved is
// open, error as soon as a closed year is, nothing to report otherwise.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const find = vi.hoisted(() => vi.fn());
vi.mock('../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../services/ledger/aleFiscalYearCheck', () => ({ findAleFiscalYearMismatches: find }));

import { checkAleFiscalYear } from '../health/fiscalYearChecks';

const row = (over: Record<string, unknown> = {}) => ({
  journalId: 'j1', entryNumber: 'JV-1', day: '2026-02-10', aleCount: 2, debit: { toNumber: () => 150 },
  storedYear: 'FY 2025', storedYearClosed: false, expectedYear: 'FY 2026', expectedYearClosed: false, ...over,
});

beforeEach(() => find.mockReset());

describe('checkAleFiscalYear', () => {
  it('is ok with no mismatch', async () => {
    find.mockResolvedValue({ total: 0, closedTotal: 0, rows: [] });
    expect(await checkAleFiscalYear()).toMatchObject({ name: 'ALE vs Fiscal Year', status: 'ok', count: 0, fixable: false });
  });

  it('is a warning while all years are open and reports the total, not the listed rows', async () => {
    find.mockResolvedValue({ total: 31, closedTotal: 0, rows: [row()] });
    const res = await checkAleFiscalYear();
    expect(find).toHaveBeenCalledWith(expect.anything(), { limit: 20 });
    expect(res).toMatchObject({ status: 'warning', count: 31 });
    expect(res.message).toContain('31');
    expect(res.details).toEqual([
      { journal_number: 'JV-1', date: '2026-02-10', entries: 2, amount: 150, stored_year: 'FY 2025', expected_year: 'FY 2026', closed_year: false },
    ]);
  });

  it('is an error when a closed year is involved, even beyond the listed rows', async () => {
    find.mockResolvedValue({ total: 25, closedTotal: 1, rows: [row()] });
    expect((await checkAleFiscalYear()).status).toBe('error');
  });
});
