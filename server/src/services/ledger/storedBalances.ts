// The one stored-balance rule (E2-R15): accounts.balance = the sum of the active ledger rows
// (accounting_ledger_entries, is_cancelled = false) of every fiscal year and every reference type,
// signed by the normal side (ASSET/EXPENSE debit - credit, the others credit - debit). That is what
// the reports read. The drift check, the drift fix, the recalculation script and the old
// utils/accountBalance.ts recalculateAccountBalances all go through this file.
//
// Closing or reopening a fiscal year does not change these balances. Before PR-5.5 it did: a closed
// year's contribution was subtracted from the revenue/expense accounts at close and added back at
// reopen, each time as it stood at that moment, while every recalculation in between restored the
// whole history. The plan below explains a difference by those close and reopen amounts so the
// accountant can approve the one-time recalculation (applyStoredBalanceRecalc).
import { Prisma, type RootType } from '@prisma/client';
import { lockAccounts } from '../coa/accountStructure';

type Db = Prisma.TransactionClient;

/** Below one cent: the check, the preview, the fix and the script compare with this. */
export const STORED_BALANCE_TOLERANCE = new Prisma.Decimal('0.005');

export interface AccountBalanceDrift {
  accountId: string;
  accountNumber: string;
  name: string;
  rootType: RootType;
  stored: Prisma.Decimal;
  fromLedger: Prisma.Decimal;
  /** stored - fromLedger */
  difference: Prisma.Decimal;
  /** Revenue/expense accounts only: signed sum of the active ledger rows of closed fiscal years. */
  closedYearContribution: Prisma.Decimal;
}

interface DriftRow {
  account_id: string;
  account_number: string;
  name: string;
  root_type: RootType;
  stored: string;
  from_ledger: string;
  closed_contribution: string;
  total: bigint | number;
}

const toDrift = (r: Omit<DriftRow, 'total'>): AccountBalanceDrift => {
  const stored = new Prisma.Decimal(r.stored);
  const fromLedger = new Prisma.Decimal(r.from_ledger);
  return {
    accountId: r.account_id,
    accountNumber: r.account_number,
    name: r.name,
    rootType: r.root_type,
    stored,
    fromLedger,
    difference: stored.minus(fromLedger),
    closedYearContribution: new Prisma.Decimal(r.closed_contribution),
  };
};

const signed = (debit: Prisma.Sql, credit: Prisma.Sql) => Prisma.sql`
  CASE WHEN a."rootType"::text IN ('ASSET', 'EXPENSE') THEN ${debit} - ${credit} ELSE ${credit} - ${debit} END`;

/** Per-account comparison of the stored balance with the ledger, as a CTE named `cmp`. */
function comparisonCte(accountIds: readonly string[] | undefined): Prisma.Sql {
  const only = accountIds ? Prisma.sql`AND ale.account_id = ANY(${[...accountIds]}::text[])` : Prisma.empty;
  const onlyAccounts = accountIds ? Prisma.sql`WHERE a.id = ANY(${[...accountIds]}::text[])` : Prisma.empty;
  return Prisma.sql`
    led AS (
      SELECT ale.account_id,
             SUM(ale.debit) AS debit, SUM(ale.credit) AS credit,
             SUM(ale.debit) FILTER (WHERE fy.is_closed) AS closed_debit,
             SUM(ale.credit) FILTER (WHERE fy.is_closed) AS closed_credit
        FROM accounting_ledger_entries ale
        JOIN fiscal_years fy ON fy.id = ale.fiscal_year_id
       WHERE ale.is_cancelled = false ${only}
       GROUP BY ale.account_id
    ),
    cmp AS (
      SELECT a.id AS account_id, a."accountNumber" AS account_number, a.name, a."rootType" AS root_type,
             a.balance AS stored,
             ${signed(Prisma.sql`COALESCE(l.debit, 0)`, Prisma.sql`COALESCE(l.credit, 0)`)} AS from_ledger,
             CASE WHEN a."rootType"::text IN ('REVENUE', 'EXPENSE')
                  THEN ${signed(Prisma.sql`COALESCE(l.closed_debit, 0)`, Prisma.sql`COALESCE(l.closed_credit, 0)`)}
                  ELSE 0 END AS closed_contribution
        FROM accounts a
        LEFT JOIN led l ON l.account_id = a.id
        ${onlyAccounts}
    )`;
}

