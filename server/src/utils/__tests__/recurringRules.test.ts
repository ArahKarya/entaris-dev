import { describe, expect, it } from 'vitest';
import { checkNextRunDate, validateJournalTemplateData } from '../recurringRules';
import { BusinessError } from '../errors';

// 2026-11-02 10:00 WIB
const NOW = new Date('2026-11-02T03:00:00.000Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('checkNextRunDate', () => {
  it('accepts today and later days', () => {
    expect(checkNextRunDate({ nextRunDate: '2026-11-02', now: NOW })).toEqual({ ok: true, date: new Date('2026-11-02T00:00:00.000Z') });
    expect(checkNextRunDate({ nextRunDate: '2027-01-31', now: NOW }).ok).toBe(true);
  });

  it('refuses a past day', () => {
    const r = checkNextRunDate({ nextRunDate: '2026-11-01', now: NOW });
    expect(r).toMatchObject({ ok: false, code: 'RECURRING_DATE_PAST' });
  });

  it('accepts a past day that equals the stored next run (edit leaves the date alone)', () => {
    const r = checkNextRunDate({ nextRunDate: '2026-10-15', now: NOW, previousNextRunDate: new Date('2026-10-15T00:00:00.000Z') });
    expect(r.ok).toBe(true);
  });

  it('refuses a day before the last run', () => {
    const r = checkNextRunDate({ nextRunDate: '2026-11-05', now: NOW, lastRunDate: new Date('2026-11-10T00:00:00.000Z') });
    expect(r).toMatchObject({ ok: false, code: 'RECURRING_DATE_BEFORE_LAST_RUN' });
    // the day of the last run is already posted
    expect(checkNextRunDate({ nextRunDate: '2026-11-10', now: NOW, lastRunDate: new Date('2026-11-10T00:00:00.000Z') })).toMatchObject({ ok: false, code: 'RECURRING_DATE_BEFORE_LAST_RUN' });
    expect(checkNextRunDate({ nextRunDate: '2026-11-11', now: NOW, lastRunDate: new Date('2026-11-10T00:00:00.000Z') }).ok).toBe(true);
  });

  it('accepts the UTC-day form of a scheduler-written next run and keeps the stored instant', () => {
    // 2026-12-02 02:00 WIB is 2026-12-01T19:00Z; the edit form sends back the UTC day.
    const prev = new Date('2026-12-01T19:00:00.000Z');
    const later = new Date('2026-12-02T03:00:00.000Z');
    expect(checkNextRunDate({ nextRunDate: '2026-12-01', now: later, previousNextRunDate: prev })).toEqual({ ok: true, date: prev });
    expect(checkNextRunDate({ nextRunDate: '2026-12-02', now: later, previousNextRunDate: prev })).toEqual({ ok: true, date: prev });
  });

  it('refuses a stale form date that falls on the last run day', () => {
    const r = checkNextRunDate({
      nextRunDate: '2026-11-02', now: NOW,
      lastRunDate: new Date('2026-11-02T03:00:00.000Z'), previousNextRunDate: new Date('2026-12-02T00:00:00.000Z'),
    });
    expect(r).toMatchObject({ ok: false, code: 'RECURRING_DATE_BEFORE_LAST_RUN' });
  });

  it('refuses malformed and non-existent calendar days', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '02/11/2026', '', '2026-11-2']) {
      expect(checkNextRunDate({ nextRunDate: bad, now: NOW })).toMatchObject({ ok: false, code: 'RECURRING_DATE_INVALID' });
    }
  });

  it('uses the WIB business day: 23:30 UTC is already the next day', () => {
    const lateUtc = new Date('2026-11-02T23:30:00.000Z'); // 2026-11-03 06:30 WIB
    expect(checkNextRunDate({ nextRunDate: '2026-11-02', now: lateUtc })).toMatchObject({ ok: false, code: 'RECURRING_DATE_PAST' });
    expect(checkNextRunDate({ nextRunDate: '2026-11-03', now: lateUtc }).ok).toBe(true);
    const earlyUtc = new Date('2026-11-02T16:30:00.000Z'); // 23:30 WIB, still 2 Nov
    expect(checkNextRunDate({ nextRunDate: '2026-11-02', now: earlyUtc }).ok).toBe(true);
  });
});

describe('validateJournalTemplateData', () => {
  const ok = { narration: 'Sewa', items: [{ accountId: A, debit: 10000000, credit: 0 }, { accountId: B, debit: '0', credit: '10000000.00', description: 'Kas' }] };

  it('normalizes amounts to 2-decimal strings', () => {
    const r = validateJournalTemplateData(ok);
    expect(r.items).toEqual([
      { accountId: A, debit: '10000000.00', credit: '0.00' },
      { accountId: B, debit: '0.00', credit: '10000000.00', description: 'Kas' },
    ]);
  });

  const codeOf = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as BusinessError).code; }
    return undefined;
  };

  it('refuses an unbalanced template', () => {
    const data = { ...ok, items: [{ accountId: A, debit: 10000000, credit: 0 }, { accountId: B, debit: 0, credit: 9000000 }] };
    expect(codeOf(() => validateJournalTemplateData(data))).toBe('JOURNAL_UNBALANCED');
  });

  it('refuses fewer than 2 lines, three-decimal amounts and both sides on one line', () => {
    expect(codeOf(() => validateJournalTemplateData({ narration: 'x', items: [{ accountId: A, debit: 5, credit: 0 }] }))).toBe('LINES_TOO_FEW');
    expect(codeOf(() => validateJournalTemplateData({ narration: 'x', items: [{ accountId: A, debit: 1.005, credit: 0 }, { accountId: B, debit: 0, credit: 1.005 }] }))).toBe('LINE_AMOUNT_PRECISION');
    expect(codeOf(() => validateJournalTemplateData({ narration: 'x', items: [{ accountId: A, debit: 5, credit: 5 }, { accountId: B, debit: 0, credit: 0 }] }))).toBe('LINE_BOTH_SIDES');
  });

  it('refuses a party on any line', () => {
    const data = { ...ok, items: [{ ...ok.items[0], partyId: 'p-1' }, ok.items[1]] };
    expect(codeOf(() => validateJournalTemplateData(data))).toBe('PARTY_NOT_ALLOWED');
    expect(validateJournalTemplateData({ ...ok, items: [{ ...ok.items[0], partyId: null }, { ...ok.items[1], partyId: '' }] }).items).toHaveLength(2);
  });
});
