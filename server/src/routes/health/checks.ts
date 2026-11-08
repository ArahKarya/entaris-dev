// Diagnostic checks for /api/health-check. Each returns a CheckResult with
// (name, status, message, count, details, fixable). Lifted out of the main
// route file to keep that under the 800-line target. Ledger row checks are in
// aleChecks.ts, party checks in partyChecks.ts.
import { prisma } from '../../lib/prisma';
import { findAccountBalanceDrift, type AccountBalanceDrift } from '../../services/ledger/storedBalances';

export interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  count: number;
  details?: unknown[];
  fixable: boolean;
}

const DRIFT_DETAIL_LIMIT = 20;

/**
 * Account balance drift: accounts.balance against the sum of the account's active ledger rows over
 * every year (services/ledger/storedBalances.ts, the rule the fix and the recalculation script use).
 * `count` is every drifting account; details are the largest DRIFT_DETAIL_LIMIT. For a revenue or
 * expense account closed_year_contribution is what closed years hold, which a close before the one
 * stored-balance rule took off the stored balance.
 */
export async function checkAccountBalanceDrift(scope: { accountIds?: readonly string[] } = {}): Promise<CheckResult> {
  const { total, rows } = await findAccountBalanceDrift(prisma, { accountIds: scope.accountIds, limit: DRIFT_DETAIL_LIMIT });
  return {
    name: 'Account Balance Drift',
    status: total > 0 ? 'warning' : 'ok',
    message: total > 0
      ? `${total} akun: saldo tersimpan berbeda dengan buku besar`
      : 'Saldo tersimpan semua akun sama dengan buku besar',
    count: total,
    details: rows.map(driftDetail),
    fixable: true,
  };
}

/** One drift row for the check and the fix preview. */
export function driftDetail(r: AccountBalanceDrift) {
  return {
    account_code: r.accountNumber,
    account_name: r.name,
    root_type: r.rootType,
    stored_balance: r.stored.toNumber(),
    ledger_balance: r.fromLedger.toNumber(),
    difference: r.difference.toNumber(),
    closed_year_contribution: r.closedYearContribution.toNumber(),
  };
}

/**
 * Unbalanced journal entries
 * Find posted journals where total debit != total credit.
 */
export async function checkUnbalancedJournals(): Promise<CheckResult> {
  const unbalanced = await prisma.$queryRaw<Array<{
    journal_id: string;
    entry_number: string;
    total_debit: number;
    total_credit: number;
    difference: number;
    total: bigint;
  }>>`
    SELECT je.id AS journal_id,
           je.entry_number,
           SUM(jea.debit)  AS total_debit,
           SUM(jea.credit) AS total_credit,
           ABS(SUM(jea.debit) - SUM(jea.credit)) AS difference,
           COUNT(*) OVER () AS total
      FROM journal_entries je
      JOIN journal_entry_accounts jea ON jea.journal_entry_id = je.id
     WHERE je.status = 'Submitted'
     GROUP BY je.id, je.entry_number
    HAVING ABS(SUM(jea.debit) - SUM(jea.credit)) > 0.01
     ORDER BY difference DESC
     LIMIT 20
  `;
  // Tolerance 0.01 stays until the zero-tolerance trigger decision (PR-4.6b).
  const total = unbalanced.length > 0 ? Number(unbalanced[0]!.total) : 0;

  return {
    name: 'Unbalanced Journal Entries',
    status: total > 0 ? 'error' : 'ok',
    message: total > 0
      ? `${total} jurnal tidak balance (debit ≠ kredit)`
      : 'Semua jurnal balance',
    count: total,
    details: unbalanced.map((r) => ({
      journal_id: r.journal_id,
      entry_number: r.entry_number,
      total_debit: r.total_debit,
      total_credit: r.total_credit,
      difference: r.difference,
    })),
    fixable: false,
  };
}

/**
 * Stock vs movement mismatch
 * Compare product currentStock against sum of stock movements.
 */
export async function checkStockMovementMismatch(): Promise<CheckResult> {
  const mismatches = await prisma.$queryRaw<Array<{
    item_id: string;
    item_name: string;
    code: string;
    stored_stock: number;
    computed_stock: number;
    difference: number;
  }>>`
    WITH computed AS (
      -- TransferIn/TransferOut are within the same item: at total-stock level
      -- they cancel out (source -qty + destination +qty = 0). The previous
      -- formula classified TransferIn as negative, producing huge false drifts
      -- for any item that has ever been the destination of a transfer.
      SELECT sm.item_id,
             SUM(CASE
                   WHEN sm.movement_type IN ('In', 'AdjustmentIn', 'TransferIn')
                     THEN sm.quantity
                   ELSE -sm.quantity
                 END) AS total_stock
        FROM stock_movements sm
       WHERE sm.is_cancelled = false
       GROUP BY sm.item_id
    )
    SELECT i.id AS item_id,
           i.name AS item_name,
           i.code,
           i.current_stock AS stored_stock,
           COALESCE(c.total_stock, 0) AS computed_stock,
           ABS(i.current_stock - COALESCE(c.total_stock, 0)) AS difference
      FROM inventory_items i
      LEFT JOIN computed c ON c.item_id = i.id
     WHERE ABS(i.current_stock - COALESCE(c.total_stock, 0)) > 0.001
     ORDER BY difference DESC
     LIMIT 20
  `;

  return {
    name: 'Stock vs Movement Mismatch',
    status: mismatches.length > 0 ? 'warning' : 'ok',
    message: mismatches.length > 0
      ? `${mismatches.length} produk memiliki stok tidak sesuai dengan movement`
      : 'Semua stok produk sesuai',
    count: mismatches.length,
    details: mismatches,
    fixable: false,
  };
}

// Per-warehouse stock drift: inventory_items.current_stock (denormalized total)
// should equal SUM(inventory_stocks.current_stock) for that item. A mismatch
// means a multi-warehouse update path skipped the inventory_stocks upsert.
export async function checkWarehouseStockDrift(): Promise<CheckResult> {
  const drifts = await prisma.$queryRaw<Array<{
    item_id: string;
    item_name: string;
    code: string;
    item_total: number;
    warehouse_sum: number;
    difference: number;
  }>>`
    WITH wh_sum AS (
      SELECT item_id, COALESCE(SUM(current_stock), 0) AS total
        FROM inventory_stocks
       GROUP BY item_id
    )
    SELECT i.id AS item_id,
           i.name AS item_name,
           i.code,
           i.current_stock AS item_total,
           COALESCE(w.total, 0) AS warehouse_sum,
           ABS(i.current_stock - COALESCE(w.total, 0)) AS difference
      FROM inventory_items i
      LEFT JOIN wh_sum w ON w.item_id = i.id
     WHERE ABS(i.current_stock - COALESCE(w.total, 0)) > 0.001
     ORDER BY difference DESC
     LIMIT 20
  `;

  return {
    name: 'Drift Stok per Gudang',
    status: drifts.length > 0 ? 'warning' : 'ok',
    message: drifts.length > 0
      ? `${drifts.length} item: total inventory_items ≠ SUM(inventory_stocks per gudang)`
      : 'Total stok per item konsisten dengan saldo per gudang',
    count: drifts.length,
    details: drifts,
    fixable: false,
  };
}
