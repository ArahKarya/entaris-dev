// Receivable and customer deposit balances per Customer: the general ledger (active ledger rows on
// the AR / CUSTOMER_DEPOSIT accounts, by party_id) against the subledger the documents keep
// (invoice outstanding plus opening outstanding; deposit amount less applications and refunds).
// Used by the health check (routes/health/arChecks.ts, every party) and the year-close checklist
// (services/ledger/arSubledgerCloseChecks.ts, parties active in the year). Takes the caller's
// transaction, like aleSyncCheck.ts.
//
// Limit: both sides are today's balances, not the position at a year end. The subledger has no
// history per date (an invoice only keeps its current outstanding), so closing an earlier year also
// counts what later transactions did to the same Customer.
import { Prisma } from '@prisma/client';
import { systemAccounts } from '../systemAccounts';

type Tx = Prisma.TransactionClient;

/** Differences up to this amount are rounding and are not reported. */
export const SUBLEDGER_TOLERANCE = '0.01';

export interface PartySubledgerDiff {
  /** Null for the bucket of ledger rows without a party ("(tanpa customer)"). */
  partyId: string | null;
  partyName: string | null;
  partyType: string | null;
  gl: Prisma.Decimal;
  subledger: Prisma.Decimal;
  /** gl - subledger. */
  difference: Prisma.Decimal;
  /** AR only: opening outstanding of a party typed Both, left out of the subledger (it may be payable). */
  openingIgnored?: Prisma.Decimal;
}

export interface SubledgerScope {
  /** Only these parties; the bucket without a party is left out. */
  partyIds?: readonly string[];
  /**
   * Only parties with a ledger row on the account dated in this half-open range, and the bucket
   * without a party counts only rows in it (the close checklist passes the year being closed).
   */
  fiscalYear?: { gte: Date; lt: Date };
}

interface DiffRow {
  party_id: string | null;
  party_name: string | null;
  party_type: string | null;
  gl: string;
  subledger: string;
  opening_ignored: string | null;
}

/** Ledger sum per party on `accountIds`, signed by `sign` (debit - credit or credit - debit). */
function glCte(accountIds: string[], sign: Prisma.Sql, scope: SubledgerScope): Prisma.Sql {
  const accounts = Prisma.join(accountIds);
  const filters: Prisma.Sql[] = [Prisma.sql`ale.is_cancelled = false`, Prisma.sql`ale.account_id IN (${accounts})`];
  if (scope.partyIds) filters.push(Prisma.sql`ale.party_id IN (${Prisma.join(scope.partyIds)})`);
  if (scope.fiscalYear) {
    const { gte, lt } = scope.fiscalYear;
    // Parties active in the year: all their rows count. Rows without a party: only the year's.
    filters.push(Prisma.sql`(
      (ale.party_id IS NULL AND ale.date >= ${gte} AND ale.date < ${lt})
      OR ale.party_id IN (
        SELECT DISTINCT a2.party_id FROM accounting_ledger_entries a2
         WHERE a2.is_cancelled = false AND a2.account_id IN (${accounts})
           AND a2.party_id IS NOT NULL AND a2.date >= ${gte} AND a2.date < ${lt}
      )
    )`);
  }
  return Prisma.sql`
    SELECT ale.party_id, SUM(${sign}) AS amount
      FROM accounting_ledger_entries ale
     WHERE ${Prisma.join(filters, ' AND ')}
     GROUP BY ale.party_id`;
}

