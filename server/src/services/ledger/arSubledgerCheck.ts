// Receivable and customer deposit balances per Customer: the general ledger (active ledger rows on
// the AR / CUSTOMER_DEPOSIT accounts, by party_id) against the subledger the documents keep
// (invoice outstanding plus opening receivable plus the manual party adjustment of
// services/ledger/partyAdjustments.ts; deposit amount less applications and refunds). The ledger
// side reads the role's accounts through the caller's transaction, including the accounts the role
// held before a remap (roleAccountIds includeFormer), so a document voided after a remap still
// lands on the party.
// Used by the health check (routes/health/arChecks.ts, every party) and the year-close checklist
// (services/ledger/arSubledgerCloseChecks.ts, parties active in the year: a ledger row or a document
// dated in it, so a document whose ledger row is missing is still checked). Takes the caller's
// transaction, like aleSyncCheck.ts.
//
// Limit: both sides are today's balances, not the position at a year end. The subledger has no
// history per date (an invoice only keeps its current outstanding), so closing an earlier year also
// counts what later transactions did to the same Customer.
import { Prisma } from '@prisma/client';
import { ADJUSTMENT_SIGN, manualPartyAdjustmentSql } from './partyAdjustments';
import { roleAccountIds } from './partyRules';

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
}

export interface SubledgerScope {
  /** Only these parties; the bucket without a party is left out. */
  partyIds?: readonly string[];
  /**
   * Only parties active in this half-open range: a ledger row on the account, or a document of the
   * subledger (see each finder), dated in it. The bucket without a party counts only the range's
   * rows (the close checklist passes the year being closed).
   */
  fiscalYear?: { gte: Date; lt: Date };
}

interface DiffRow {
  party_id: string | null;
  party_name: string | null;
  party_type: string | null;
  gl: string;
  subledger: string;
}

/**
 * Parties active in `range`: a ledger row on `accountIds` dated in it, or one of `documents` (a
 * query of party_id over the subledger's documents in the same range). Used as the `active` CTE.
 */
function activeCte(accountIds: string[], range: { gte: Date; lt: Date }, documents: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT a2.party_id FROM accounting_ledger_entries a2
     WHERE a2.is_cancelled = false AND a2.account_id IN (${Prisma.join(accountIds)})
       AND a2.party_id IS NOT NULL AND a2.date >= ${range.gte} AND a2.date < ${range.lt}
    UNION
    SELECT d.party_id FROM (${documents}) d WHERE d.party_id IS NOT NULL`;
}

/**
 * Ledger sum per party on `accountIds`, signed by `sign` (debit - credit or credit - debit). In a
 * year-scoped run it reads the `active` CTE.
 */
function glCte(accountIds: string[], sign: Prisma.Sql, scope: SubledgerScope): Prisma.Sql {
  const accounts = Prisma.join(accountIds);
  const filters: Prisma.Sql[] = [Prisma.sql`ale.is_cancelled = false`, Prisma.sql`ale.account_id IN (${accounts})`];
  if (scope.partyIds) filters.push(Prisma.sql`ale.party_id IN (${Prisma.join(scope.partyIds)})`);
  if (scope.fiscalYear) {
    const { gte, lt } = scope.fiscalYear;
    // Parties active in the year: all their rows count. Rows without a party: only the year's.
    filters.push(Prisma.sql`(
      (ale.party_id IS NULL AND ale.date >= ${gte} AND ale.date < ${lt})
      OR ale.party_id IN (SELECT party_id FROM active)
    )`);
  }
  return Prisma.sql`
    SELECT ale.party_id, SUM(${sign}) AS amount
      FROM accounting_ledger_entries ale
     WHERE ${Prisma.join(filters, ' AND ')}
     GROUP BY ale.party_id`;
}

/**
 * Joins the gl and sub CTEs per party and keeps the rows that differ by more than the tolerance.
 * `active` (activeCte) is required in a year-scoped run.
 */
async function diffs(tx: Tx, gl: Prisma.Sql, sub: Prisma.Sql, scope: SubledgerScope, active: Prisma.Sql | null): Promise<PartySubledgerDiff[]> {
  // In a year-scoped run both sides cover the parties active in the year.
  const withActive = scope.fiscalYear && active ? Prisma.sql`active AS (${active}),` : Prisma.empty;
  const subFilters: Prisma.Sql[] = [];
  if (scope.fiscalYear) subFilters.push(Prisma.sql`s.party_id IN (SELECT party_id FROM active)`);
  if (scope.partyIds) subFilters.push(Prisma.sql`s.party_id IN (${Prisma.join(scope.partyIds)})`);
  const subScope = subFilters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(subFilters, ' AND ')}` : Prisma.empty;
  const rows = await tx.$queryRaw<DiffRow[]>`
    WITH ${withActive} gl AS (${gl}),
    sub AS (SELECT s.* FROM (${sub}) s ${subScope}),
    joined AS (
      SELECT COALESCE(g.party_id, s.party_id) AS party_id,
             COALESCE(g.amount, 0) AS gl,
             COALESCE(s.amount, 0) AS subledger
        FROM gl g
        FULL OUTER JOIN sub s ON s.party_id = g.party_id
    )
    SELECT j.party_id, p.name AS party_name, p."partyType"::text AS party_type,
           j.gl::text AS gl, j.subledger::text AS subledger
      FROM joined j
      LEFT JOIN parties p ON p.id = j.party_id
     WHERE ABS(j.gl - j.subledger) > ${SUBLEDGER_TOLERANCE}::numeric
     ORDER BY ABS(j.gl - j.subledger) DESC, p.name NULLS FIRST
  `;
  return rows.map((r) => {
    const glAmount = new Prisma.Decimal(r.gl);
    const subAmount = new Prisma.Decimal(r.subledger);
    return {
      partyId: r.party_id,
      partyName: r.party_name,
      partyType: r.party_type,
      gl: glAmount,
      subledger: subAmount,
      difference: glAmount.minus(subAmount),
    };
  });
}

