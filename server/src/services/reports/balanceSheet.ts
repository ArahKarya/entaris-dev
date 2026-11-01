// Balance sheet as of a business day (GET /api/reports/balance-sheet), with the equity section split
// the way an accountant reads it:
// - Current-year profit (Laba Tahun Berjalan) = revenue minus expense from the start of the fiscal
//   year that holds the day, without close-journal rows. It replaces the CURRENT_PROFIT account in
//   its place inside its group. A day without a fiscal year counts from 1 January of its year.
// - Retained earnings (Laba Ditahan) replaces the RETAINED_EARNINGS account and is a composite: the
//   account's own balance, any posting to CURRENT_PROFIT other than a close journal, and the profit
//   of earlier years that no close journal has moved yet. Each part is a child row. On the last day
//   of a closed year the report shows the books before that year's close (owner decision 1), so the
//   close journals dated inside the report's own fiscal year are left out of the parts.
// Group balances are summed bottom-up from the rows shown, so a header always equals its rows; a
// posting made directly to a group account shows as its own row. Total equity is still all equity
// ledger rows plus all-time profit, the same total as before the split.
import { Prisma, type RootType } from '@prisma/client';
import { systemAccounts } from '../systemAccounts';
import { closeJournalIds } from '../ledger/closeJournals';
import { compareAccountNumber } from '../../utils/accountSort';
import { startOfBusinessDay } from '../../utils/businessDate';
import { fiscalYearOn, fiscalYearRange } from '../../utils/periodGuard';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

/** What a row is: a chart-of-accounts account, one of the two equity composites, or a part of one. */
export type BsNodeKind = 'account' | 'retainedEarnings' | 'currentProfit' | 'detail';

/** Which part a 'detail' row is. */
export type BsDetail = 'retainedAccount' | 'otherCurrentProfit' | 'unclosedProfit' | 'groupDirect';

export interface BsNode {
  id: string;
  /** Account name, or a fixed Indonesian label on synthetic rows (the server PDF and AIRA read it). */
  name: string;
  accountNumber?: string;
  isGroup: boolean;
  balance: number;
  children: BsNode[];
  kind: BsNodeKind;
  detail?: BsDetail;
  /** Account whose ledger a drill-down opens; null when the row has no single account. */
  accountId: string | null;
  /** False when the row cannot be drilled into. */
  selectable: boolean;
  /** The account sits under a group of another root type (data to fix); it is still counted here. */
  rootTypeMismatch?: boolean;
}

export type EquityRole = 'CURRENT_PROFIT' | 'RETAINED_EARNINGS';

export interface BalanceSheetMeta {
  asOf: string;
  /** First business day counted in current-year profit. */
  currentProfitFrom: string;
  /** Fiscal year holding `asOf`; null when none exists (current-year profit then starts on 1 January). */
  fiscalYear: { id: string; name: string; isClosed: boolean } | null;
  /** Equity system-account roles without a mapping; their rows are shown at the top of equity. */
  equityMappingMissing: EquityRole[];
}