/**
 * Accounts whose stored balance differs from the ledger by more than STORED_BALANCE_TOLERANCE, in
 * one query over every account (or `accountIds`), largest difference first. `total` counts them
 * all before `limit` cuts the rows.
 */
export async function findAccountBalanceDrift(
  db: Db,
  opts: { accountIds?: readonly string[]; limit?: number } = {},
): Promise<{ total: number; rows: AccountBalanceDrift[] }> {
  if (opts.accountIds && opts.accountIds.length === 0) return { total: 0, rows: [] };
  const limit = opts.limit !== undefined ? Prisma.sql`LIMIT ${opts.limit}` : Prisma.empty;
  const rows = await db.$queryRaw<DriftRow[]>`
    WITH ${comparisonCte(opts.accountIds)}
    SELECT account_id, account_number, name, root_type, stored::text, from_ledger::text,
           closed_contribution::text, COUNT(*) OVER () AS total
      FROM cmp
     WHERE ABS(stored - from_ledger) > ${STORED_BALANCE_TOLERANCE.toString()}::numeric
     ORDER BY ABS(stored - from_ledger) DESC, account_number
     ${limit}
  `;
  return { total: rows.length > 0 ? Number(rows[0].total) : 0, rows: rows.map(toDrift) };
}

/**
 * Sets accounts.balance to the ledger sum, in the caller's transaction. The account rows are locked
 * first, in id order like postJournal, and the sum is read by a later statement: a posting that
 * holds a row lock is waited for and then counted, one that inserts its ledger rows after the
 * lock adds its increment on top of the result. Only accounts that differ are written.
 * No ids (or an empty list, as before) means every account.
 */
export async function recalculateAccountBalances(
  tx: Db,
  accountIds?: readonly string[],
): Promise<{ changed: AccountBalanceDrift[] }> {
  const ids = accountIds && accountIds.length > 0 ? [...new Set(accountIds)] : undefined;
  if (ids) await lockAccounts(tx, ids);
  else await tx.$queryRaw`SELECT id FROM accounts ORDER BY id FOR UPDATE`;
  const rows = await tx.$queryRaw<Omit<DriftRow, 'total'>[]>`
    WITH ${comparisonCte(ids)}
    UPDATE accounts a
       SET balance = cmp.from_ledger, "updatedAt" = NOW()
      FROM cmp
     WHERE a.id = cmp.account_id
       AND ABS(cmp.stored - cmp.from_ledger) > ${STORED_BALANCE_TOLERANCE.toString()}::numeric
    RETURNING cmp.account_id, cmp.account_number, cmp.name, cmp.root_type, cmp.stored::text,
              cmp.from_ledger::text, cmp.closed_contribution::text
  `;
  const changed = rows.map(toDrift);
  changed.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber));
  return { changed };
}

// ── Recalculation plan (scripts/repair/e2-stored-balance-recalc.ts) ──────────────────────────

export type StoredBalanceClass = 'ok' | 'closed-year' | 'unexplained';

/** A fiscal year whose close or reopen may have moved revenue/expense balances. */
export interface RecalcYear {
  fiscalYearId: string;
  name: string;
  isClosed: boolean;
  /** Has a 'reopen' event: an open reopened year can hold its contribution twice. */
  reopened: boolean;
}

/** A close or reopen of a year, with the amount it moved one account's stored balance by. */
export interface YearEvent {
  action: 'close' | 'reopen';
  /**
   * The year's contribution as the event saw it: its active rows created up to the event. A row
   * cancelled after the event is missing here, so such an account comes out unexplained.
   */
  contribution: Prisma.Decimal;
}

export interface YearContribution {
  year: RecalcYear;
  /** Today's contribution, signed by the account's normal side. */
  contribution: Prisma.Decimal;
  /** The year's closes (-) and reopens (+), oldest first. */
  events: YearEvent[];
}

