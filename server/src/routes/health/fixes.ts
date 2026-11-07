// Preview + fix for /api/health-check/preview/:check and /fix/:check. Only the stored-balance
// recalculation is left; every other check is detect-only (E2-R14), corrected by a journal in the
// current period or a repair script.
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { recalculateAccountBalances } from '../../utils/accountBalance';
import { BusinessError } from '../../utils/errors';

export const FIX_DRIFT_CLOSED_YEARS = 'FIX_DRIFT_CLOSED_YEARS';

/**
 * Interim guard until the single stored-balance rule (PR-5.5): the recalculation sums every year,
 * while closing a year subtracts its revenue/expense from accounts.balance, so one click would put
 * closed years back and a later reopen would add them again.
 */
async function assertNoClosedPnlYears(db: Prisma.TransactionClient | typeof prisma): Promise<void> {
  const rows = await db.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one
      FROM accounting_ledger_entries ale
      JOIN fiscal_years fy ON fy.id = ale.fiscal_year_id
      JOIN accounts a ON a.id = ale.account_id
     WHERE fy.is_closed = true
       AND ale.is_cancelled = false
       AND a."rootType" IN ('REVENUE','EXPENSE')
     LIMIT 1
  `;
  if (rows.length > 0) {
    throw new BusinessError(
      'Hitung ulang saldo ditutup sementara: tahun buku tertutup masih mengurangi saldo laba rugi. Tersedia lagi setelah aturan saldo tunggal.',
      FIX_DRIFT_CLOSED_YEARS,
    );
  }
}

export async function previewAccountBalanceDrift(): Promise<{ description: string; count: number; details: unknown[] }> {
  await assertNoClosedPnlYears(prisma);
  const drifts = await prisma.$queryRaw<Array<{
    account_code: string;
    account_name: string;
    root_type: string;
    stored_balance: string;
    computed_balance: string;
    drift: string;
  }>>`
    WITH computed AS (
      SELECT jea.account_id,
             a."rootType" AS root_type,
             CASE
               WHEN a."rootType" IN ('ASSET','EXPENSE')
                 THEN SUM(jea.debit) - SUM(jea.credit)
               ELSE SUM(jea.credit) - SUM(jea.debit)
             END AS computed_balance
        FROM journal_entry_accounts jea
        JOIN journal_entries je ON je.id = jea.journal_entry_id
        JOIN accounts a ON a.id = jea.account_id
       WHERE je.status != 'Cancelled'
       GROUP BY jea.account_id, a."rootType"
    )
    SELECT a."accountNumber" AS account_code,
           a.name AS account_name,
           c.root_type,
           a.balance::text AS stored_balance,
           c.computed_balance::text AS computed_balance,
           ABS(a.balance - c.computed_balance)::text AS drift
      FROM computed c
      JOIN accounts a ON a.id = c.account_id
     WHERE ABS(a.balance - c.computed_balance) > 0.01
     ORDER BY ABS(a.balance - c.computed_balance) DESC
     LIMIT 50
  `;

  return {
    description: drifts.length === 0
      ? 'Tidak ada akun yang drift. Semua saldo sudah sesuai dengan jurnal. Klik "Perbaiki" hanya akan menghitung ulang tanpa mengubah nilai.'
      : `Akan MENGUBAH saldo ${drifts.length} akun berikut agar sesuai dengan hasil hitung dari jurnal:`,
    count: drifts.length,
    details: drifts,
  };
}

/**
 * Fix account balance drift: recalculate all account balances from JournalItems.
 * Captures before/after snapshot of drifted accounts for audit.
 */
export async function fixAccountBalanceDrift(): Promise<{ fixed: number; message: string; snapshot: unknown }> {
  return await prisma.$transaction(async (tx) => {
    await assertNoClosedPnlYears(tx);
    // Capture drifted accounts BEFORE recalculation (rootType-aware formula)
    const beforeDrift = await tx.$queryRaw<Array<{
      account_code: string;
      account_name: string;
      root_type: string;
      stored_balance: string;
      computed_balance: string;
    }>>`
      WITH computed AS (
        SELECT jea.account_id,
               a."rootType" AS root_type,
               CASE
                 WHEN a."rootType" IN ('ASSET','EXPENSE')
                   THEN SUM(jea.debit) - SUM(jea.credit)
                 ELSE SUM(jea.credit) - SUM(jea.debit)
               END AS computed_balance
          FROM journal_entry_accounts jea
          JOIN journal_entries je ON je.id = jea.journal_entry_id
          JOIN accounts a ON a.id = jea.account_id
         WHERE je.status != 'Cancelled'
         GROUP BY jea.account_id, a."rootType"
      )
      SELECT a."accountNumber" AS account_code,
             a.name AS account_name,
             c.root_type,
             a.balance::text AS stored_balance,
             c.computed_balance::text AS computed_balance
        FROM computed c
        JOIN accounts a ON a.id = c.account_id
       WHERE ABS(a.balance - c.computed_balance) > 0.01
       ORDER BY ABS(a.balance - c.computed_balance) DESC
       LIMIT 50
    `;

    await recalculateAccountBalances(tx);
    const count = await tx.account.count();

    return {
      fixed: count,
      message: `Dihitung ulang saldo ${count} akun dari jurnal`,
      snapshot: {
        driftedAccountsBefore: beforeDrift,
        totalDrifted: beforeDrift.length,
        totalAccountsRecalc: count,
      },
    };
  }, { timeout: 60000 });
}
