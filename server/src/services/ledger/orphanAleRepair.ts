// Orphan ledger rows (E2-R14): active accounting_ledger_entries whose JournalEntry, StockMovement or
// StockOpname no longer exists. Core of scripts/repair/e2-orphan-ale-repair.ts, which replaces the
// removed health-check fix (it cancelled rows of every year and left accounts.balance stale).
// The plan groups the rows per reference; --apply cancels a whole group in one statement (each
// group stays balanced for the ledger trigger) and updates the balance of the accounts it touched.
// Only JournalEntry groups in an open fiscal year outside the period lock are repaired; closed
// years, locked months and stock references are reported for a correction by journal.
//
// Balances: a balance-sheet account is recalculated from the ledger. A revenue/expense account
// is only moved by the cancelled rows while any fiscal year is closed: a close before PR-5.5 took
// the closed years' contributions off its stored balance, and putting them back is the one-time,
// accountant-approved e2-stored-balance-recalc --apply, not this repair's job.
import { Prisma, type RootType } from '@prisma/client';
import { applyAccountImpacts } from '../../utils/accountBalance';
import { BusinessError } from '../../utils/errors';
import { assertPeriodsOpen, FISCAL_YEAR_MISSING, PERIOD_CLOSED, PERIOD_LOCKED } from '../../utils/periodGuard';
import { lockAccounts } from '../coa/accountStructure';
import { recalculateAccountBalances } from './storedBalances';

type Tx = Prisma.TransactionClient;

export const ORPHAN_ALE_AUDIT_ACTION = 'E2_ORPHAN_ALE_REPAIR';

/** repair: cancelled by --apply. The others are reported only. */
export type OrphanGroupAction = 'repair' | 'closed-year' | 'period-locked' | 'no-fiscal-year' | 'stock-reference';

export interface OrphanAleGroup {
  referenceType: string;
  referenceId: string;
  rows: number;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  firstDate: Date;
  lastDate: Date;
  /** Every distinct row date, oldest first. */
  dates: Date[];
  fiscalYearIds: string[];
  fiscalYearNames: string[];
  yearClosed: boolean;
  accountIds: string[];
  accountNumbers: string[];
  action: OrphanGroupAction;
}

export interface OrphanRepairResult {
  approvedBy: string;
  /** `<referenceType>:<referenceId>` of the cancelled groups. */
  applied: string[];
  skipped: { key: string; reason: string }[];
  /** Accounts whose stored balance the recalculation changed. */
  rebalanced: string[];
  /** Revenue/expense accounts moved by the cancelled rows only (a fiscal year is closed). */
  adjusted: string[];
}

export const orphanKey = (g: Pick<OrphanAleGroup, 'referenceType' | 'referenceId'>): string => `${g.referenceType}:${g.referenceId}`;

/** The one definition of an orphan row, on alias `ale`. */
const ORPHAN = Prisma.sql`(
  (ale.reference_type = 'JournalEntry' AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = ale.reference_id))
  OR (ale.reference_type = 'StockMovement' AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.id = ale.reference_id))
  OR (ale.reference_type = 'StockOpname' AND NOT EXISTS (SELECT 1 FROM stock_opnames so WHERE so.id = ale.reference_id))
)`;

interface GroupRow {
  reference_type: string;
  reference_id: string;
  rows: number;
  debit: string;
  credit: string;
  first_date: Date;
  last_date: Date;
  dates: Date[];
  fiscal_year_ids: string[];
  fiscal_year_names: string[];
  year_closed: boolean;
  account_ids: string[];
  account_numbers: string[];
}

const PERIOD_ACTION: Record<string, OrphanGroupAction> = {
  [PERIOD_CLOSED]: 'closed-year',
  [PERIOD_LOCKED]: 'period-locked',
  [FISCAL_YEAR_MISSING]: 'no-fiscal-year',
};

