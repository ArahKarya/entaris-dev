import { describe, it, expect } from 'vitest';
import { parseAuditArgs } from '../../../services/ledger/ledgerAudit/args';
import { auditCsv, gateExitCode, LEDGER_AUDIT_SECTIONS, type AuditRow, type LedgerAuditResult } from '../../../services/ledger/ledgerAudit';

const row = (over: Partial<AuditRow>): AuditRow => ({
  section: 's', cause: 'c', key: 'k', label: 'l', date: null, amount: null, count: 1, yearClosed: false, gate: true, detail: '', ...over,
});

const result = (sections: LedgerAuditResult['sections']): LedgerAuditResult => ({ sections });

describe('parseAuditArgs', () => {
  it('defaults to everything, no gate', () => {
    expect(parseAuditArgs([])).toEqual({ out: null, sections: [], since: null, gate: null });
  });

  it('reads out, repeated sections, since and gate', () => {
    const o = parseAuditArgs(['--out', 'a.csv', '--section', 'aleGroups', '--section', 'sourceNull', '--section', 'aleGroups', '--since', '2026-11-01', '--gate', 'trigger']);
    expect(o.out).toBe('a.csv');
    expect(o.sections).toEqual(['aleGroups', 'sourceNull']);
    expect(o.gate).toBe('trigger');
    // 2026-11-01 00:00 in the business offset (+07:00) is the previous day 17:00 UTC.
    expect(o.since?.toISOString()).toBe('2026-10-31T17:00:00.000Z');
  });

  it('rejects unknown arguments, sections, gates and bad dates', () => {
    expect(() => parseAuditArgs(['--apply'])).toThrow(/Unknown argument/);
    expect(() => parseAuditArgs(['--section', 'nope'])).toThrow(/Unknown section/);
    expect(() => parseAuditArgs(['--gate', 'x'])).toThrow(/--gate must be/);
    expect(() => parseAuditArgs(['--since', '01-11-2026'])).toThrow(/--since needs a date/);
    expect(() => parseAuditArgs(['--out'])).toThrow(/needs a value/);
    expect(() => parseAuditArgs(['--out', '--gate', 'trigger'])).toThrow(/needs a value/);
  });
});

describe('gateExitCode', () => {
  const open = row({ gate: true });
  const closed = row({ gate: false, yearClosed: true });

  it('is 0 without --gate whatever was found', () => {
    expect(gateExitCode(result([{ id: 'aleGroups', title: '', gate: 'trigger', rows: [open], gateRows: 1 }]), null)).toBe(0);
  });

  it('is 1 when a section of the gate has an open-year finding', () => {
    expect(gateExitCode(result([{ id: 'aleGroups', title: '', gate: 'trigger', rows: [open], gateRows: 1 }]), 'trigger')).toBe(1);
  });

  it('is 0 when the only findings are in closed years', () => {
    expect(gateExitCode(result([{ id: 'aleGroups', title: '', gate: 'trigger', rows: [closed], gateRows: 0 }]), 'trigger')).toBe(0);
  });

  it('ignores findings of sections guarding the other gate', () => {
    expect(gateExitCode(result([{ id: 'journalSubCent', title: '', gate: 'tolerance', rows: [open], gateRows: 1 }]), 'trigger')).toBe(0);
    expect(gateExitCode(result([{ id: 'journalSubCent', title: '', gate: 'tolerance', rows: [open], gateRows: 1 }]), 'tolerance')).toBe(1);
  });
});

describe('registry and csv', () => {
  it('has unique section ids', () => {
    const ids = LEDGER_AUDIT_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('aleGroups');
  });

  it('writes a header and one escaped line per row', () => {
    const csv = auditCsv(result([{ id: 's', title: '', gate: null, rows: [row({ label: 'a,b', detail: '=1+1', yearClosed: null, gate: false })], gateRows: 0 }]));
    const [header, line] = csv.trimEnd().split('\n');
    expect(header).toBe('section,cause,key,label,date,amount,count,year_closed,gate,detail');
    expect(line).toBe('s,c,k,"a,b",,,1,,no,\'=1+1');
  });
});
