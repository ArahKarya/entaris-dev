// The accountant's plan for the item vs warehouse drift repair (owner decision #18, PR-6.3d).
// The dry run of scripts/repair/e3-stock-drift.ts writes one row per drifting item with empty
// `action`, `warehouse_code` and `quantity` columns. Per item the accountant fills in, from a
// count per warehouse, one or more rows (copy the row to split an item):
//   assign    the goods are there: book `quantity` into `warehouse_code` (no journal, value kept);
//   writeoff  the goods are gone: an Adjustment − at the average to the Inventory Variance account.
// A blank `quantity` means the whole drift (only on an item's single row). The decided rows of an
// item must add up to its drift exactly. A negative drift (the warehouses hold more than the item
// total) can only be assigned with negative quantities: the excess leaves the wrong warehouse.
// Pure: stockDriftRepair.ts loads the drift and writes; this module parses and validates.

import { parse } from 'csv-parse/sync';
import Decimal from 'decimal.js';

export type DriftAction = 'assign' | 'writeoff';

export interface DriftAssignment {
  warehouseCode: string;
  quantity: Decimal;
  /** 1-based line in the file (the header is line 1). */
  line: number;
}

/** The decided repair of one item; assignments plus writeOff add up to drift. */
export interface DriftItemPlan {
  itemId: string;
  /** The drift the accountant decided on (the `drift` column of the dry run). */
  drift: Decimal;
  assignments: DriftAssignment[];
  /** 0 when nothing is written off. */
  writeOff: Decimal;
  lines: number[];
}

export interface DriftPlan {
  items: DriftItemPlan[];
  /** Rows with an empty `action`: items left undecided. */
  blank: number;
  /** Any error means nothing may be applied. */
  errors: string[];
}

export const DRIFT_PLAN_COLUMNS = ['item_id', 'drift', 'action', 'warehouse_code', 'quantity'] as const;

const ACTIONS: ReadonlySet<string> = new Set<DriftAction>(['assign', 'writeoff']);
/** Quantities have 3 decimals (numeric(15,3)); a spreadsheet with an Indonesian locale writes ',' for '.'. */
const QUANTITY = /^-?\d+([.,]\d{1,3})?$/;

/** Spreadsheets saved with an Indonesian locale separate columns with ';'. */
function delimiterOf(text: string): string {
  const header = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return header.includes(';') && !header.includes(',') ? ';' : ',';
}

