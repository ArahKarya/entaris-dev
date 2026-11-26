import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { calcWeightedAverage } from './weightedAverage';
import {
  UNIT_COST_DP, VALUATION_BASELINE_REFERENCE, averageAfter, outboundValue,
} from '../services/inventory/inventoryValueMath';

/**
 * Weighted-average-cost (WAC) REPLAY.
 *
 * A blend cannot be undone, so after a cancel/edit the average is re-derived by
 * replaying ALL remaining movements in original order (createdAt, then id) with the
 * same rules as `calcWeightedAverage`. Averaging inbounds in one shot is wrong: it
 * ignores stock consumed in between and negative-stock windows.
 *
 * Rules:
 *  - cancelled movements are skipped;
 *  - In / AdjustmentIn -> WAC blend at its unit cost, then stock += qty. Every inbound blends,
 *    a zero-cost one (customer-owned goods, an output at NRV 0), a sales return and an opname
 *    gain included, as on the value ledger (E3-R7): an inbound row adds its value to the book.
 *    The replay is a diagnosis; the book of an item is its stock_value (inventoryLedger.ts);
 *  - Out / AdjustmentOut -> stock -= qty, avg untouched;
 *  - TransferIn / TransferOut -> stock only (item-level they net to zero);
 *  - Revaluation (qty 0, value only) -> nothing: this replay is unit-cost based; the value-based
 *    replay of the ledger is replayItemValue below.
 *
 * Pure function: no I/O, no mutation of its input.
 */

export type ReplayMovementType =
  | 'In'
  | 'Out'
  | 'AdjustmentIn'
  | 'AdjustmentOut'
  | 'TransferIn'
  | 'TransferOut'
  | 'Revaluation';

export interface ReplayMovement {
  id: string;
  movementType: ReplayMovementType;
  quantity: number | string | Decimal;
  unitCost: number | string | Decimal;
  /** Processing order (DB created_at), NOT the user-entered document date. */
  createdAt: Date | string | number;
  referenceType?: string | null;
  isCancelled?: boolean;
}

export interface ReplayResult {
  /** Replayed average, or `fallbackAverageCost` when no costed inbound remains. */
  averageCost: number;
  /** Running stock after the replay (can be negative). */
  stock: number;
  /** True when at least one inbound movement contributed to the average. */
  hasCostedInbound: boolean;
}

/** Inbound types that blend into the average. */
const COSTED_IN_TYPES = new Set<ReplayMovementType>(['In', 'AdjustmentIn']);
const STOCK_IN_TYPES = new Set<ReplayMovementType>(['In', 'AdjustmentIn', 'TransferIn']);

/** True when this movement blends into the average: every In / AdjustmentIn (value ledger, E3-R7). */
export function movementBlendsAverage(m: Pick<ReplayMovement, 'movementType'>): boolean {
  return COSTED_IN_TYPES.has(m.movementType);
}

const toMillis = (v: Date | string | number): number =>
  v instanceof Date ? v.getTime() : new Date(v).getTime();

