/**
 * Reorder radar: decide whether a repeat Customer is late for their next order.
 * Pure; the loader in reorderRadar.ts feeds it business dates from sales invoices.
 */
import { addDays, daysBetween } from './businessDate';

export type ReorderState = 'insufficient' | 'ok' | 'late' | 'snoozed';

export interface ReorderInput {
  /** Business dates (YYYY-MM-DD) of non-cancelled invoices; any order, duplicates allowed. */
  orderDates: string[];
  /** Cycle set by a salesperson for this Customer; overrides the computed average. */
  manualCycleDays: number | null;
  minInvoices: number;
  toleranceFactor: number;
  today: string;
  snoozedUntil: string | null;
  /** Business date of the latest sales activity with this Customer, if any. */
  lastContactOn: string | null;
}

export interface ReorderResult {
  state: ReorderState;
  orderCount: number;
  lastOrderOn: string | null;
  avgIntervalDays: number | null;
  cycleDays: number | null;
  cycleSource: 'manual' | 'average' | null;
  daysSinceLastOrder: number | null;
  /** Date after which the Customer counts as late (last order + cycle x tolerance). */
  lateAfter: string | null;
  overdueDays: number;
  /** True when a sales activity was logged after the Customer became late. */
  contactedSinceLate: boolean;
}

export function evaluateReorder(input: ReorderInput): ReorderResult {
  const dates = [...new Set(input.orderDates)].sort();
  const orderCount = dates.length;
  const lastOrderOn = dates.at(-1) ?? null;
  const avgIntervalDays =
    orderCount >= 2 ? round1(daysBetween(dates[0], dates[orderCount - 1]) / (orderCount - 1)) : null;

  let cycleDays: number | null = null;
  let cycleSource: ReorderResult['cycleSource'] = null;
  if (input.manualCycleDays && input.manualCycleDays > 0) {
    cycleDays = input.manualCycleDays;
    cycleSource = 'manual';
  } else if (avgIntervalDays && avgIntervalDays > 0 && orderCount >= input.minInvoices) {
    cycleDays = avgIntervalDays;
    cycleSource = 'average';
  }

  const base: ReorderResult = {
    state: 'insufficient',
    orderCount,
    lastOrderOn,
    avgIntervalDays,
    cycleDays,
    cycleSource,
    daysSinceLastOrder: lastOrderOn ? daysBetween(lastOrderOn, input.today) : null,
    lateAfter: null,
    overdueDays: 0,
    contactedSinceLate: false,
  };
  if (!lastOrderOn || cycleDays === null) return base;

  const lateAfter = addDays(lastOrderOn, Math.ceil(cycleDays * input.toleranceFactor));
  const overdueDays = Math.max(0, daysBetween(lateAfter, input.today));
  const isLate = overdueDays > 0;
  const contactedSinceLate = isLate && input.lastContactOn !== null && input.lastContactOn > lateAfter;
  const snoozed = input.snoozedUntil !== null && input.snoozedUntil >= input.today;

  return {
    ...base,
    lateAfter,
    overdueDays,
    contactedSinceLate,
    state: snoozed ? 'snoozed' : isLate ? 'late' : 'ok',
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