export interface StoredBalancePlanRow extends AccountBalanceDrift {
  contributions: YearContribution[];
  class: StoredBalanceClass;
  /** The signed years that make up the difference, e.g. "-2024 +2025"; null unless closed-year. */
  explanation: string | null;
}

/** Years beyond this many are not combined; the row is then unexplained. */
export const MAX_COMBINED_YEARS = 12;

/** Combinations beyond this many (years times their candidate amounts) are not tried. */
export const MAX_COMBINATIONS = 1 << MAX_COMBINED_YEARS;

interface Candidate {
  amount: Prisma.Decimal;
  label: string;
  events: number;
}

/**
 * What one year can leave in `stored - ledger`: the events after the last recalculation of the
 * account, i.e. a suffix of its closes (-) and reopens (+), or nothing. Shortest suffix first;
 * suffixes that cancel out are left out.
 */
function yearCandidates(c: YearContribution): Candidate[] {
  const out: Candidate[] = [];
  for (let k = c.events.length - 1; k >= 0; k--) {
    const suffix = c.events.slice(k);
    const amount = suffix.reduce((s, e) => (e.action === 'close' ? s.minus(e.contribution) : s.plus(e.contribution)), new Prisma.Decimal(0));
    if (amount.isZero()) continue;
    const label = suffix.map((e) => `${e.action === 'close' ? '-' : '+'}${c.year.name}`).join(' ');
    out.push({ amount, label, events: suffix.length });
  }
  return out;
}

/**
 * Pure: `ok` within the tolerance, `closed-year` when the difference equals the sum of one
 * candidate (see yearCandidates) for each of a set of years (fewest years and events first),
 * `unexplained` otherwise.
 */
export function classifyStoredBalance(
  difference: Prisma.Decimal.Value,
  contributions: readonly YearContribution[],
): { class: StoredBalanceClass; explanation: string | null } {
  const diff = new Prisma.Decimal(difference);
  if (diff.abs().lte(STORED_BALANCE_TOLERANCE)) return { class: 'ok', explanation: null };
  const terms = contributions.map(yearCandidates).filter((t) => t.length > 0);
  const size = terms.reduce((n, t) => n * (t.length + 1), 1);
  if (terms.length === 0 || terms.length > MAX_COMBINED_YEARS || size > MAX_COMBINATIONS) {
    return { class: 'unexplained', explanation: null };
  }
  // Built from the last year back so equal-sized combinations keep the earlier years first.
  let combos: Candidate[][] = [[]];
  for (const t of [...terms].reverse()) combos = combos.flatMap((c) => [c, ...t.map((k) => [k, ...c])]);
  const events = (c: Candidate[]) => c.reduce((n, k) => n + k.events, 0);
  const ordered = combos.filter((c) => c.length > 0).sort((x, y) => x.length - y.length || events(x) - events(y));
  for (const picked of ordered) {
    const sum = picked.reduce((s, k) => s.plus(k.amount), new Prisma.Decimal(0));
    if (sum.minus(diff).abs().lte(STORED_BALANCE_TOLERANCE)) {
      return { class: 'closed-year', explanation: picked.map((k) => k.label).join(' ') };
    }
  }
  return { class: 'unexplained', explanation: null };
}

/**
 * Read-only plan of the recalculation: every account that drifts, plus every revenue/expense
 * account with ledger rows in a closed or reopened year (shown even when it agrees), each with
 * its per-year contributions and class. Writes nothing.
 */
