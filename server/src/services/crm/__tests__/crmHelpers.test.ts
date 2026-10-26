import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDateOf,
  businessIsoWeekday,
  businessMinuteOfDay,
  daysBetween,
  parseClock,
} from '../businessDate';
import { normalizePhone } from '../phone';
import { matchesOwner } from '../owner';
import { evaluateReorder, type ReorderInput } from '../reorder';

describe('businessDate', () => {
  it('uses the business offset for the calendar date, weekday and clock', () => {
    // 2026-10-18 20:30 UTC = 2026-10-19 03:30 WIB (Monday)
    const instant = new Date('2026-10-18T20:30:00.000Z');
    expect(businessDateOf(instant, '+07:00')).toBe('2026-10-19');
    expect(businessIsoWeekday(instant, '+07:00')).toBe(1);
    expect(businessMinuteOfDay(instant, '+07:00')).toBe(3 * 60 + 30);
  });

  it('does calendar arithmetic across month ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-18')).toBe(17);
    expect(daysBetween('2026-10-18', '2026-10-01')).toBe(-17);
  });

  it('parses HH:MM clocks', () => {
    expect(parseClock('07:30')).toBe(450);
    expect(parseClock('23:59')).toBe(1439);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7:30')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it.each([
    ['0812-3456-7890', '6281234567890'],
    ['+62 812 3456 7890', '6281234567890'],
    ['81234567890', '6281234567890'],
    ['(021) 555-1234', '62215551234'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it('rejects inputs that cannot be phone numbers', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('0812')).toBeNull();
    expect(normalizePhone('0'.repeat(20))).toBeNull();
  });
});

describe('evaluateReorder', () => {
  const base: ReorderInput = {
    orderDates: ['2026-08-01', '2026-08-15', '2026-08-29', '2026-09-12'],
    manualCycleDays: null,
    minInvoices: 3,
    toleranceFactor: 1.5,
    today: '2026-10-01',
    snoozedUntil: null,
    lastContactOn: null,
  };

  it('computes the average cycle and flags a late Customer', () => {
    const r = evaluateReorder(base);
    expect(r.orderCount).toBe(4);
    expect(r.avgIntervalDays).toBe(14);
    expect(r.cycleSource).toBe('average');
    // 2026-09-12 + ceil(14 x 1.5) = 2026-10-03
    expect(r.lateAfter).toBe('2026-10-03');
    expect(r.state).toBe('ok');

    const late = evaluateReorder({ ...base, today: '2026-10-08' });
    expect(late.state).toBe('late');
    expect(late.overdueDays).toBe(5);
    expect(late.daysSinceLastOrder).toBe(26);
  });

  it('prefers the manual cycle set for the Customer', () => {
    const r = evaluateReorder({ ...base, manualCycleDays: 30, today: '2026-10-08' });
    expect(r.cycleSource).toBe('manual');
    expect(r.lateAfter).toBe('2026-10-27');
    expect(r.state).toBe('ok');
  });

  it('needs the minimum invoice count unless a manual cycle exists', () => {
    const few = { ...base, orderDates: ['2026-08-01', '2026-08-15'] };
    expect(evaluateReorder(few).state).toBe('insufficient');
    expect(evaluateReorder({ ...few, manualCycleDays: 10, today: '2026-09-15' }).state).toBe('late');
  });

  it('ignores duplicate dates and same-day orders', () => {
    const sameDay = { ...base, orderDates: ['2026-08-01', '2026-08-01', '2026-08-01'] };
    const r = evaluateReorder(sameDay);
    expect(r.orderCount).toBe(1);
    expect(r.state).toBe('insufficient');
  });

  it('respects a snooze until (inclusive) the given date', () => {
    const today = '2026-10-08';
    expect(evaluateReorder({ ...base, today, snoozedUntil: '2026-10-08' }).state).toBe('snoozed');
    expect(evaluateReorder({ ...base, today, snoozedUntil: '2026-10-07' }).state).toBe('late');
  });

  it('marks contact made after the Customer became late', () => {
    const today = '2026-10-08';
    expect(evaluateReorder({ ...base, today, lastContactOn: '2026-10-05' }).contactedSinceLate).toBe(true);
    expect(evaluateReorder({ ...base, today, lastContactOn: '2026-10-02' }).contactedSinceLate).toBe(false);
  });
});

describe('matchesOwner', () => {
  it('includes unowned rows unless strict, and supports unassigned', () => {
    expect(matchesOwner('u1', { ownerId: 'u1' })).toBe(true);
    expect(matchesOwner(null, { ownerId: 'u1' })).toBe(true);
    expect(matchesOwner(null, { ownerId: 'u1', strictOwner: true })).toBe(false);
    expect(matchesOwner('u2', { ownerId: 'u1' })).toBe(false);
    expect(matchesOwner(null, { ownerId: 'unassigned' })).toBe(true);
    expect(matchesOwner('u1', { ownerId: 'unassigned' })).toBe(false);
    expect(matchesOwner('u2', {})).toBe(true);
  });
});