export interface BalanceSheetResult {
  assets: BsNode[];
  liabilities: BsNode[];
  equity: BsNode[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  meta: BalanceSheetMeta;
}

export interface BsAccount {
  id: string;
  name: string;
  accountNumber: string;
  isGroup: boolean;
  parentId: string | null;
  rootType: RootType;
}

export interface EquityInput {
  /** Asset, liability and equity accounts, sorted by account number. */
  accounts: readonly BsAccount[];
  /** Own ledger balance per account, signed by its root type (debit - credit for assets). */
  own: ReadonlyMap<string, Decimal>;
  /** Revenue minus expense over all dates up to the report day. */
  plAll: Decimal;
  /** Revenue minus expense from the fiscal-year start, without close journals. */
  currentProfit: Decimal;
  /** Ledger rows of close journals on the CURRENT_PROFIT account (credit - debit). */
  closingOnCurrentProfit: Decimal;
  /** The part of closingOnCurrentProfit dated inside the report's own fiscal year (its own close). */
  closingInYear: Decimal;
  currentProfitAccountId: string | null;
  retainedEarningsAccountId: string | null;
}

/** A row while it is assembled: balance kept as a Decimal until the response is built. */
interface Draft extends Omit<BsNode, 'balance' | 'children'> {
  balance: Decimal;
  children: Draft[];
}

type Replace = (account: BsAccount, children: Draft[]) => Draft;

const sum = (nodes: readonly Draft[]): Decimal => nodes.reduce((s, n) => s.add(n.balance), ZERO);

function toPublic(node: Draft): BsNode {
  return { ...node, balance: node.balance.toNumber(), children: node.children.map(toPublic) };
}

function childrenIndex(accounts: readonly BsAccount[]): Map<string | null, BsAccount[]> {
  const index = new Map<string | null, BsAccount[]>();
  for (const a of accounts) {
    const list = index.get(a.parentId) ?? [];
    list.push(a);
    index.set(a.parentId, list);
  }
  return index;
}

/** Ids of the accounts shown under `rootType`: its top-level accounts and everything beneath them. */
function sectionIds(index: Map<string | null, BsAccount[]>, rootType: RootType): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly BsAccount[]) => {
    for (const a of list) {
      ids.add(a.id);
      walk(index.get(a.id) ?? []);
    }
  };
  walk((index.get(null) ?? []).filter((a) => a.rootType === rootType));
  return ids;
}

/**
 * Account tree of one root type. Top level holds only accounts of that root type; beneath them every
 * child is kept, a child of another root type flagged rootTypeMismatch. A group's balance is the sum
 * of the rows shown under it, its own postings as a 'groupDirect' row. Zero accounts are dropped,
 * groups and synthetic rows are kept.
 */
function buildSection(
  index: Map<string | null, BsAccount[]>,
  own: ReadonlyMap<string, Decimal>,
  rootType: RootType,
  replace: ReadonlyMap<string, Replace> = new Map(),
): Draft[] {
  const build = (list: readonly BsAccount[]): Draft[] =>
    list
      .map((a): Draft => {
        const children = build(index.get(a.id) ?? []);
        const swap = replace.get(a.id);
        const node = swap ? swap(a, children) : accountNode(a, own.get(a.id) ?? ZERO, children);
        return a.rootType === rootType ? node : { ...node, rootTypeMismatch: true };
      })
      .filter((n) => n.kind !== 'account' || n.isGroup || !n.balance.isZero());
  return build((index.get(null) ?? []).filter((a) => a.rootType === rootType));
}

function accountNode(a: BsAccount, ownBalance: Decimal, children: Draft[]): Draft {
  const rows = [...children];
  if (rows.length > 0 && !ownBalance.isZero()) {
    rows.push({
      id: `${a.id}:direct`,
      name: 'Saldo Langsung Grup',
      accountNumber: a.accountNumber,
      isGroup: false,
      balance: ownBalance,
      children: [],
      kind: 'detail',
      detail: 'groupDirect',
      accountId: a.id,
      selectable: true,
    });
  }
  return {
    id: a.id,
    name: a.name,
    accountNumber: a.accountNumber,
    isGroup: a.isGroup,
    balance: rows.length > 0 ? sum(rows) : ownBalance,
    children: rows,
    kind: 'account',
    accountId: a.id,
    selectable: !a.isGroup,
  };
}

/** Asset or liability tree. */
export function assembleSection(
  accounts: readonly BsAccount[],
  own: ReadonlyMap<string, Decimal>,
  rootType: 'ASSET' | 'LIABILITY',
): BsNode[] {
  return buildSection(childrenIndex(accounts), own, rootType).map(toPublic);
}

