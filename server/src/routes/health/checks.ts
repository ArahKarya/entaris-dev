// Diagnostic checks for /api/health-check. Each returns a CheckResult with
// (name, status, message, count, details, fixable). Lifted out of the main
// route file to keep that under the 800-line target. Ledger row checks are in
// aleChecks.ts, party checks in partyChecks.ts.
import { prisma } from '../../lib/prisma';

export interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  count: number;
  details?: unknown[];
  fixable: boolean;
}

/**
 * Account balance drift
 * Compare accounts.balance against computed balance from JournalItems.
 */
export async function checkAccountBalanceDrift(): Promise<CheckResult> {
  const drifts = await prisma.$queryRaw<Array<{
    account_id: string;
    account_code: string;
    account_name: string;
    root_type: string;
    stored_balance: number;
    computed_balance: number;
    drift: number;
  }>>`
    WITH computed AS (
      SELECT jea.account_id,
             a."rootType" AS root_type,
             CASE
               WHEN a."rootType" IN ('ASSET', 'EXPENSE')
                 THEN SUM(jea.debit) - SUM(jea.credit)
               ELSE SUM(jea.credit) - SUM(jea.debit)
             END AS computed_balance
        FROM journal_entry_accounts jea
        JOIN journal_entries je ON je.id = jea.journal_entry_id
        JOIN accounts a ON a.id = jea.account_id
       WHERE je.status != 'Cancelled'
       GROUP BY jea.account_id, a."rootType"
    )
    SELECT c.account_id,
           a."accountNumber" AS account_code,
           a.name AS account_name,
           c.root_type,
           a.balance AS stored_balance,
           c.computed_balance,
           ABS(a.balance - c.computed_balance) AS drift
      FROM computed c
      JOIN accounts a ON a.id = c.account_id
     WHERE ABS(a.balance - c.computed_balance) > 0.01
     ORDER BY ABS(a.balance - c.computed_balance) DESC
     LIMIT 20
  `;

  return {
    name: 'Account Balance Drift',
    status: drifts.length > 0 ? 'warning' : 'ok',
    message: drifts.length > 0
      ? `${drifts.length} akun memiliki saldo yang tidak sesuai dengan jurnal`
      : 'Semua saldo akun sesuai',
    count: drifts.length,
    details: drifts,
    fixable: true,
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
