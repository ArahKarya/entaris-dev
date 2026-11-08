// Core of scripts/repair/e2-coa-structure-check.ts (E2-R6): finds accounts whose stored type
// disagrees with their number or their parent, and repairs the one case that is safe to do
// automatically: a 7.x account stored as EXPENSE becomes REVENUE (7 is other income).
//
// The repair changes presentation only. Profit per fiscal year is revenue minus expense
// (routes/fiscalYears.ts), so moving a 7.x account from the expense side to the revenue side
// leaves it unchanged. accounts.balance flips sign with the type, so it is recalculated from the
// ledger (every year, the one stored-balance rule). Ledger rows of closed years stay as they are;
// they only warn, and need --include-closed-years to go ahead.
// Everything else is reported for the accountant, never written.

import type { Prisma, RootType } from '@prisma/client';
import type { prisma } from '../../lib/prisma';
import { recalculateAccountBalances } from '../../utils/accountBalance';
import { deriveRootType, isValidAccountNumber, numberPrefix } from './accountRules';
import { lockAccounts } from './accountStructure';

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * revenueAsExpense  7.x stored as EXPENSE: --apply sets REVENUE (action fix)
 * rootTypeVsPrefix  root type differs from what the number's first digit implies (manual)
 * childVsParent     root type differs from the parent's, after the fixes above (manual)
 * groupWithLedger   a group account that carries ledger rows (info)
 * inactiveWithLedger an inactive account that carries ledger rows (info)
 * dottedOrphan      a dotted number with no parent (info)
 */
export type CoaFindingKind =
  | 'revenueAsExpense'
  | 'rootTypeVsPrefix'
  | 'childVsParent'
  | 'groupWithLedger'
  | 'inactiveWithLedger'
  | 'dottedOrphan';

export type CoaFindingAction = 'fix' | 'manual' | 'info';

export interface CoaFindingRow {
  kind: CoaFindingKind;
  action: CoaFindingAction;
  accountId: string;
  accountNumber: string;
  name: string;
  rootType: RootType;
  accountType: RootType;
  /** Root type the number implies (or the parent has, for childVsParent). */
  expectedRootType: RootType | null;
  parentNumber: string | null;
  ledgerRows: number;
  /** Ledger rows in closed fiscal years: the repair is refused for them without the acknowledgement. */
  closedYearLedgerRows: number;
  balance: string;
}

const ACTION: Record<CoaFindingKind, CoaFindingAction> = {
  revenueAsExpense: 'fix',
  rootTypeVsPrefix: 'manual',
  childVsParent: 'manual',
  groupWithLedger: 'info',
  inactiveWithLedger: 'info',
  dottedOrphan: 'info',
};

const isRevenueAsExpense = (a: { accountNumber: string; rootType: RootType }) =>
  numberPrefix(a.accountNumber) === '7' && a.rootType === 'EXPENSE';

/** Read-only: every finding, accounts in number order. */
export async function planCoaStructureCheck(db: Db): Promise<CoaFindingRow[]> {
  const [accounts, ledger] = await Promise.all([
    db.account.findMany({
      select: { id: true, accountNumber: true, name: true, rootType: true, accountType: true, isGroup: true, isActive: true, parentId: true, balance: true },
    }),
    db.accountingLedgerEntry.groupBy({
      by: ['accountId', 'fiscalYearId'],
      where: { isCancelled: false },
      _count: { _all: true },
    }),
  ]);
  const years = await db.fiscalYear.findMany({
    where: { id: { in: [...new Set(ledger.map((l) => l.fiscalYearId))] } },
    select: { id: true, isClosed: true },
  });
  const closedYear = new Set(years.filter((y) => y.isClosed).map((y) => y.id));
  const rows = new Map<string, { all: number; closed: number }>();
  for (const l of ledger) {
    const cur = rows.get(l.accountId) ?? { all: 0, closed: 0 };
    cur.all += l._count._all;
    if (closedYear.has(l.fiscalYearId)) cur.closed += l._count._all;
    rows.set(l.accountId, cur);
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const typeAfterFix = (a: { accountNumber: string; rootType: RootType }): RootType => (isRevenueAsExpense(a) ? 'REVENUE' : a.rootType);
  const sorted = [...accounts].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true }));

  const findings: CoaFindingRow[] = [];
  for (const a of sorted) {
    const parent = a.parentId ? byId.get(a.parentId) ?? null : null;
    const counts = rows.get(a.id) ?? { all: 0, closed: 0 };
    const add = (kind: CoaFindingKind, expectedRootType: RootType | null) =>
      findings.push({
        kind,
        action: ACTION[kind],
        accountId: a.id,
        accountNumber: a.accountNumber,
        name: a.name,
        rootType: a.rootType,
        accountType: a.accountType,
        expectedRootType,
        parentNumber: parent?.accountNumber ?? null,
        ledgerRows: counts.all,
        closedYearLedgerRows: counts.closed,
        balance: a.balance.toString(),
      });

    const expected = isValidAccountNumber(a.accountNumber) ? deriveRootType(a.accountNumber) : null;
    if (isRevenueAsExpense(a)) add('revenueAsExpense', 'REVENUE');
    else if (expected && expected !== a.rootType) add('rootTypeVsPrefix', expected);
    if (parent && typeAfterFix(parent) !== typeAfterFix(a)) add('childVsParent', typeAfterFix(parent));
    if (a.isGroup && counts.all > 0) add('groupWithLedger', null);
    if (!a.isActive && counts.all > 0) add('inactiveWithLedger', null);
    if (!a.parentId && a.accountNumber.includes('.')) add('dottedOrphan', null);
  }
  return findings;
}

