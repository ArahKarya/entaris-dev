/**
 * Pure helpers of the stock count form (E3-R11): which lines are sent, and which lines the server's
 * stock as of the count date moved away from since the form showed it.
 */

/** One line of GET /stock-opname/system-stock. */
export interface SystemStockRow {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  systemStock: number;
}

/** A line whose system stock moved since the form showed it: the user checks the count again. */
export interface StaleLine {
  expectedSystemStock: number;
  systemStock: number;
}

/** |shown − as of| above this is a changed stock; same tolerance as the server (quantities have 3 decimals). */
export const STOCK_CHANGE_TOLERANCE = 0.0005;

/** The entered count, or null when the cell is blank or not a number (an untouched line). */
export function parseCount(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Only the lines the user filled in, each with the system stock the form showed (expectedSystemStock). */
export function buildSubmitLines(rows: SystemStockRow[], counts: Record<string, string>) {
  return rows.flatMap((row) => {
    const actualStock = parseCount(counts[row.itemId]);
    return actualStock === null ? [] : [{ itemId: row.itemId, actualStock, expectedSystemStock: row.systemStock }];
  });
}

/** Filled-in lines whose freshly loaded system stock differs from the one the form showed. */
export function findStaleLines(
  shown: SystemStockRow[],
  fresh: SystemStockRow[],
  counts: Record<string, string>,
): Record<string, StaleLine> {
  const freshById = new Map(fresh.map((r) => [r.itemId, r.systemStock]));
  const out: Record<string, StaleLine> = {};
  for (const row of shown) {
    if (parseCount(counts[row.itemId]) === null) continue;
    const now = freshById.get(row.itemId) ?? 0;
    if (Math.abs(now - row.systemStock) > STOCK_CHANGE_TOLERANCE) {
      out[row.itemId] = { expectedSystemStock: row.systemStock, systemStock: now };
    }
  }
  return out;
}
