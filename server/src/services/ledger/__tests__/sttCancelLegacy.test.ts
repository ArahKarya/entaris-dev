// Classes of the legacy STT cancel data (PR-6b, plan step 5 PR-5.2) from their facts, without a
// database. The queries and the writes are covered by sttCancelLegacyData.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { classifyLegacyStt, type LegacyJournalFacts, type LegacySttFacts } from '../sttCancelLegacy';
import { parseSttCancelArgs } from '../sttCancelLegacyArgs';

const journal = (over: Partial<LegacyJournalFacts> = {}): LegacyJournalFacts => ({
  status: 'Cancelled',
  reversedById: null,
  isDummy: false,
  aleActive: 2,
  aleCancelled: 0,
  ledgerMatchesLines: true,
  fiscalYearMatchesDate: true,
  ...over,
});

/** Class A facts; each case changes one thing. */
const facts = (over: Partial<LegacySttFacts> = {}, original: Partial<LegacyJournalFacts> = {}, cxl: Partial<LegacyJournalFacts> = {}): LegacySttFacts => ({
  sttStatus: 'Cancelled',
  original: journal(original),
  cxl: journal({ status: 'Submitted', ...cxl }),
  cxlId: 'cxl-1',
  legacyPair: true,
  linesMirrored: true,
  ...over,
});

describe('classifyLegacyStt', () => {
  it('A: original Cancelled with active ledger rows, CXL Submitted with active rows, lines mirrored', () => {
    expect(classifyLegacyStt(facts())).toEqual({ cls: 'A', reason: null });
  });

  it('B: the original ledger rows are all cancelled', () => {
    expect(classifyLegacyStt(facts({}, { aleActive: 0, aleCancelled: 2 }))).toEqual({ cls: 'B', reason: null });
  });

  it('PAIRED: original Submitted and reversed by the CXL (a second run)', () => {
    expect(classifyLegacyStt(facts({ legacyPair: false }, { status: 'Submitted', reversedById: 'cxl-1' }))).toEqual({ cls: 'PAIRED', reason: null });
  });

  it('C: a journal or its ledger rows booked to another year than its date', () => {
    expect(classifyLegacyStt(facts({}, {}, { fiscalYearMatchesDate: false }))).toEqual({ cls: 'C', reason: 'fy-differs' });
    expect(classifyLegacyStt(facts({}, { aleActive: 0, aleCancelled: 2, fiscalYearMatchesDate: false }))).toEqual({ cls: 'C', reason: 'fy-differs' });
  });

  it.each<[string, LegacySttFacts]>([
    ['original-missing', facts({ original: null })],
    ['dummy-journal', facts({}, { isDummy: true })],
    ['dummy-journal', facts({}, {}, { isDummy: true })],
    ['stt-not-cancelled', facts({ sttStatus: 'Submitted' })],
    ['original-not-cancelled', facts({}, { status: 'Submitted' })],
    ['original-not-cancelled', facts({}, { status: 'Submitted', reversedById: 'other' })],
    ['cxl-not-submitted', facts({}, {}, { status: 'Cancelled' })],
    ['already-reversed', facts({ legacyPair: false }, { reversedById: 'other' })],
    ['cxl-ale-not-active', facts({}, {}, { aleActive: 0, aleCancelled: 2 })],
    ['cxl-ale-not-active', facts({}, {}, { aleActive: 0, aleCancelled: 0 })],
    ['lines-not-mirrored', facts({ linesMirrored: false })],
    ['ale-missing', facts({}, { aleActive: 0, aleCancelled: 0 })],
    ['ale-mixed', facts({}, { aleActive: 1, aleCancelled: 1 })],
    ['ledger-not-lines', facts({}, { ledgerMatchesLines: false })],
    ['ledger-not-lines', facts({}, {}, { ledgerMatchesLines: false })],
  ])('REVIEW %s', (reason, f) => {
    expect(classifyLegacyStt(f)).toEqual({ cls: 'REVIEW', reason });
  });
});

describe('parseSttCancelArgs', () => {
  it('defaults to a dry run over every year', () => {
    expect(parseSttCancelArgs([])).toEqual({ apply: false, approvedBy: null, includeAleFix: false, fiscalYear: null, out: null });
  });

  it('reads --apply, the accountant, --include-ale-fix, --fy and --out', () => {
    expect(parseSttCancelArgs(['--apply', '--approved-by', ' Bu Sari ', '--include-ale-fix', '--fy', '2026', '--out', 'a.csv'])).toEqual({
      apply: true, approvedBy: 'Bu Sari', includeAleFix: true, fiscalYear: '2026', out: 'a.csv',
    });
  });

  it('rejects --apply without an accountant, --include-ale-fix without --apply, missing values and unknown arguments', () => {
    expect(() => parseSttCancelArgs(['--apply'])).toThrow(/--approved-by/);
    expect(() => parseSttCancelArgs(['--include-ale-fix'])).toThrow(/only goes with --apply/);
    expect(() => parseSttCancelArgs(['--apply', '--approved-by', '  '])).toThrow(/needs a value/);
    expect(() => parseSttCancelArgs(['--fy', '--apply'])).toThrow(/needs a value/);
    expect(() => parseSttCancelArgs(['--apply', '--dry-run', '--approved-by', 'X'])).toThrow(/either --apply or --dry-run/);
    expect(() => parseSttCancelArgs(['--force'])).toThrow(/Unknown argument/);
  });
});