/** The dry run writes a negative number as '-5 (utils/csv.ts keeps spreadsheets from reading it as a formula). */
function parseQuantity(raw: string): Decimal | null {
  const text = raw.replace(/^'/, '');
  return QUANTITY.test(text) ? new Decimal(text.replace(',', '.')) : null;
}

interface ParsedRow {
  line: number;
  itemId: string;
  drift: Decimal;
  action: DriftAction;
  warehouseCode: string | null;
  /** null: the whole drift. */
  quantity: Decimal | null;
}

function parseRow(r: Record<string, string>, line: number, errors: string[]): ParsedRow | 'blank' | null {
  const action = (r.action ?? '').trim().toLowerCase();
  if (action === '') return 'blank';
  const itemId = (r.item_id ?? '').trim();
  const drift = parseQuantity((r.drift ?? '').trim());
  const warehouseCode = (r.warehouse_code ?? '').trim() || null;
  const rawQty = (r.quantity ?? '').trim();
  const quantity = rawQty === '' ? null : parseQuantity(rawQty);
  const before = errors.length;
  if (!ACTIONS.has(action)) errors.push(`line ${line}: action "${r.action}" is not assign or writeoff.`);
  if (itemId === '') errors.push(`line ${line}: item_id is empty.`);
  if (!drift || drift.isZero()) errors.push(`line ${line}: drift "${r.drift ?? ''}" is not the drift of the dry run.`);
  if (rawQty !== '' && (!quantity || quantity.isZero())) errors.push(`line ${line}: quantity "${rawQty}" is not a non-zero number with up to 3 decimals.`);
  if (action === 'assign' && !warehouseCode) errors.push(`line ${line}: assign needs a warehouse_code.`);
  if (action === 'writeoff' && warehouseCode) errors.push(`line ${line}: writeoff takes no warehouse_code (the goods are in no warehouse).`);
  if (errors.length > before) return null;
  return { line, itemId, drift: drift!, action: action as DriftAction, warehouseCode, quantity };
}

/** Folds the rows of one item into its plan; pushes an error when they do not add up to the drift. */
function planItem(itemId: string, rows: ParsedRow[], errors: string[]): DriftItemPlan | null {
  const lines = rows.map((r) => r.line);
  const at = `item ${itemId} (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')})`;
  const drift = rows[0]!.drift;
  const before = errors.length;
  if (rows.some((r) => !r.drift.equals(drift))) errors.push(`${at}: the rows carry different drift values.`);
  if (rows.length > 1 && rows.some((r) => r.quantity === null)) errors.push(`${at}: a split item needs a quantity on every row.`);
  const quantityOf = (r: ParsedRow) => r.quantity ?? drift;
  if (rows.some((r) => quantityOf(r).isNegative() !== drift.isNegative())) {
    errors.push(`${at}: every quantity must have the sign of the drift ${drift.toString()}.`);
  }
  if (drift.isNegative() && rows.some((r) => r.action === 'writeoff')) {
    errors.push(`${at}: the warehouses hold more than the item total; only assign (negative quantities) can repair it.`);
  }
  const total = rows.reduce((sum, r) => sum.plus(quantityOf(r)), new Decimal(0));
  if (!total.equals(drift)) errors.push(`${at}: the quantities add up to ${total.toString()}, the drift is ${drift.toString()}.`);
  if (errors.length > before) return null;
  return {
    itemId,
    drift,
    assignments: rows.filter((r) => r.action === 'assign').map((r) => ({ warehouseCode: r.warehouseCode!, quantity: quantityOf(r), line: r.line })),
    writeOff: rows.filter((r) => r.action === 'writeoff').reduce((sum, r) => sum.plus(quantityOf(r)), new Decimal(0)),
    lines,
  };
}

/** Parses the accountant's plan; needs the columns of DRIFT_PLAN_COLUMNS (others are ignored). */
export function parseDriftPlanCsv(text: string): DriftPlan {
  let records: Record<string, string>[];
  try {
    records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, delimiter: delimiterOf(text) }) as Record<string, string>[];
  } catch (e) {
    return { items: [], blank: 0, errors: [`CSV cannot be read: ${(e as Error).message}`] };
  }
  const columns = records.length > 0 ? Object.keys(records[0]!) : [];
  const missing = DRIFT_PLAN_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) return { items: [], blank: 0, errors: missing.map((c) => `Missing column "${c}".`) };

  const errors: string[] = [];
  const byItem = new Map<string, ParsedRow[]>();
  let blank = 0;
  records.forEach((r, i) => {
    const row = parseRow(r, i + 2, errors);
    if (row === 'blank') blank++;
    else if (row) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);
  });
  const items = [...byItem.entries()]
    .map(([itemId, rows]) => planItem(itemId, rows, errors))
    .filter((p): p is DriftItemPlan => p !== null)
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  return { items: errors.length > 0 ? [] : items, blank, errors };
}

/**
 * Compares the plan with the drift read now (under the item locks when applying): an item whose
 * drift changed since the dry run, or that no longer drifts, refuses the whole plan.
 */
export function stalePlanErrors(items: readonly DriftItemPlan[], liveDrift: ReadonlyMap<string, Decimal>): string[] {
  const errors: string[] = [];
  for (const p of items) {
    const live = liveDrift.get(p.itemId);
    if (!live) errors.push(`item ${p.itemId}: not found or no drift any more; run the dry run again.`);
    else if (!live.equals(p.drift)) errors.push(`item ${p.itemId}: the drift is ${live.toString()} now, the plan was made for ${p.drift.toString()}; run the dry run again.`);
  }
  return errors;
}
