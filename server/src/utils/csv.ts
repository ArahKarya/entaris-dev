// CSV cell for files people open in a spreadsheet. Text starting with = + - @ (or tab/CR) gets a
// leading apostrophe so Excel/Sheets show it as text instead of evaluating it as a formula.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  const raw = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  const s = typeof v === 'string' && FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