/**
 * The period guard on a group, the way the cancel paths call it: the fiscal year covering each row
 * date (closed or missing) and the lock date on each day, plus every fiscal year the rows are
 * tagged with, since an older date edit can leave that id stale. Returns the report-only action
 * it falls in, or null when the group may change.
 */
async function periodRefusal(
  tx: Tx,
  g: Pick<OrphanAleGroup, 'firstDate' | 'dates' | 'fiscalYearIds'>,
): Promise<OrphanGroupAction | null> {
  const refs = [
    ...g.dates.map((date) => ({ date })),
    ...g.fiscalYearIds.map((fiscalYearId) => ({ date: g.firstDate, fiscalYearId })),
  ];
  try {
    await assertPeriodsOpen(tx, refs, 'jurnal');
    return null;
  } catch (e) {
    const action = e instanceof BusinessError && e.code ? PERIOD_ACTION[e.code] : undefined;
    if (action) return action;
    throw e;
  }
}

/**
 * Every orphan reference with its active rows summed, oldest first. Takes a transaction because
 * the period guard share-locks the fiscal-year and lock rows; it writes nothing.
 */
export async function planOrphanAleRepair(tx: Tx): Promise<OrphanAleGroup[]> {
  const rows = await tx.$queryRaw<GroupRow[]>`
    SELECT ale.reference_type, ale.reference_id, COUNT(*)::int AS rows,
           SUM(ale.debit)::text AS debit, SUM(ale.credit)::text AS credit,
           MIN(ale.date) AS first_date, MAX(ale.date) AS last_date,
           array_agg(DISTINCT ale.date ORDER BY ale.date) AS dates,
           array_agg(DISTINCT ale.fiscal_year_id) AS fiscal_year_ids,
           array_agg(DISTINCT fy.name) AS fiscal_year_names,
           bool_or(fy.is_closed) AS year_closed,
           array_agg(DISTINCT ale.account_id) AS account_ids,
           array_agg(DISTINCT a."accountNumber") AS account_numbers
      FROM accounting_ledger_entries ale
      JOIN accounts a ON a.id = ale.account_id
      JOIN fiscal_years fy ON fy.id = ale.fiscal_year_id
     WHERE ale.is_cancelled = false AND ${ORPHAN}
     GROUP BY ale.reference_type, ale.reference_id
     ORDER BY MIN(ale.date), ale.reference_type, ale.reference_id
  `;
  const groups: OrphanAleGroup[] = [];
  for (const r of rows) {
    const base = {
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      rows: r.rows,
      debit: new Prisma.Decimal(r.debit),
      credit: new Prisma.Decimal(r.credit),
      firstDate: r.first_date,
      lastDate: r.last_date,
      dates: r.dates,
      fiscalYearIds: r.fiscal_year_ids,
      fiscalYearNames: r.fiscal_year_names,
      yearClosed: r.year_closed,
      accountIds: r.account_ids,
      accountNumbers: r.account_numbers,
    };
    let action: OrphanGroupAction;
    if (r.reference_type !== 'JournalEntry') action = 'stock-reference';
    else if (r.year_closed) action = 'closed-year';
    else action = (await periodRefusal(tx, base)) ?? 'repair';
    groups.push({ ...base, action });
  }
  return groups;
}

/**
 * Cancels the planned `repair` groups in the caller's transaction, then updates the touched
 * accounts (see the file header: recalculated, or moved by the cancelled rows). A group is skipped (nothing written for it) when its active orphan rows differ from
 * the plan, or the period guard now refuses it. One audit row per cancelled group names the
 * accountant. Refuses without an approver name.
 */
