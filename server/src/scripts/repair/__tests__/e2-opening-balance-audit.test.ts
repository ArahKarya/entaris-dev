import { describe, it, expect } from 'vitest';
import { openingAuditExitCode, parseOpeningAuditArgs } from '../../../services/ledger/openingBalanceAuditArgs';

describe('parseOpeningAuditArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseOpeningAuditArgs([])).toEqual({ apply: false, approvedBy: null, keyJournals: [], checkDuplicates: false, out: null });
  });

  it('accepts --check-duplicates alone (the deploy gate of PR-5.14)', () => {
    expect(parseOpeningAuditArgs(['--check-duplicates'])).toMatchObject({ checkDuplicates: true, apply: false });
  });

  it('reads --apply, the accountant, repeated --key-journal and --out', () => {
    const o = parseOpeningAuditArgs(['--apply', '--approved-by', ' Bu Sari ', '--key-journal', 'OB-214903-1', '--key-journal', 'JV-1', '--out', 'a.csv']);
    expect(o).toEqual({ apply: true, approvedBy: 'Bu Sari', keyJournals: ['OB-214903-1', 'JV-1'], checkDuplicates: false, out: 'a.csv' });
  });

  it('rejects --apply without an accountant, missing values, mixed modes and unknown arguments', () => {
    expect(() => parseOpeningAuditArgs(['--apply'])).toThrow(/--approved-by/);
    expect(() => parseOpeningAuditArgs(['--apply', '--approved-by', '  '])).toThrow(/needs a value/);
    expect(() => parseOpeningAuditArgs(['--key-journal'])).toThrow(/needs a value/);
    expect(() => parseOpeningAuditArgs(['--out', '--apply'])).toThrow(/needs a value/);
    expect(() => parseOpeningAuditArgs(['--apply', '--dry-run', '--approved-by', 'X'])).toThrow(/either --apply or --dry-run/);
    expect(() => parseOpeningAuditArgs(['--check-duplicates', '--out', 'a.csv'])).toThrow(/takes no other argument/);
    expect(() => parseOpeningAuditArgs(['--force'])).toThrow(/Unknown argument/);
  });
});

describe('openingAuditExitCode', () => {
  it('is 1 while a duplicate active key exists, 0 otherwise', () => {
    expect(openingAuditExitCode([])).toBe(0);
    expect(openingAuditExitCode([{ sourceType: 'RECURRING', sourceKey: 'RECURRING:t:2149-03-10', entryNumbers: ['A', 'B'] }])).toBe(1);
  });
});