/** Joins the gl and sub CTEs per party and keeps the rows that differ by more than the tolerance. */
async function diffs(tx: Tx, gl: Prisma.Sql, sub: Prisma.Sql, scope: SubledgerScope): Promise<PartySubledgerDiff[]> {
  // In a scoped run the subledger side only covers the parties the ledger side found active.
  const subScope = scope.fiscalYear
    ? Prisma.sql`WHERE s.party_id IN (SELECT party_id FROM gl WHERE party_id IS NOT NULL)`
    : scope.partyIds
      ? Prisma.sql`WHERE s.party_id IN (${Prisma.join(scope.partyIds)})`
      : Prisma.empty;
  const rows = await tx.$queryRaw<DiffRow[]>`
    WITH gl AS (${gl}),
    sub AS (SELECT s.* FROM (${sub}) s ${subScope}),
    joined AS (
      SELECT COALESCE(g.party_id, s.party_id) AS party_id,
             COALESCE(g.amount, 0) AS gl,
             COALESCE(s.amount, 0) AS subledger,
             s.opening_ignored
        FROM gl g
        FULL OUTER JOIN sub s ON s.party_id = g.party_id
    )
    SELECT j.party_id, p.name AS party_name, p."partyType"::text AS party_type,
           j.gl::text AS gl, j.subledger::text AS subledger, j.opening_ignored::text AS opening_ignored
      FROM joined j
      LEFT JOIN parties p ON p.id = j.party_id
     WHERE ABS(j.gl - j.subledger) > ${SUBLEDGER_TOLERANCE}::numeric
     ORDER BY ABS(j.gl - j.subledger) DESC, p.name NULLS FIRST
  `;
  return rows.map((r) => {
    const glAmount = new Prisma.Decimal(r.gl);
    const subAmount = new Prisma.Decimal(r.subledger);
    const ignored = r.opening_ignored === null ? null : new Prisma.Decimal(r.opening_ignored);
    return {
      partyId: r.party_id,
      partyName: r.party_name,
      partyType: r.party_type,
      gl: glAmount,
      subledger: subAmount,
      difference: glAmount.minus(subAmount),
      ...(ignored && !ignored.isZero() ? { openingIgnored: ignored } : {}),
    };
  });
}

/**
 * Receivable per party: ledger debit - credit on the AR accounts against the outstanding of its
 * sales invoices (not Draft or Cancelled) plus its opening outstanding. Opening outstanding counts
 * for Customers only; a party typed Both shares it with payables, so it is left out and reported in
 * `openingIgnored`. [] while AR is not mapped. Largest difference first.
 */
export async function findArSubledgerDiffs(tx: Tx, scope: SubledgerScope = {}): Promise<PartySubledgerDiff[]> {
  const accountIds = await systemAccounts.getAccountIds('AR');
  if (accountIds.length === 0 || scope.partyIds?.length === 0) return [];
  const gl = glCte(accountIds, Prisma.sql`ale.debit - ale.credit`, scope);
  const sub = Prisma.sql`
    SELECT p.id AS party_id,
           COALESCE(inv.outstanding, 0)
             + CASE WHEN p."partyType" = 'Customer' THEN p.opening_outstanding ELSE 0 END AS amount,
           CASE WHEN p."partyType" = 'Both' THEN p.opening_outstanding END AS opening_ignored
      FROM parties p
      LEFT JOIN (
        SELECT party_id, SUM(outstanding) AS outstanding
          FROM sales_invoices
         WHERE status NOT IN ('Draft', 'Cancelled')
         GROUP BY party_id
      ) inv ON inv.party_id = p.id
     WHERE inv.party_id IS NOT NULL OR (p."partyType" IN ('Customer', 'Both') AND p.opening_outstanding <> 0)`;
  return diffs(tx, gl, sub, scope);
}

/**
 * Customer deposit per party: ledger credit - debit on the CUSTOMER_DEPOSIT accounts against what
 * is left of its Submitted deposits (amount - active applications - refunded, as depositFigures in
 * services/customerDepositList.ts). [] while the account is not mapped. Largest difference first.
 */
export async function findCustomerDepositDiffs(tx: Tx, scope: SubledgerScope = {}): Promise<PartySubledgerDiff[]> {
  const accountIds = await systemAccounts.getAccountIds('CUSTOMER_DEPOSIT');
  if (accountIds.length === 0 || scope.partyIds?.length === 0) return [];
  const gl = glCte(accountIds, Prisma.sql`ale.credit - ale.debit`, scope);
  const sub = Prisma.sql`
    SELECT pay.party_id, SUM(pay.amount - pay.refunded_amount - COALESCE(app.applied, 0)) AS amount,
           NULL::numeric AS opening_ignored
      FROM payments pay
      LEFT JOIN (
        SELECT deposit_payment_id, SUM(applied_amount) AS applied
          FROM customer_deposit_applications
         WHERE is_cancelled = false
         GROUP BY deposit_payment_id
      ) app ON app.deposit_payment_id = pay.id
     WHERE pay.payment_type = 'CustomerDeposit' AND pay.status = 'Submitted'
     GROUP BY pay.party_id`;
  return diffs(tx, gl, sub, scope);
}
