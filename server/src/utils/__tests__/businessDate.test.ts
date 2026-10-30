import { describe, it, expect, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  addDays,
  asOfBound,
  businessDayOf,
  businessDayRange,
  businessMonthRange,
  businessToday,
  businessYearMonth,
  monthKeys,
  reportRange,
  sqlBusinessTs,
} from '../businessDate';

// Every case pins the offset (or APP_UTC_OFFSET) so results never depend on the host TZ.
const WIB = '+07:00';

describe('businessDayOf / businessToday', () => {
  it('reads the calendar day in the business offset, not UTC or host time', () => {
    // 1 Feb 02:00 WIB is still 31 Jan in UTC.
    expect(businessDayOf(new Date('2026-01-31T19:00:00.000Z'), WIB)).toBe('2026-02-01');
    // 31 Dec 23:30 WIB
    expect(businessDayOf(new Date('2026-12-31T16:30:00.000Z'), WIB)).toBe('2026-12-31');
    // 1 Jan 03:00 WIB
    expect(businessDayOf(new Date('2026-12-31T20:00:00.000Z'), WIB)).toBe('2027-01-01');
    // UTC-midnight date-only values stay on their own day.
    expect(businessDayOf(new Date('2026-03-15T00:00:00.000Z'), WIB)).toBe('2026-03-15');
  });

  it('supports negative and non-WIB offsets', () => {
    expect(businessDayOf(new Date('2026-03-15T02:00:00.000Z'), '-05:00')).toBe('2026-03-14');
    expect(businessDayOf(new Date('2026-03-15T15:30:00.000Z'), '+09:00')).toBe('2026-03-16');
  });

  it('businessToday uses the given instant', () => {
    expect(businessToday(new Date('2026-10-26T18:00:00.000Z'), WIB)).toBe('2026-10-27');
  });
});

describe('businessDayRange / businessMonthRange', () => {
  it('is half-open [00:00, next 00:00) in the business offset', () => {
    expect(businessDayRange('2026-02-01', WIB)).toEqual({
      gte: new Date('2026-01-31T17:00:00.000Z'),
      lt: new Date('2026-02-01T17:00:00.000Z'),
    });
  });

  it('covers a whole business month including its last day', () => {
    const feb = businessMonthRange(2026, 2, WIB);
    expect(feb).toEqual({
      gte: new Date('2026-01-31T17:00:00.000Z'),
      lt: new Date('2026-02-28T17:00:00.000Z'),
      firstDay: '2026-02-01',
      lastDay: '2026-02-28',
    });
    expect(businessMonthRange(2028, 2, WIB).lastDay).toBe('2028-02-29');
  });

  it('rolls December into the next year', () => {
    const dec = businessMonthRange(2026, 12, WIB);
    expect(dec.lastDay).toBe('2026-12-31');
    expect(dec.lt).toEqual(new Date('2026-12-31T17:00:00.000Z'));
    const jan = businessMonthRange(2027, 1, WIB);
    expect(jan.gte).toEqual(dec.lt);
  });
});

describe('businessYearMonth', () => {
  it('takes year and month from the business day', () => {
    expect(businessYearMonth(new Date('2026-01-31T19:00:00.000Z'), WIB)).toEqual({ year: 2026, month: 2 });
    expect(businessYearMonth(new Date('2026-12-31T20:00:00.000Z'), WIB)).toEqual({ year: 2027, month: 1 });
    expect(businessYearMonth(new Date('2026-03-01T00:00:00.000Z'), WIB)).toEqual({ year: 2026, month: 3 });
  });
});

describe('addDays / monthKeys', () => {
  it('does pure calendar arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lists every month touched by a day span', () => {
    expect(monthKeys('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthKeys('2026-02-01', '2026-02-28')).toEqual(['2026-02']);
    expect(monthKeys('2026-03-01', '2026-02-01')).toEqual([]);
  });
});

describe('reportRange', () => {
  afterEach(() => {
    delete process.env.APP_UTC_OFFSET;
  });

  it('turns inclusive start/end days into a half-open instant range', () => {
    const r = reportRange({ startDate: '2026-02-01', endDate: '2026-02-28' }, {}, WIB);
    expect(r).toEqual({
      ok: true,
      range: { gte: new Date('2026-01-31T17:00:00.000Z'), lt: new Date('2026-02-28T17:00:00.000Z') },
      startDay: '2026-02-01',
      endDay: '2026-02-28',
    });
  });

  it('puts an entry at 1 Feb 02:00 WIB in February, not January', () => {
    const at = new Date('2026-01-31T19:00:00.000Z').getTime();
    const jan = reportRange({ startDate: '2026-01-01', endDate: '2026-01-31' }, {}, WIB);
    const feb = reportRange({ startDate: '2026-02-01', endDate: '2026-02-28' }, {}, WIB);
    if (!jan.ok || !feb.ok) throw new Error('unexpected');
    const inside = (r: { gte?: Date; lt?: Date }) => at >= r.gte!.getTime() && at < r.lt!.getTime();
    expect(inside(jan.range)).toBe(false);
    expect(inside(feb.range)).toBe(true);
  });

  it('falls back to defaults and treats blanks as absent', () => {
    const r = reportRange({ startDate: '' }, { start: '2026-01-01', end: '2026-01-31' }, WIB);
    expect(r).toMatchObject({ ok: true, startDay: '2026-01-01', endDay: '2026-01-31' });
    const open = reportRange({}, {}, WIB);
    expect(open).toEqual({ ok: true, range: {}, startDay: undefined, endDay: undefined });
  });

  it('rejects malformed dates naming the field', () => {
    expect(reportRange({ startDate: '2026-2-1' }, {}, WIB)).toEqual({
      ok: false,
      field: 'startDate',
      error: 'Parameter startDate tidak valid.',
    });
    expect(reportRange({ endDate: '2026-02-01T10:00:00Z' }, {}, WIB)).toMatchObject({ ok: false, field: 'endDate' });
  });

  it('reads APP_UTC_OFFSET when no offset is passed', () => {
    process.env.APP_UTC_OFFSET = '+08:00';
    const r = reportRange({ startDate: '2026-02-01' }, {}, undefined);
    expect(r).toMatchObject({ ok: true, range: { gte: new Date('2026-01-31T16:00:00.000Z') } });
  });
});

describe('asOfBound', () => {
  it('returns the start of the day after the as-of day', () => {
    expect(asOfBound('2026-02-28', undefined, WIB)).toEqual({
      ok: true,
      day: '2026-02-28',
      lt: new Date('2026-02-28T17:00:00.000Z'),
    });
  });

  it('uses the default day when absent and rejects malformed input', () => {
    expect(asOfBound(undefined, '2026-01-31', WIB)).toMatchObject({ ok: true, day: '2026-01-31' });
    expect(asOfBound('31/01/2026', '2026-01-31', WIB)).toEqual({ ok: false, error: 'Parameter date tidak valid.' });
  });
});

describe('sqlBusinessTs', () => {
  it('shifts a UTC timestamp column by the offset as a bound parameter', () => {
    const sql = sqlBusinessTs(Prisma.sql`ale.date`, WIB);
    expect(sql.sql).toBe('(ale.date + ?::interval)');
    expect(sql.values).toEqual([WIB]);
  });
});