function detailNode(detail: BsDetail, name: string, balance: Decimal, accountId: string | null): Draft {
  return {
    id: `retained-earnings:${detail}`,
    name,
    isGroup: false,
    balance,
    children: [],
    kind: 'detail',
    detail,
    accountId,
    selectable: accountId !== null,
  };
}

/**
 * Equity tree with the current-year profit and retained-earnings rows in place of their accounts.
 * A role without a mapping, or mapped to an account outside the equity tree, gets its row at the
 * top level instead.
 */
export function assembleEquity(input: EquityInput): BsNode[] {
  const index = childrenIndex(input.accounts);
  const inTree = sectionIds(index, 'EQUITY');
  const cpId = input.currentProfitAccountId && inTree.has(input.currentProfitAccountId) ? input.currentProfitAccountId : null;
  const reId = input.retainedEarningsAccountId && inTree.has(input.retainedEarningsAccountId) ? input.retainedEarningsAccountId : null;
  const ownOf = (id: string | null) => (id ? (input.own.get(id) ?? ZERO) : ZERO);
  // Close journals on CURRENT_PROFIT only count when that account is shown here. A close is negative
  // for a profit: it nets the closed years out of the unclosed part. The report year's own close
  // (pre-closing view) is taken back out of the 3.2 balance, measured on its 3.4 side so the parts
  // still add up to the same total.
  const closing = cpId ? input.closingOnCurrentProfit : ZERO;
  const ownClose = cpId ? input.closingInYear : ZERO;
  const priorProfit = input.plAll.sub(input.currentProfit);

  const details = [
    detailNode('retainedAccount', 'Saldo Akun Laba Ditahan', ownOf(reId).add(ownClose), reId),
    detailNode('otherCurrentProfit', 'Posting Lain ke Laba Tahun Berjalan', ownOf(cpId).sub(closing), cpId),
    detailNode('unclosedProfit', 'Laba Tahun Lalu Belum Ditutup', priorProfit.add(closing).sub(ownClose), null),
  ].filter((n) => !n.balance.isZero());

  const retained = (account: BsAccount | null, children: Draft[]): Draft => {
    const rows = [...details, ...children];
    return {
      id: 'retained-earnings',
      name: 'Laba Ditahan',
      accountNumber: account?.accountNumber,
      isGroup: false,
      balance: sum(rows),
      children: rows,
      kind: 'retainedEarnings',
      accountId: account?.id ?? null,
      selectable: false,
    };
  };
  const current = (account: BsAccount | null, children: Draft[]): Draft => ({
    // Id kept from the old report: AIRA output and tests look the row up by it.
    id: 'current-profit',
    name: 'Laba Tahun Berjalan',
    accountNumber: account?.accountNumber,
    isGroup: false,
    balance: input.currentProfit.add(sum(children)),
    children,
    kind: 'currentProfit',
    accountId: null,
    selectable: false,
  });

  const replace = new Map<string, Replace>();
  if (reId) replace.set(reId, retained);
  if (cpId) replace.set(cpId, current);
  const tree = buildSection(index, input.own, 'EQUITY', replace);
  if (!reId) tree.push(retained(null, []));
  if (!cpId) tree.push(current(null, []));
  return tree.map(toPublic);
}

const BS_ROOTS: RootType[] = ['ASSET', 'LIABILITY', 'EQUITY'];
const PL_ROOTS: RootType[] = ['REVENUE', 'EXPENSE'];

const dec = (v: Prisma.Decimal | null | undefined): Decimal => new Prisma.Decimal(v ?? 0);
/** Revenue minus expense of an aggregate over both root types: credit - debit. */
const profitOf = (agg: { _sum: { debit: Decimal | null; credit: Decimal | null } }) => dec(agg._sum.credit).sub(dec(agg._sum.debit));

/**
 * Balance sheet at the end of business day `day`; `lt` is the next day's 00:00 in business time
 * (asOfBound). Reads only; never throws on a missing equity mapping.
 */
