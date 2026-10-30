/**
 * Business-day helpers: calendar days in the business time zone (a fixed UTC offset, WIB by
 * default, see businessUtcOffset). Reports, fiscal-year lookup and document-number months all
 * use these so results never depend on the host's TZ. Never use local Date getters here.
 *
 * Ranges are half-open: [day 00:00, day-after 00:00) in the business offset. Documents stored at
 * local midnight or at UTC midnight of their date both fall inside the correct day.
 */
import { Prisma } from '@prisma/client';
import { businessUtcOffset, localDayRange, parseDateParam } from './listQuery';

export { businessUtcOffset, localDayRange, parseDateParam };

const DAY_MS = 24 * 60 * 60 * 1000;

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [h, m] = offset.slice(1).split(':').map(Number);
  return sign * (h * 60 + m);
}

/** Shift an instant into "local wall clock as UTC" so UTC getters read local fields. */
function toLocal(instant: Date, offset: string): Date {
  return new Date(instant.getTime() + offsetMinutes(offset) * 60 * 1000);
}

/** Business calendar day (`YYYY-MM-DD`) of an instant. */
export function businessDayOf(instant: Date, offset: string = businessUtcOffset()): string {
  return toLocal(instant, offset).toISOString().slice(0, 10);
}

/** Today's business day. */
export function businessToday(now: Date = new Date(), offset: string = businessUtcOffset()): string {
  return businessDayOf(now, offset);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of an instant in the business time zone. */
export function businessIsoWeekday(instant: Date, offset: string = businessUtcOffset()): number {
  const day = toLocal(instant, offset).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Minutes since local midnight of an instant in the business time zone. */
export function businessMinuteOfDay(instant: Date, offset: string = businessUtcOffset()): number {
  const local = toLocal(instant, offset);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Instant of local midnight at the start of a business day. */
export function startOfBusinessDay(day: string, offset: string = businessUtcOffset()): Date {
  return new Date(`${day}T00:00:00.000${offset}`);
}

/** `YYYY-MM-DD` plus `days` (may be negative). Pure calendar arithmetic. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

export interface InstantRange {
  gte: Date;
  lt: Date;
}

/** One business day as a half-open instant range. */
export function businessDayRange(day: string, offset: string = businessUtcOffset()): InstantRange {
  return { gte: startOfBusinessDay(day, offset), lt: startOfBusinessDay(addDays(day, 1), offset) };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A business month (`month1` is 1-12) as a half-open range plus its first and last day. */
export function businessMonthRange(
  year: number,
  month1: number,
  offset: string = businessUtcOffset(),
): InstantRange & { firstDay: string; lastDay: string } {
  const firstDay = `${year}-${pad2(month1)}-01`;
  const nextFirst = month1 === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month1 + 1)}-01`;
  return {
    gte: startOfBusinessDay(firstDay, offset),
    lt: startOfBusinessDay(nextFirst, offset),
    firstDay,
    lastDay: addDays(nextFirst, -1),
  };
}

/** Year and month (1-12) of the business day of an instant. */
export function businessYearMonth(instant: Date, offset: string = businessUtcOffset()): { year: number; month: number } {
  const [year, month] = businessDayOf(instant, offset).split('-').map(Number);
  return { year, month };
}

/** `YYYY-MM` keys of every month from the month of `startDay` to that of `endDay`, inclusive. */
export function monthKeys(startDay: string, endDay: string): string[] {
  const keys: string[] = [];
  let [y, m] = startDay.split('-').map(Number);
  const [endY, endM] = endDay.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    keys.push(`${y}-${pad2(m)}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

export type ReportRangeResult =
  | { ok: true; range: { gte?: Date; lt?: Date }; startDay?: string; endDay?: string }
  | { ok: false; field: 'startDate' | 'endDate'; error: string };

/**
 * Parse `startDate`/`endDate` query params (`YYYY-MM-DD`, both inclusive) into a half-open
 * business-day range. Blank or absent params use `defaults`; malformed ones are rejected so the
 * caller can answer 400.
 */
export function reportRange(
  query: Record<string, unknown>,
  defaults: { start?: string; end?: string },
  offset: string = businessUtcOffset(),
): ReportRangeResult {
  const start = parseDateParam(query.startDate);
  if (start === null) return { ok: false, field: 'startDate', error: 'Parameter startDate tidak valid.' };
  const end = parseDateParam(query.endDate);
  if (end === null) return { ok: false, field: 'endDate', error: 'Parameter endDate tidak valid.' };
  const startDay = start ?? defaults.start;
  const endDay = end ?? defaults.end;
  return { ok: true, range: localDayRange(startDay, endDay, offset), startDay, endDay };
}

export type AsOfBoundResult = { ok: true; day: string; lt: Date } | { ok: false; error: string };

/** An inclusive "as of" day param (default: today) as an exclusive upper bound `lt`. */
export function asOfBound(
  value: unknown,
  defaultDay?: string,
  offset: string = businessUtcOffset(),
): AsOfBoundResult {
  const parsed = parseDateParam(value);
  if (parsed === null) return { ok: false, error: 'Parameter date tidak valid.' };
  const day = parsed ?? defaultDay ?? businessToday(new Date(), offset);
  return { ok: true, day, lt: businessDayRange(day, offset).lt };
}

/**
 * SQL expression for a UTC `timestamp without time zone` column shifted to business wall time,
 * for `date_trunc` bucketing. (`col AT TIME ZONE 'Asia/Jakarta'` would shift the wrong way.)
 * The offset is a bound parameter, so GROUP BY must reference the output column (`GROUP BY 1`).
 */
export function sqlBusinessTs(col: Prisma.Sql, offset: string = businessUtcOffset()): Prisma.Sql {
  return Prisma.sql`(${col} + ${offset}::interval)`;
}
