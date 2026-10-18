/** Calendar helpers in the business time zone (fixed UTC offset, see businessUtcOffset). */
import { businessUtcOffset } from '../../utils/listQuery';

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

/** Business calendar date (`YYYY-MM-DD`) of an instant. */
export function businessDateOf(instant: Date, offset: string = businessUtcOffset()): string {
  return toLocal(instant, offset).toISOString().slice(0, 10);
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

/** Instant of local midnight at the start of a business date. */
export function startOfBusinessDate(date: string, offset: string = businessUtcOffset()): Date {
  return new Date(`${date}T00:00:00.000${offset}`);
}

/** `YYYY-MM-DD` plus `days` (may be negative). Pure calendar arithmetic. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/** Parse `HH:MM` (00:00 to 23:59) into minutes; null when malformed. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