export async function computeBalanceSheet(db: Tx, { day, lt }: { day: string; lt: Date }): Promise<BalanceSheetResult> {
  const [fy, closeIds, cpMapped, reMapped] = await Promise.all([
    fiscalYearOn(db, startOfBusinessDay(day)),
    closeJournalIds(db),
    systemAccounts.getAccounts('CURRENT_PROFIT'),
    systemAccounts.getAccounts('RETAINED_EARNINGS'),
  ]);
  const yearStart = fy ? fiscalYearRange(fy) : null;
  const currentProfitFrom = yearStart ? yearStart.startDay : `${day.slice(0, 4)}-01-01`;
  const from = yearStart ? yearStart.gte : startOfBusinessDay(currentProfitFrom);
  const cpId = cpMapped[0]?.id ?? null;
  const reId = reMapped[0]?.id ?? null;
  const live = { isCancelled: false, date: { lt } };

  const closeOnCp = (date: Prisma.DateTimeFilter) =>
    cpId && closeIds.length > 0
      ? db.accountingLedgerEntry.aggregate({
          where: { isCancelled: false, date, accountId: cpId, referenceId: { in: closeIds } },
          _sum: { debit: true, credit: true },
        })
      : null;

  const [accounts, perAccount, plAll, currentProfit, closing, closingInYear] = await Promise.all([
    db.account.findMany({
      where: { rootType: { in: BS_ROOTS } },
      select: { id: true, name: true, accountNumber: true, isGroup: true, parentId: true, rootType: true },
    }),
    db.accountingLedgerEntry.groupBy({
      by: ['accountId'],
      where: { ...live, account: { rootType: { in: BS_ROOTS } } },
      _sum: { debit: true, credit: true },
    }),
    db.accountingLedgerEntry.aggregate({
      where: { ...live, account: { rootType: { in: PL_ROOTS } } },
      _sum: { debit: true, credit: true },
    }),
    db.accountingLedgerEntry.aggregate({
      where: {
        isCancelled: false,
        date: { gte: from, lt },
        account: { rootType: { in: PL_ROOTS } },
        ...(closeIds.length > 0 ? { referenceId: { notIn: closeIds } } : {}),
      },
      _sum: { debit: true, credit: true },
    }),
    closeOnCp({ lt }),
    closeOnCp({ gte: from, lt }),
  ]);

  accounts.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));
  const rootOf = new Map(accounts.map((a) => [a.id, a.rootType]));
  const own = new Map<string, Decimal>();
  for (const row of perAccount) {
    const debit = dec(row._sum.debit);
    const credit = dec(row._sum.credit);
    own.set(row.accountId, rootOf.get(row.accountId) === 'ASSET' ? debit.sub(credit) : credit.sub(debit));
  }

  const assets = assembleSection(accounts, own, 'ASSET');
  const liabilities = assembleSection(accounts, own, 'LIABILITY');
  const equity = assembleEquity({
    accounts,
    own,
    plAll: profitOf(plAll),
    currentProfit: profitOf(currentProfit),
    closingOnCurrentProfit: closing ? profitOf(closing) : ZERO,
    closingInYear: closingInYear ? profitOf(closingInYear) : ZERO,
    currentProfitAccountId: cpId,
    retainedEarningsAccountId: reId,
  });
  const total = (nodes: BsNode[]) => nodes.reduce((s, n) => s.add(n.balance), ZERO).toNumber();
  const equityMappingMissing: EquityRole[] = [];
  if (!cpId) equityMappingMissing.push('CURRENT_PROFIT');
  if (!reId) equityMappingMissing.push('RETAINED_EARNINGS');

  return {
    assets,
    liabilities,
    equity,
    totalAssets: total(assets),
    totalLiabilities: total(liabilities),
    totalEquity: total(equity),
    meta: {
      asOf: day,
      currentProfitFrom,
      fiscalYear: fy ? { id: fy.id, name: fy.name, isClosed: fy.isClosed } : null,
      equityMappingMissing,
    },
  };
}
