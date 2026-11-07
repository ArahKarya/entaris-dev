// The one stored-balance rule (E2-R15): accounts.balance = the sum of the active ledger rows
// (accounting_ledger_entries, is_cancelled = false) of every fiscal year and every reference type,
// signed by the normal side (ASSET/EXPENSE debit - credit, the others credit - debit). That is what
// the reports read. The drift check, the drift fix, the recalculation script and the old
// utils/accountBalance.ts recalculateAccountBalances all go through this file.
//
// Until the year close stops changing revenue/expense balances (PR-5.5), a closed year's
// contribution is subtracted from those accounts at close and added back at reopen, while every
// recalculation in between restores the whole history. The plan below explains a difference by
// those per-year contributions so the accountant can approve the one-time recalculation.
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

export interface YearContribution {
  year: RecalcYear;
  /** Signed by the account's normal side. */
  contribution: Prisma.Decimal;
}

export interface StoredBalancePlanRow extends AccountBalanceDrift {
  contributions: YearContribution[];
  class: StoredBalanceClass;
  /** The signed years that make up the difference, e.g. "-2024 +2025"; null unless closed-year. */
  explanation: string | null;
}

/** Years beyond this many are not combined (2^n subsets); the row is then unexplained. */
export const MAX_COMBINED_YEARS = 12;

/**
 * The sign a year's contribution can carry in `stored - ledger`: the close subtracts it (a closed
 * year: -1, or 0 after a recalculation), the reopen adds it back (an open reopened year: +1 when a
 * recalculation ran while it was closed, else 0). Any other year: 0.
 */
const allowedSign = (y: RecalcYear): -1 | 1 | 0 => (y.isClosed ? -1 : y.reopened ? 1 : 0);

/**
 * Pure: `ok` within the tolerance, `closed-year` when the difference equals the signed sum of a
 * subset of the contributions (smallest subset first), `unexplained` otherwise.
 */
export function classifyStoredBalance(
  difference: Prisma.Decimal.Value,
  contributions: readonly YearContribution[],
): { class: StoredBalanceClass; explanation: string | null } {
  const diff = new Prisma.Decimal(difference);
  if (diff.abs().lte(STORED_BALANCE_TOLERANCE)) return { class: 'ok', explanation: null };
  const terms = contributions
    .map((c) => ({ c, sign: allowedSign(c.year) }))
    .filter((t) => t.sign !== 0 && !t.c.contribution.isZero());
  if (terms.length === 0 || terms.length > MAX_COMBINED_YEARS) return { class: 'unexplained', explanation: null };
  const masks = Array.from({ length: (1 << terms.length) - 1 }, (_, i) => i + 1);
  const bits = (m: number) => terms.filter((_, i) => m & (1 << i));
  masks.sort((x, y) => bits(x).length - bits(y).length || x - y);
  for (const mask of masks) {
    const picked = bits(mask);
    const sum = picked.reduce((s, t) => s.plus(t.c.contribution.times(t.sign)), new Prisma.Decimal(0));
    if (sum.minus(diff).abs().lte(STORED_BALANCE_TOLERANCE)) {
      return {
        class: 'closed-year',
        explanation: picked.map((t) => `${t.sign < 0 ? '-' : '+'}${t.c.year.name}`).join(' '),
      };
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
  const yearById = new Map(years.map((y) => [y.fiscalYearId, y]));

  const sums = years.length === 0 ? [] : await db.$queryRaw<{ account_id: string; fiscal_year_id: string; contribution: string }[]>`
    SELECT ale.account_id, ale.fiscal_year_id,
           (${signed(Prisma.sql`SUM(ale.debit)`, Prisma.sql`SUM(ale.credit)`)})::text AS contribution
      FROM accounting_ledger_entries ale
      JOIN accounts a ON a.id = ale.account_id
     WHERE ale.is_cancelled = false
       AND a."rootType"::text IN ('REVENUE', 'EXPENSE')
       AND ale.fiscal_year_id = ANY(${years.map((y) => y.fiscalYearId)}::text[])
     GROUP BY ale.account_id, ale.fiscal_year_id, a."rootType"
  `;
  const byAccount = new Map<string, YearContribution[]>();
  for (const s of sums) {
    const contribution = new Prisma.Decimal(s.contribution);
    if (contribution.isZero()) continue;
    const list = byAccount.get(s.account_id) ?? [];
    list.push({ year: yearById.get(s.fiscal_year_id)!, contribution });
    byAccount.set(s.account_id, list);
  }

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
