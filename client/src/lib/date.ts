/**
 * Calendar dates in the browser's own time zone (`YYYY-MM-DD`). Form "today" defaults use these;
 * `new Date().toISOString()` gives the UTC day, which is yesterday before 07:00 WIB.
 */

/** Local calendar day of a Date as `YYYY-MM-DD`. */
export function toLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today in the browser's calendar, optionally shifted by whole days (e.g. 30 for a due date). */
export function todayLocal(addDays = 0): string {
  const d = new Date();
  if (addDays) d.setDate(d.getDate() + addDays);
  return toLocalIsoDate(d);
}