export async function planStoredBalanceRecalc(db: Db): Promise<{ years: RecalcYear[]; rows: StoredBalancePlanRow[] }> {
  const yearRows = await db.$queryRaw<{ id: string; name: string; is_closed: boolean; reopened: boolean }[]>`
    SELECT fy.id, fy.name, fy.is_closed,
           EXISTS (SELECT 1 FROM fiscal_year_events e WHERE e.fiscal_year_id = fy.id AND e.action = 'reopen') AS reopened
      FROM fiscal_years fy
     WHERE fy.is_closed
        OR EXISTS (SELECT 1 FROM fiscal_year_events e WHERE e.fiscal_year_id = fy.id AND e.action = 'reopen')
     ORDER BY fy.start_date, fy.name
  `;
  const years: RecalcYear[] = yearRows.map((y) => ({ fiscalYearId: y.id, name: y.name, isClosed: y.is_closed, reopened: y.reopened }));

  const byAccount = years.length === 0 ? new Map<string, YearContribution[]>() : await yearContributions(db, years);

  const drifted = await findAccountBalanceDrift(db);
  const seen = new Set(drifted.rows.map((r) => r.accountId));
  const agreeing = [...byAccount.keys()].filter((id) => !seen.has(id));
  const agreeingRows = agreeing.length === 0 ? [] : await db.$queryRaw<Omit<DriftRow, 'total'>[]>`
    WITH ${comparisonCte(agreeing)}
    SELECT account_id, account_number, name, root_type, stored::text, from_ledger::text, closed_contribution::text
      FROM cmp
  `;

  const order = new Map(years.map((y, i) => [y.fiscalYearId, i]));
  const rows = [...drifted.rows, ...agreeingRows.map(toDrift)].map((r): StoredBalancePlanRow => {
    const contributions = (byAccount.get(r.accountId) ?? [])
      .sort((x, y) => order.get(x.year.fiscalYearId)! - order.get(y.year.fiscalYearId)!);
    return { ...r, contributions, ...classifyStoredBalance(r.difference, contributions) };
  });
  rows.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber));
  return { years, rows };
}

/**
 * Per revenue/expense account: each year's contribution today and as each of its closes and
 * reopens saw it (the rows created up to the event). A closed year without a close event (closed
 * before the events were recorded) gets one with today's contribution.
 */
async function yearContributions(db: Db, years: readonly RecalcYear[]): Promise<Map<string, YearContribution[]>> {
  const ids = years.map((y) => y.fiscalYearId);
  const today = await db.$queryRaw<{ account_id: string; fiscal_year_id: string; contribution: string }[]>`
    SELECT ale.account_id, ale.fiscal_year_id,
           (${signed(Prisma.sql`SUM(ale.debit)`, Prisma.sql`SUM(ale.credit)`)})::text AS contribution
      FROM accounting_ledger_entries ale
      JOIN accounts a ON a.id = ale.account_id
     WHERE ale.is_cancelled = false
       AND a."rootType"::text IN ('REVENUE', 'EXPENSE')
       AND ale.fiscal_year_id = ANY(${ids}::text[])
     GROUP BY ale.account_id, ale.fiscal_year_id, a."rootType"
  `;
  const events = await db.$queryRaw<{ id: string; fiscal_year_id: string; action: 'close' | 'reopen' }[]>`
    SELECT id, fiscal_year_id, action FROM fiscal_year_events
     WHERE fiscal_year_id = ANY(${ids}::text[]) ORDER BY created_at, id
  `;
  const atEvent = events.length === 0 ? [] : await db.$queryRaw<{ account_id: string; event_id: string; contribution: string }[]>`
    SELECT ale.account_id, e.id AS event_id,
           (${signed(Prisma.sql`SUM(ale.debit)`, Prisma.sql`SUM(ale.credit)`)})::text AS contribution
      FROM fiscal_year_events e
      JOIN accounting_ledger_entries ale
        ON ale.fiscal_year_id = e.fiscal_year_id AND ale.created_at <= e.created_at AND ale.is_cancelled = false
      JOIN accounts a ON a.id = ale.account_id
     WHERE e.fiscal_year_id = ANY(${ids}::text[])
       AND a."rootType"::text IN ('REVENUE', 'EXPENSE')
     GROUP BY ale.account_id, e.id, a."rootType"
  `;
  const key = (accountId: string, other: string) => `${accountId}|${other}`;
  const todayOf = new Map(today.map((t) => [key(t.account_id, t.fiscal_year_id), new Prisma.Decimal(t.contribution)]));
  const atEventOf = new Map(atEvent.map((t) => [key(t.account_id, t.event_id), new Prisma.Decimal(t.contribution)]));
  const accountIds = new Set([...today.map((t) => t.account_id), ...atEvent.map((t) => t.account_id)]);

  const byAccount = new Map<string, YearContribution[]>();
  for (const accountId of accountIds) {
    const list: YearContribution[] = [];
    for (const year of years) {
      const contribution = todayOf.get(key(accountId, year.fiscalYearId)) ?? new Prisma.Decimal(0);
      const yearEvents: YearEvent[] = events
        .filter((e) => e.fiscal_year_id === year.fiscalYearId)
        .map((e) => ({ action: e.action, contribution: atEventOf.get(key(accountId, e.id)) ?? new Prisma.Decimal(0) }));
      if (year.isClosed && yearEvents.at(-1)?.action !== 'close') yearEvents.push({ action: 'close', contribution });
      if (contribution.isZero() && yearEvents.every((e) => e.contribution.isZero())) continue;
      list.push({ year, contribution, events: yearEvents });
    }
    if (list.length > 0) byAccount.set(accountId, list);
  }
  return byAccount;
}

