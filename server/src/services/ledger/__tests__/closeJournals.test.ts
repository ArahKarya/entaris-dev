import { describe, expect, it, vi } from 'vitest';
import { closeJournalIds, closeJournalPredicate } from '../closeJournals';

describe('closeJournalPredicate', () => {
  it('without a year matches any FY_CLOSE journal or any CLOSE- number', () => {
    expect(closeJournalPredicate()).toEqual({
      OR: [{ sourceType: 'FY_CLOSE' }, { entryNumber: { startsWith: 'CLOSE-' } }],
    });
  });

  it('with a year matches that year only: FY_CLOSE, CLOSE-<name> or CLOSE-<name>-R<n>', () => {
    expect(closeJournalPredicate({ id: 'fy-1', name: '2025' })).toEqual({
      fiscalYearId: 'fy-1',
      OR: [{ sourceType: 'FY_CLOSE' }, { entryNumber: 'CLOSE-2025' }, { entryNumber: { startsWith: 'CLOSE-2025-R' } }],
    });
  });
});

describe('closeJournalIds', () => {
  it('returns the ids of the journals matched by the year-less predicate', async () => {
    const findMany = vi.fn(async () => [{ id: 'a' }, { id: 'b' }]);
    const ids = await closeJournalIds({ journalEntry: { findMany } } as never);
    expect(ids).toEqual(['a', 'b']);
    expect(findMany).toHaveBeenCalledWith({ where: closeJournalPredicate(), select: { id: true } });
  });
});
