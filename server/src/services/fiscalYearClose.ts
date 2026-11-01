// Year-close checklist (E1-R8). A registry of checks that each look at one fiscal year and report
// the items that stand in the way of closing it: blocking checks refuse the close, warnings are only
// shown. Other modules plug their own checks in with registerCloseCheck (inventory vs GL, AR vs
// subledger, fixed-asset registers). GET /fiscal-years/:id/close-checklist previews the result and
// POST /:id/close runs it again inside its transaction, after FOR UPDATE on the year row.
//
// Baseline: ledger mismatches that already existed at release are captured once in
// close_check_baselines (scripts/repair/e1-close-baseline.ts). A baseline-aware check skips an item
// whose key is there with the same amount (or, when the check defines baselineCovers, an amount it
// accepts); a new item, or a known one whose amount is not covered, still blocks.
import { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { fiscalYearRange } from '../utils/periodGuard';
import { BUILT_IN_CLOSE_CHECKS } from './fiscalYearCloseChecks';
import {
  CLOSE_CHECK_ITEM_LIMIT,
  type CloseCheck,
  type CloseCheckItem,
  type CloseCheckSeverity,
  type CloseCheckYear,
} from './fiscalYearCloseTypes';

export * from './fiscalYearCloseTypes';

type Tx = Prisma.TransactionClient;

/** Error code: the year close was refused by blocking checklist items. */
export const CLOSE_CHECKLIST_FAILED = 'CLOSE_CHECKLIST_FAILED';

export interface CloseCheckResult {
  id: string;
  severity: CloseCheckSeverity;
  /** 'ok' when nothing is left once baselined items are set aside, else 'fail'. */
  status: 'ok' | 'fail';
  /** Items that count (not baselined). */
  count: number;
  /** Items skipped because the baseline covers them (same amount, or the check's baselineCovers). */
  baselinedCount: number;
  /** Counted items first, then baselined ones, at most CLOSE_CHECK_ITEM_LIMIT. */
  items: CloseCheckItem[];
}

export interface CloseChecklist {
  fiscalYear: { id: string; name: string; startDay: string; endDay: string; isClosed: boolean };
  /** True when the year is open and no blocking check fails. */
  canClose: boolean;
  /** Number of failing blocking checks. */
  blocking: number;
  /** Number of failing warning checks. */
  warnings: number;
  checks: CloseCheckResult[];
}

const registry: CloseCheck[] = [];

/** Adds a check to the year-close checklist. Ids are unique; checks run in registration order. */
export function registerCloseCheck(check: CloseCheck): void {
  if (registry.some((c) => c.id === check.id)) throw new Error(`Close check ${check.id} is already registered`);
  registry.push(check);
}

/** The registered checks, in run order. */
export function closeChecks(): readonly CloseCheck[] {
  return registry;
}

for (const check of BUILT_IN_CLOSE_CHECKS) registerCloseCheck(check);

/** A fiscal year row with the bounds the checks use. */
export function closeCheckYear(fy: { id: string; name: string; startDate: Date; endDate: Date }): CloseCheckYear {
  const range = fiscalYearRange(fy);
  return { id: fy.id, name: fy.name, startDate: fy.startDate, endDate: fy.endDate, ...range };
}

/** Baseline amount per item key of one check, for the given keys. */
async function baselineAmounts(tx: Tx, checkId: string, keys: string[]): Promise<Map<string, Prisma.Decimal>> {
  if (keys.length === 0) return new Map();
  const rows = await tx.closeCheckBaseline.findMany({
    where: { checkId, itemKey: { in: keys } },
    select: { itemKey: true, amount: true },
  });
  return new Map(rows.map((r) => [r.itemKey, new Prisma.Decimal(r.amount)]));
}

/** Marks items the baseline covers: the same amount, or what the check's baselineCovers accepts. */
async function applyBaseline(tx: Tx, check: CloseCheck, items: CloseCheckItem[]): Promise<CloseCheckItem[]> {
  if (!check.baselineAware) return items;
  const known = await baselineAmounts(tx, check.id, items.map((i) => i.key));
  const covers = check.baselineCovers ?? ((current: Prisma.Decimal, baseline: Prisma.Decimal) => current.equals(baseline));
  return items.map((item) => {
    const amount = known.get(item.key);
    const covered = amount !== undefined && item.amount !== undefined && covers(new Prisma.Decimal(item.amount), amount);
    return covered ? { ...item, baselined: true } : item;
  });
}

async function runCheck(tx: Tx, check: CloseCheck, fy: CloseCheckYear): Promise<CloseCheckResult> {
  const outcome = await check.run(tx, fy);
  const items = await applyBaseline(tx, check, outcome.items);
  const baselined = items.filter((i) => i.baselined);
  const counted = items.filter((i) => !i.baselined);
  const count = outcome.count - baselined.length;
  return {
    id: check.id,
    severity: check.severity,
    status: count > 0 ? 'fail' : 'ok',
    count,
    baselinedCount: baselined.length,
    items: [...counted, ...baselined].slice(0, CLOSE_CHECK_ITEM_LIMIT),
  };
}

/**
 * Runs every registered check for `fy` in order, in the caller's transaction. Read-only; the close
 * calls it after FOR UPDATE on the year row, so nothing it counts can change before the close commits.
 */
export async function runCloseChecklist(
  tx: Tx,
  fy: { id: string; name: string; startDate: Date; endDate: Date; isClosed: boolean },
): Promise<CloseChecklist> {
  const year = closeCheckYear(fy);
  const checks: CloseCheckResult[] = [];
  for (const check of registry) checks.push(await runCheck(tx, check, year));
  const failing = (severity: CloseCheckSeverity) => checks.filter((c) => c.severity === severity && c.status === 'fail').length;
  const blocking = failing('block');
  return {
    fiscalYear: { id: fy.id, name: fy.name, startDay: year.startDay, endDay: year.endDay, isClosed: fy.isClosed },
    canClose: !fy.isClosed && blocking === 0,
    blocking,
    warnings: failing('warn'),
    checks,
  };
}

/** The close was refused; `checklist` lists what blocks it. */
export class CloseChecklistFailedError extends BusinessError {
  constructor(public readonly checklist: CloseChecklist) {
    super(
      `Tahun buku ${checklist.fiscalYear.name} belum bisa ditutup: ${checklist.blocking} pemeriksaan daftar cek masih memblokir. Buka daftar cek tutup buku untuk rinciannya.`,
      CLOSE_CHECKLIST_FAILED,
    );
    this.name = 'CloseChecklistFailedError';
  }
}

/** Runs the checklist and throws CloseChecklistFailedError when a blocking check fails. */
export async function assertCloseChecklistPasses(
  tx: Tx,
  fy: { id: string; name: string; startDate: Date; endDate: Date; isClosed: boolean },
): Promise<CloseChecklist> {
  const checklist = await runCloseChecklist(tx, fy);
  if (checklist.blocking > 0) throw new CloseChecklistFailedError(checklist);
  return checklist;
}

export interface BaselineCapture {
  checkId: string;
  item: CloseCheckItem;
  /** False when the baseline already had this key (its stored amount is kept). */
  added: boolean;
}

/**
 * The baseline-aware checks a capture covers: all of them, or only `checkIds`. An unknown id, or a
 * check that is not baseline-aware, is refused.
 */
export function baselineCaptureChecks(checkIds?: readonly string[]): readonly CloseCheck[] {
  const aware = registry.filter((c) => c.baselineAware);
  if (!checkIds) return aware;
  return [...new Set(checkIds)].map((id) => {
    const check = aware.find((c) => c.id === id);
    if (!check) throw new Error(`${id} is not a baseline-aware close check (known: ${aware.map((c) => c.id).join(', ')})`);
    return check;
  });
}

/**
 * Refuses a baseline write that could hide a mismatch made after the release, for
 * scripts/repair/e1-close-baseline.ts. The full capture runs once, on an empty baseline. A check
 * registered later is captured on its own: `checkIds` names it, it must have no rows yet, and
 * `allowExisting` acknowledges the rows the other checks already have (they are not touched).
 */
export async function assertBaselineCaptureAllowed(
  tx: Tx,
  opts: { checkIds?: readonly string[]; allowExisting: boolean },
): Promise<void> {
  if (opts.allowExisting && !opts.checkIds) throw new Error('--allow-existing only goes with --check <id>');
  const ids = new Set(baselineCaptureChecks(opts.checkIds).map((c) => c.id));
  const rows = await tx.closeCheckBaseline.groupBy({ by: ['checkId'], _count: { _all: true } });
  const own = rows.filter((r) => ids.has(r.checkId));
  if (own.length > 0) {
    const listed = own.map((r) => `${r.checkId} (${r._count._all})`).join(', ');
    throw new Error(`The baseline already has rows for ${listed}; a check is captured once.`);
  }
  const others = rows.reduce((n, r) => n + r._count._all, 0);
  if (others > 0 && !opts.allowExisting) {
    throw new Error(
      `The baseline already has ${others} row(s); it is captured once. To capture a check added later, pass --check <id> --allow-existing.`,
    );
  }
}

/**
 * The current items of the baseline-aware checks for `fy` (all, or only `checkIds`), written to
 * close_check_baselines when `apply` (existing keys keep their first captured amount). Call
 * assertBaselineCaptureAllowed first; a dry run writes nothing.
 */
export async function captureCloseBaseline(
  tx: Tx,
  fy: { id: string; name: string; startDate: Date; endDate: Date },
  apply: boolean,
  checkIds?: readonly string[],
): Promise<BaselineCapture[]> {
  const year = closeCheckYear(fy);
  const captured: BaselineCapture[] = [];
  for (const check of baselineCaptureChecks(checkIds)) {
    const { items } = await check.run(tx, year);
    const known = await baselineAmounts(tx, check.id, items.map((i) => i.key));
    for (const item of items) captured.push({ checkId: check.id, item, added: !known.has(item.key) });
  }
  const rows = captured
    .filter((c) => c.added)
    .map((c) => ({ checkId: c.checkId, itemKey: c.item.key, fiscalYearId: fy.id, amount: new Prisma.Decimal(c.item.amount ?? 0) }));
  if (apply && rows.length > 0) await tx.closeCheckBaseline.createMany({ data: rows, skipDuplicates: true });
  return captured;
}
