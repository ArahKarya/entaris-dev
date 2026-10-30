/** Calendar helpers in the business time zone; the shared implementation lives in utils/businessDate. */
export {
  addDays,
  businessDayOf as businessDateOf,
  businessIsoWeekday,
  businessMinuteOfDay,
  daysBetween,
  startOfBusinessDay as startOfBusinessDate,
} from '../../utils/businessDate';

/** Parse `HH:MM` (00:00 to 23:59) into minutes; null when malformed. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