// ── One-time recalculation (--apply) ─────────────────────────────────────────────────────────

export const STORED_BALANCE_AUDIT_ACTION = 'E2_STORED_BALANCE_RECALC';

export interface StoredBalanceApplyOptions {
  approvedBy: string;
  /** Also write `unexplained` rows; only for rows the accountant reviewed one by one. */
  includeUnexplained?: boolean;
}

export interface StoredBalanceApplyResult {
  approvedBy: string;
  /** Accounts set to the ledger sum, by account number. */
  applied: AccountBalanceDrift[];
  /** unexplained without includeUnexplained; changed-since-plan when the difference moved after the plan. */
  skipped: { accountNumber: string; reason: 'unexplained' | 'changed-since-plan' }[];
}

/**
 * Writes the planned `closed-year` rows (and `unexplained` ones with includeUnexplained) through
 * recalculateAccountBalances, in the caller's transaction, with one audit row per account naming
 * the accountant. A row whose difference is no longer the planned one is skipped. Refuses without
 * an approver name, before writing anything.
 */
export async function applyStoredBalanceRecalc(
  tx: Db,
  plan: readonly StoredBalancePlanRow[],
  options: StoredBalanceApplyOptions,
): Promise<StoredBalanceApplyResult> {
  const approvedBy = options.approvedBy.trim();
  if (!approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  const skipped: StoredBalanceApplyResult['skipped'] = [];
  const wanted = plan.filter((r) => {
    if (r.class === 'closed-year') return true;
    if (r.class !== 'unexplained') return false;
    if (!options.includeUnexplained) skipped.push({ accountNumber: r.accountNumber, reason: 'unexplained' });
    return Boolean(options.includeUnexplained);
  });
  if (wanted.length === 0) return { approvedBy, applied: [], skipped };

  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');

  // Locked before the re-read, so the difference compared below is the one that gets written.
  await lockAccounts(tx, wanted.map((r) => r.accountId));
  const now = new Map((await findAccountBalanceDrift(tx, { accountIds: wanted.map((r) => r.accountId) })).rows.map((r) => [r.accountId, r]));
  const ids: string[] = [];
  for (const row of wanted) {
    const current = now.get(row.accountId);
    if (!current || current.difference.minus(row.difference).abs().gt(STORED_BALANCE_TOLERANCE)) {
      skipped.push({ accountNumber: row.accountNumber, reason: 'changed-since-plan' });
    } else {
      ids.push(row.accountId);
    }
  }
  if (ids.length === 0) return { approvedBy, applied: [], skipped };

  const { changed } = await recalculateAccountBalances(tx, ids);
  const planOf = new Map(wanted.map((r) => [r.accountId, r]));
  for (const c of changed) {
    const row = planOf.get(c.accountId)!;
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: STORED_BALANCE_AUDIT_ACTION,
        entityType: 'Account',
        entityId: c.accountId,
        oldValues: { balance: c.stored.toFixed(2) },
        newValues: {
          balance: c.fromLedger.toFixed(2),
          class: row.class,
          explanation: row.explanation,
          closedYearContribution: c.closedYearContribution.toFixed(2),
          approvedBy,
        },
        via: 'repair',
        viaMeta: { script: STORED_BALANCE_AUDIT_ACTION, approvedBy },
      },
    });
  }
  return { approvedBy, applied: changed, skipped };
}