/**
 * Receivable per party: ledger debit - credit on the AR accounts (current and former) against the
 * outstanding of its sales invoices (not Draft or Cancelled), plus its manual party adjustment on
 * those accounts (hand-made journals, whatever the party type), plus its opening receivable (the
 * opening directed to the receivable side plus what the migration left undirected, legacyUnassigned,
 * services/ledger/partySides.ts). A ledger row without a source type is not an adjustment and still
 * shows up. A party typed Both has its payable side checked apart from this one. The inclusion test uses the same expression as the amount (opening_outstanding - opening_payable). A Pay remainder of a Both party takes its payable opening only (services/ledger/partyOpeningConsumption.ts); one recorded before PR-5.13 lowered opening_outstanding and shows up here. In a year-scoped run a party with such an invoice dated in the year is active.
 * [] while AR is not mapped. Largest difference first.
 */
export async function findArSubledgerDiffs(tx: Tx, scope: SubledgerScope = {}): Promise<PartySubledgerDiff[]> {
  const accountIds = await roleAccountIds(tx, 'AR', { includeFormer: true });
  if (accountIds.length === 0 || scope.partyIds?.length === 0) return [];
  const gl = glCte(accountIds, Prisma.sql`ale.debit - ale.credit`, scope);
  const sub = Prisma.sql`
    SELECT p.id AS party_id,
           COALESCE(inv.outstanding, 0) + COALESCE(adj.amount, 0)
             + CASE WHEN p."partyType" IN ('Customer', 'Both')
                    THEN p.opening_receivable + (p.opening_outstanding - p.opening_receivable - p.opening_payable)
                    ELSE 0 END AS amount
      FROM parties p
      LEFT JOIN (
        SELECT party_id, SUM(outstanding) AS outstanding
          FROM sales_invoices
         WHERE status NOT IN ('Draft', 'Cancelled')
         GROUP BY party_id
      ) inv ON inv.party_id = p.id
      LEFT JOIN (${manualPartyAdjustmentSql(accountIds, ADJUSTMENT_SIGN.AR)}) adj ON adj.party_id = p.id
     WHERE inv.party_id IS NOT NULL OR adj.party_id IS NOT NULL
        OR (p."partyType" IN ('Customer', 'Both') AND (p.opening_outstanding - p.opening_payable) <> 0)`;
  const active = scope.fiscalYear
    ? activeCte(accountIds, scope.fiscalYear, Prisma.sql`
        SELECT party_id FROM sales_invoices
         WHERE status NOT IN ('Draft', 'Cancelled') AND date >= ${scope.fiscalYear.gte} AND date < ${scope.fiscalYear.lt}`)
    : null;
  return diffs(tx, gl, sub, scope, active);
}

/**
 * Customer deposit per party: ledger credit - debit on the CUSTOMER_DEPOSIT accounts (current and
 * former) against what is left of its Submitted deposits (amount - active applications - refunded,
 * as depositFigures in services/customerDepositList.ts). No manual adjustment: manual journals to a
 * deposit account are refused (manualJournalRule), so an old one shows up as a difference. In a
 * year-scoped run a party with a Submitted deposit, or an active application, dated in the year is
 * active. [] while the account is not mapped. Largest difference first.
 */
export async function findCustomerDepositDiffs(tx: Tx, scope: SubledgerScope = {}): Promise<PartySubledgerDiff[]> {
  const accountIds = await roleAccountIds(tx, 'CUSTOMER_DEPOSIT', { includeFormer: true });
  if (accountIds.length === 0 || scope.partyIds?.length === 0) return [];
  const gl = glCte(accountIds, Prisma.sql`ale.credit - ale.debit`, scope);
  const sub = Prisma.sql`
    SELECT pay.party_id, SUM(pay.amount - pay.refunded_amount - COALESCE(app.applied, 0)) AS amount
      FROM payments pay
      LEFT JOIN (
        SELECT deposit_payment_id, SUM(applied_amount) AS applied
          FROM customer_deposit_applications
         WHERE is_cancelled = false
         GROUP BY deposit_payment_id
      ) app ON app.deposit_payment_id = pay.id
     WHERE pay.payment_type = 'CustomerDeposit' AND pay.status = 'Submitted'
     GROUP BY pay.party_id`;
  const range = scope.fiscalYear;
  const active = range
    ? activeCte(accountIds, range, Prisma.sql`
        SELECT party_id FROM payments
         WHERE payment_type = 'CustomerDeposit' AND status = 'Submitted' AND date >= ${range.gte} AND date < ${range.lt}
        UNION
        SELECT pay.party_id FROM customer_deposit_applications cda
          JOIN payments pay ON pay.id = cda.deposit_payment_id
         WHERE cda.is_cancelled = false AND cda.applied_at >= ${range.gte} AND cda.applied_at < ${range.lt}`)
    : null;
  return diffs(tx, gl, sub, scope, active);
}
