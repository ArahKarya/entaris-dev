// Causes of a journal whose ledger rows differ from its lines (E2-R14, PR-5.1): the pure rule
// classifyAleMismatch, which the SQL CASE of findAleJournalMismatches is built from.
import { describe, expect, it } from 'vitest';
import { ALE_MISMATCH_CAUSES, classifyAleMismatch, type AleMismatchFacts } from '../aleSyncCheck';
import { legacyCxlPairSql } from '../legacyCxlPair';

const facts = (over: Partial<AleMismatchFacts>): AleMismatchFacts => ({
  journalExists: true, status: 'Submitted', hasLedger: true, legacyPair: false, ...over,
});

describe('classifyAleMismatch', () => {
  it.each<[string, Partial<AleMismatchFacts>, string]>([
    ['submitted without ledger rows', { hasLedger: false }, 'no-ledger'],
    ['ledger rows of a missing journal', { journalExists: false, status: null }, 'ledger-without-journal'],
    ['cancelled with active ledger rows', { status: 'Cancelled' }, 'cancelled-active-ale'],
    ['cancelled with active ledger rows and a -CXL journal', { status: 'Cancelled', legacyPair: true }, 'legacy-stt-pair'],
    ['draft with active ledger rows', { status: 'Draft' }, 'draft-with-ale'],
    ['submitted with both sides', {}, 'amount-differs'],
  ])('%s: %s', (_label, over, cause) => {
    expect(classifyAleMismatch(facts(over))).toBe(cause);
  });

  it('a missing journal wins over everything else; a pair flag on a submitted journal is ignored', () => {
    expect(classifyAleMismatch(facts({ journalExists: false, status: null, legacyPair: true }))).toBe('ledger-without-journal');
    expect(classifyAleMismatch(facts({ legacyPair: true }))).toBe('amount-differs');
  });

  it('knows exactly six causes', () => {
    expect([...ALE_MISMATCH_CAUSES].sort()).toEqual(
      ['amount-differs', 'cancelled-active-ale', 'draft-with-ale', 'ledger-without-journal', 'legacy-stt-pair', 'no-ledger'],
    );
  });
});

describe('legacyCxlPairSql', () => {
  it('reads the -CXL journal of the aliased row and its reversed_by_id', () => {
    const sql = legacyCxlPairSql('je').sql;
    expect(sql).toContain("je.entry_number || '-CXL'");
    expect(sql).toContain('je.reversed_by_id IS NULL');
    expect(sql).toContain("cxl_pair.status = 'Submitted'");
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(() => legacyCxlPairSql('je; DROP TABLE x')).toThrow(/Invalid SQL alias/);
  });
});