export async function applyOrphanAleRepair(
  tx: Tx,
  plan: readonly OrphanAleGroup[],
  options: { approvedBy: string },
): Promise<OrphanRepairResult> {
  const approvedBy = options.approvedBy.trim();
  if (!approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  const repairs = plan.filter((g) => g.action === 'repair');
  if (repairs.length === 0) return { approvedBy, applied: [], skipped: [], rebalanced: [], adjusted: [] };

  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');

  await lockAccounts(tx, repairs.flatMap((g) => g.accountIds));
  const [{ closed_year: closedYear }] = await tx.$queryRaw<{ closed_year: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM fiscal_years WHERE is_closed) AS closed_year`;
  const balanceUpdate = closedYear ? 'revenue/expense by the cancelled rows, others recalculated' : 'recalculated';
  const applied: string[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const cancelled: { account_id: string; debit: string; credit: string }[] = [];
  for (const g of repairs) {
    const key = orphanKey(g);
    const refusal = await periodRefusal(tx, g);
    if (refusal) {
      skipped.push({ key, reason: refusal });
      continue;
    }
    const current = await tx.$queryRaw<{ id: string; account_id: string; debit: string; credit: string }[]>`
      SELECT ale.id, ale.account_id, ale.debit::text, ale.credit::text
        FROM accounting_ledger_entries ale
       WHERE ale.reference_type = ${g.referenceType} AND ale.reference_id = ${g.referenceId}
         AND ale.is_cancelled = false AND ${ORPHAN}
       ORDER BY ale.id
         FOR UPDATE
    `;
    const debit = current.reduce((s, r) => s.plus(r.debit), new Prisma.Decimal(0));
    const credit = current.reduce((s, r) => s.plus(r.credit), new Prisma.Decimal(0));
    if (current.length !== g.rows || !debit.equals(g.debit) || !credit.equals(g.credit)) {
      skipped.push({ key, reason: 'changed-since-plan' });
      continue;
    }
    const ids = current.map((r) => r.id);
    await tx.$executeRaw`UPDATE accounting_ledger_entries SET is_cancelled = true WHERE id = ANY(${ids}::text[])`;
    cancelled.push(...current);
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: ORPHAN_ALE_AUDIT_ACTION,
        entityType: g.referenceType,
        entityId: g.referenceId,
        oldValues: {
          isCancelled: false, ledgerEntryIds: ids, rows: g.rows, debit: g.debit.toFixed(2), credit: g.credit.toFixed(2),
          fiscalYears: g.fiscalYearNames, accounts: g.accountNumbers,
        },
        newValues: { isCancelled: true, approvedBy, balanceUpdate },
        via: 'repair',
        viaMeta: { script: ORPHAN_ALE_AUDIT_ACTION, approvedBy },
      },
    });
    applied.push(key);
  }
  const { rebalanced, adjusted } = await updateTouchedBalances(tx, cancelled, closedYear);
  return { approvedBy, applied, skipped, rebalanced, adjusted };
}

/** The balance update of the file header for the cancelled rows; returns the account numbers. */
async function updateTouchedBalances(
  tx: Tx,
  cancelled: readonly { account_id: string; debit: string; credit: string }[],
  closedYear: boolean,
): Promise<{ rebalanced: string[]; adjusted: string[] }> {
  const ids = [...new Set(cancelled.map((r) => r.account_id))];
  if (ids.length === 0) return { rebalanced: [], adjusted: [] };
  const accounts = await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, accountNumber: true, rootType: true } });
  const byDelta = new Set(
    closedYear ? accounts.filter((a) => a.rootType === 'REVENUE' || a.rootType === 'EXPENSE').map((a) => a.id) : [],
  );
  const rootTypes = new Map<string, RootType>(accounts.map((a) => [a.id, a.rootType]));
  // Cancelling a row takes its impact off: the same lines with debit and credit swapped.
  await applyAccountImpacts(
    tx,
    cancelled.filter((r) => byDelta.has(r.account_id)).map((r) => ({ accountId: r.account_id, debit: r.credit, credit: r.debit })),
    rootTypes,
  );
  const recalc = ids.filter((id) => !byDelta.has(id));
  const { changed } = recalc.length > 0 ? await recalculateAccountBalances(tx, recalc) : { changed: [] };
  const adjusted = accounts.filter((a) => byDelta.has(a.id)).map((a) => a.accountNumber).sort();
  return { rebalanced: changed.map((c) => c.accountNumber), adjusted };
}