/** Chronological order = createdAt, then id (deterministic tiebreak). */
export function sortMovementsForReplay<T extends Pick<ReplayMovement, 'id' | 'createdAt'>>(movements: readonly T[]): T[] {
  return [...movements].sort((a, b) => {
    const d = toMillis(a.createdAt) - toMillis(b.createdAt);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface ReplayOptions {
  /** Returned when no costed inbound remains (never zero an item). */
  fallbackAverageCost: number | string | Decimal;
  /** Stock/avg base before the first movement (default 0 / 0). */
  openingStock?: number | string | Decimal;
  openingAverageCost?: number | string | Decimal;
  /**
   * Which rows blend into the average (default movementBlendsAverage). A read-only audit of rows
   * the old live code valued passes the rule that code had (manualMovementAudit.ts).
   */
  blends?: (m: ReplayMovement) => boolean;
}

export function replayWeightedAverage(
  movements: readonly ReplayMovement[],
  options: ReplayOptions,
): ReplayResult {
  let stock = new Decimal((options.openingStock ?? 0).toString());
  let avg = new Decimal((options.openingAverageCost ?? 0).toString());
  let hasCostedInbound = false;
  const blends = options.blends ?? movementBlendsAverage;

  for (const m of sortMovementsForReplay(movements)) {
    if (m.isCancelled) continue;
    const qty = new Decimal(m.quantity.toString());
    if (blends(m)) {
      avg = new Decimal(calcWeightedAverage(stock, avg, qty, new Decimal(m.unitCost.toString())));
      hasCostedInbound = true;
    }
    stock = STOCK_IN_TYPES.has(m.movementType) ? stock.plus(qty) : stock.minus(qty);
  }

  const resolved = hasCostedInbound ? avg : new Decimal(options.fallbackAverageCost.toString());
  return {
    averageCost: resolved.toDecimalPlaces(UNIT_COST_DP).toNumber(),
    stock: stock.toNumber(),
    hasCostedInbound,
  };
}

/**
 * VALUE replay of one item on the value ledger (plan §2.3; the true-up of a cancel, PR-6.5a).
 *
 * It starts from the item's last active ValuationBaseline row: the opening state is the quantity
 * and value of the active rows up to and including it (the book as the baseline left it). Rows after
 * it are replayed in processing order (createdAt, then movement number, then id):
 *  - In / AdjustmentIn and Revaluation -> their recorded value_delta (a value that came in);
 *  - Out / AdjustmentOut -> the value outboundValue decides from the replayed book, so a row that
 *    is taken out of the history changes what later outbound rows took;
 *  - TransferIn / TransferOut -> nothing (value is per item, I-43; both legs net to zero).
 * Cancelled rows are skipped. A Revaluation that settles a cancelled row of its own document (the
 * true-up and zero-stock sweep of an earlier cancel, one row) is not replayed by its value: leaving
 * the cancelled row out recomputes the true-up, and the sweep is replayed where it happened (stock 0
 * -> value 0). Before the baseline it is part of the opening book like any row.
 * The replay also reports where it priced goods without a cost behind them (stock <= 0 windows,
 * settled at the next inbound only from PR-6.6): a true-up compares those of the two replays.
 */

export interface ValueReplayRow {
  id: string;
  movementNumber: string;
  movementType: ReplayMovementType;
  quantity: Decimal.Value;
  valueDelta: Decimal.Value;
  createdAt: Date;
  /**
   * The settlement row of an earlier cancel of its own document: its value is recomputed, only its
   * sweep is replayed. The cancel left stock 0 at value 0 (a residue at zero stock is swept or the
   * cancel refused), so a replayed book at stock 0 drops its value here.
   */
  settlement?: boolean;
}

export interface ValueReplayState {
  stock: Decimal;
  value: Decimal;
  average: Decimal;
}

/** Where a replay priced goods without a cost behind them (stock <= 0 windows, plan §2.3). */
export interface ValueReplayWindows {
  /** Out / AdjustmentOut rows that took goods past zero: id -> the quantity past zero. */
  pastZero: ReadonlyMap<string, Decimal>;
  /** Revaluation rows that landed at stock <= 0: value with no goods to carry it. */
  revaluedWithoutStock: ReadonlySet<string>;
}

const INBOUND_VALUE_TYPES = new Set<ReplayMovementType>(['In', 'AdjustmentIn']);
const OUTBOUND_VALUE_TYPES = new Set<ReplayMovementType>(['Out', 'AdjustmentOut']);

/** Processing order of the value replay: createdAt, then movement number (rows of one transaction), then id. */
export function sortMovementsForValueReplay<T extends Pick<ValueReplayRow, 'id' | 'movementNumber' | 'createdAt'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const d = a.createdAt.getTime() - b.createdAt.getTime();
    if (d !== 0) return d;
    if (a.movementNumber !== b.movementNumber) return a.movementNumber < b.movementNumber ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** One row on the replayed book. Pure; throws INVENTORY_VALUE_NEGATIVE where outboundValue does. */
function applyValueRow(state: ValueReplayState, row: ValueReplayRow): ValueReplayState {
  if (row.settlement) return state.stock.isZero() ? { ...state, value: new Decimal(0) } : state;
  const qty = new Decimal(row.quantity);
  let stock = state.stock;
  let value = state.value;
  if (INBOUND_VALUE_TYPES.has(row.movementType)) {
    stock = stock.plus(qty);
    value = value.plus(row.valueDelta);
  } else if (OUTBOUND_VALUE_TYPES.has(row.movementType)) {
    value = value.minus(outboundValue(stock, value, state.average, qty));
    stock = stock.minus(qty);
  } else if (row.movementType === 'Revaluation') {
    value = value.plus(row.valueDelta);
  } else {
    return state;
  }
  return { stock, value, average: averageAfter(stock, value, state.average) };
}

/** Replays sorted rows from `opening` and notes its stock <= 0 windows. Pure, no mutation of its input. */
function replayWithWindows(rows: readonly ValueReplayRow[], opening: ValueReplayState): ValueReplayState & ValueReplayWindows {
  const pastZero = new Map<string, Decimal>();
  const revaluedWithoutStock = new Set<string>();
  let state = opening;
  for (const row of sortMovementsForValueReplay(rows)) {
    if (OUTBOUND_VALUE_TYPES.has(row.movementType)) {
      const past = new Decimal(row.quantity).minus(Decimal.max(state.stock, 0));
      if (past.gt(0)) pastZero.set(row.id, past);
    } else if (row.movementType === 'Revaluation' && !row.settlement && state.stock.lte(0) && !new Decimal(row.valueDelta).isZero()) {
      revaluedWithoutStock.add(row.id);
    }
    state = applyValueRow(state, row);
  }
  return { ...state, pastZero, revaluedWithoutStock };
}

/** Replays sorted rows from `opening`. Pure, no mutation of its input. */
export function replayValueRows(rows: readonly ValueReplayRow[], opening: ValueReplayState): ValueReplayState {
  const { stock, value, average } = replayWithWindows(rows, opening);
  return { stock, value, average };
}

/**
 * True when a replay without some rows priced more goods past zero, or landed a Revaluation at no
 * stock, where the replay with them did not. It then values goods that never had a cost (the old
 * average for the missing units, the next inbound's full cost on the units left) and the true-up
 * would be a guess: until PR-6.6 settles stock <= 0 windows, such a cancel is TRUE_UP_UNEXPLAINED.
 * Windows the real history had too stay allowed (a sale past zero that is cancelled).
 */
export function addsNegativeWindow(withRows: ValueReplayWindows, without: ValueReplayWindows): boolean {
  for (const [id, qty] of without.pastZero) {
    if (qty.gt(withRows.pastZero.get(id) ?? 0)) return true;
  }
  for (const id of without.revaluedWithoutStock) {
    if (!withRows.revaluedWithoutStock.has(id)) return true;
  }
  return false;
}

/** The opening state of a replay: the signed quantity and the value of the rows up to the baseline. */
function openingOf(rows: readonly ValueReplayRow[]): ValueReplayState {
  let stock = new Decimal(0);
  let value = new Decimal(0);
  for (const row of rows) {
    if (INBOUND_VALUE_TYPES.has(row.movementType)) stock = stock.plus(row.quantity);
    else if (OUTBOUND_VALUE_TYPES.has(row.movementType)) stock = stock.minus(row.quantity);
    value = value.plus(row.valueDelta);
  }
  return { stock, value, average: averageAfter(stock, value, 0) };
}

export interface ItemValueReplay extends ValueReplayState, ValueReplayWindows {
  /** The ValuationBaseline row the replay started from, or null (from the item's first row). */
  baselineId: string | null;
  /** Ids of the rows replayed after the baseline (the rows a value true-up can re-value). */
  replayedIds: ReadonlySet<string>;
}

type Tx = Prisma.TransactionClient;

/** A row replayed at another quantity and value_delta in its place (a document edit, reviseOutbound). */
export interface ReplayRevision {
  movementId: string;
  quantity: Decimal.Value;
  valueDelta: Decimal.Value;
}

/**
 * Loads the item's active rows and replays them from its last ValuationBaseline, leaving out
 * `excludeMovementIds` (the row a cancel takes out of the history) and replaying `revise` at its
 * new quantity in its place (the row an edit re-posts). Reads only; the caller holds the item lock
 * (lockInventoryRows) so the rows cannot change under it.
 */
export async function replayItemValue(
  tx: Tx,
  itemId: string,
  opts: { excludeMovementIds?: readonly string[]; revise?: ReplayRevision } = {},
): Promise<ItemValueReplay> {
  const found = await tx.stockMovement.findMany({
    where: { itemId, isCancelled: false },
    select: {
      id: true, movementNumber: true, movementType: true, quantity: true, valueDelta: true, createdAt: true,
      referenceType: true, referenceId: true,
      adjustsMovement: { select: { isCancelled: true, referenceType: true, referenceId: true } },
    },
  });
  const revised = (r: { id: string }) => opts.revise?.movementId === r.id;
  const rows: (ValueReplayRow & { referenceType: string | null })[] = sortMovementsForValueReplay(found.map((r) => ({
    id: r.id, movementNumber: r.movementNumber, movementType: r.movementType, createdAt: r.createdAt,
    quantity: revised(r) ? new Decimal(opts.revise!.quantity).toString() : r.quantity.toString(),
    valueDelta: revised(r) ? new Decimal(opts.revise!.valueDelta).toString() : r.valueDelta.toString(),
    referenceType: r.referenceType,
    settlement: r.movementType === 'Revaluation' && r.adjustsMovement?.isCancelled === true
      && r.adjustsMovement.referenceType === r.referenceType && r.adjustsMovement.referenceId === r.referenceId,
  })));
  let baselineAt = -1;
  rows.forEach((r, i) => {
    if (r.movementType === 'Revaluation' && r.referenceType === VALUATION_BASELINE_REFERENCE) baselineAt = i;
  });
  const exclude = new Set(opts.excludeMovementIds ?? []);
  const after = rows.slice(baselineAt + 1);
  const state = replayWithWindows(after.filter((r) => !exclude.has(r.id)), openingOf(rows.slice(0, baselineAt + 1)));
  return {
    ...state,
    baselineId: baselineAt >= 0 ? rows[baselineAt].id : null,
    replayedIds: new Set(after.map((r) => r.id)),
  };
}