export const COA_STRUCTURE_AUDIT_ACTION = 'E2_COA_STRUCTURE_REPAIR';

/** Why the apply stopped, for the CLI to print. */
export class CoaRepairRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoaRepairRefusal';
  }
}

export interface CoaRepairOptions {
  approvedBy: string;
  /** Acknowledges that accounts with ledger rows in closed years are re-typed too. */
  includeClosedYears?: boolean;
}

export interface CoaRepairResult {
  approvedBy: string;
  /** Account numbers re-typed to REVENUE. */
  applied: string[];
  /** Planned accounts skipped because they were no longer 7.x EXPENSE. */
  skipped: string[];
}

/**
 * Sets the planned `revenueAsExpense` accounts to REVENUE and recalculates their balance from the
 * ledger, in the caller's transaction. Refuses (writes nothing) without an approver
 * name, or when an account has ledger rows in a closed year and `includeClosedYears` is off.
 * One audit row per account, naming the accountant and whether closed years were acknowledged.
 */
export async function applyCoaStructureRepair(
  tx: Prisma.TransactionClient,
  plan: readonly CoaFindingRow[],
  options: CoaRepairOptions,
): Promise<CoaRepairResult> {
  const approvedBy = options.approvedBy.trim();
  if (!approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  const fixes = plan.filter((r) => r.kind === 'revenueAsExpense');

  const blocked = fixes.filter((r) => r.closedYearLedgerRows > 0);
  if (blocked.length > 0 && !options.includeClosedYears) {
    throw new CoaRepairRefusal(
      `${blocked.length} account(s) have ledger rows in closed fiscal years (${blocked.map((r) => r.accountNumber).join(', ')}). ` +
        'Their profit per year does not change, only where the amount is shown. Nothing was written; pass --include-closed-years to repair them as well.',
    );
  }
  if (fixes.length === 0) return { approvedBy, applied: [], skipped: [] };

  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');

  await lockAccounts(tx, fixes.map((r) => r.accountId));
  const applied: string[] = [];
  const skipped: string[] = [];
  const changed: string[] = [];
  for (const row of fixes) {
    const { count } = await tx.account.updateMany({
      where: { id: row.accountId, rootType: 'EXPENSE', accountNumber: row.accountNumber },
      data: { rootType: 'REVENUE', accountType: 'REVENUE' },
    });
    if (count !== 1) {
      skipped.push(row.accountNumber);
      continue;
    }
    changed.push(row.accountId);
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: COA_STRUCTURE_AUDIT_ACTION,
        entityType: 'Account',
        entityId: row.accountId,
        oldValues: { rootType: row.rootType, accountType: row.accountType, balance: row.balance },
        newValues: {
          rootType: 'REVENUE', accountType: 'REVENUE', approvedBy,
          closedYearsAcknowledged: Boolean(options.includeClosedYears) && row.closedYearLedgerRows > 0,
        },
        via: 'repair',
        viaMeta: { script: COA_STRUCTURE_AUDIT_ACTION, approvedBy },
      },
    });
    applied.push(row.accountNumber);
  }
  if (changed.length > 0) await recalculateAccountBalances(tx, changed);
  return { approvedBy, applied, skipped };
}
