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
 * Cancelled rows are skipped, and so is a Revaluation that settles a cancelled row of its own
 * document (the true-up or sweep of an earlier cancel): the replay recomputes that effect itself.
 */

export interface ValueReplayRow {
  id: string;
  movementNumber: string;
  movementType: ReplayMovementType;
  quantity: Decimal.Value;
  valueDelta: Decimal.Value;
  createdAt: Date;
}

export interface ValueReplayState {
  stock: Decimal;
  value: Decimal;
  average: Decimal;
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

/** Replays sorted rows from `opening`. Pure, no mutation of its input. */
export function replayValueRows(rows: readonly ValueReplayRow[], opening: ValueReplayState): ValueReplayState {
  return sortMovementsForValueReplay(rows).reduce(applyValueRow, opening);
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

export interface ItemValueReplay extends ValueReplayState {
  /** The ValuationBaseline row the replay started from, or null (from the item's first row). */
  baselineId: string | null;
  /** Ids of the rows replayed after the baseline (the rows a value true-up can re-value). */
  replayedIds: ReadonlySet<string>;
}

type Tx = Prisma.TransactionClient;

/**
 * Loads the item's active rows and replays them from its last ValuationBaseline, leaving out
 * `excludeMovementIds` (the row a cancel takes out of the history). Reads only; the caller holds
 * the item lock (lockInventoryRows) so the rows cannot change under it.
 */
export async function replayItemValue(
  tx: Tx,
  itemId: string,
  opts: { excludeMovementIds?: readonly string[] } = {},
): Promise<ItemValueReplay> {
  const found = await tx.stockMovement.findMany({
    where: { itemId, isCancelled: false },
    select: {
      id: true, movementNumber: true, movementType: true, quantity: true, valueDelta: true, createdAt: true,
      referenceType: true, referenceId: true,
      adjustsMovement: { select: { isCancelled: true, referenceType: true, referenceId: true } },
    },
  });
  const live = found.filter((r) => !(r.movementType === 'Revaluation' && r.adjustsMovement?.isCancelled
    && r.adjustsMovement.referenceType === r.referenceType && r.adjustsMovement.referenceId === r.referenceId));
  const rows: (ValueReplayRow & { referenceType: string | null })[] = sortMovementsForValueReplay(live.map((r) => ({
    id: r.id, movementNumber: r.movementNumber, movementType: r.movementType, createdAt: r.createdAt,
    quantity: r.quantity.toString(), valueDelta: r.valueDelta.toString(), referenceType: r.referenceType,
  })));
  let baselineAt = -1;
  rows.forEach((r, i) => {
    if (r.movementType === 'Revaluation' && r.referenceType === VALUATION_BASELINE_REFERENCE) baselineAt = i;
  });
  const exclude = new Set(opts.excludeMovementIds ?? []);
  const after = rows.slice(baselineAt + 1);
  const state = replayValueRows(after.filter((r) => !exclude.has(r.id)), openingOf(rows.slice(0, baselineAt + 1)));
  return {
    ...state,
    baselineId: baselineAt >= 0 ? rows[baselineAt].id : null,
    replayedIds: new Set(after.map((r) => r.id)),
  };
}
