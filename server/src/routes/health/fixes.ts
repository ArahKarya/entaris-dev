// Preview + fix for /api/health-check/preview/:check and /fix/:check. Only the stored-balance
// recalculation is left; every other check is detect-only (E2-R14), corrected by a journal in the
// current period or a repair script. Both sides use services/ledger/storedBalances.ts: the stored
// balance is set to the sum of the account's active ledger rows over every year, and only the
// accounts that differ are written. Ledger rows are never touched.
import { prisma } from '../../lib/prisma';
import { findAccountBalanceDrift, recalculateAccountBalances } from '../../services/ledger/storedBalances';
import { driftDetail } from './checks';

/** Rows the preview lists; `count` is every drifting account. */
const PREVIEW_LIMIT = 50;

export async function previewAccountBalanceDrift(): Promise<{ description: string; count: number; details: unknown[] }> {
  const { total, rows } = await findAccountBalanceDrift(prisma, { limit: PREVIEW_LIMIT });
  return {
    description: total === 0
      ? 'Tidak ada akun yang selisih. Semua saldo tersimpan sudah sama dengan buku besar; "Perbaiki" tidak mengubah apa pun.'
      : `Akan MENGUBAH saldo tersimpan ${total} akun berikut agar sama dengan buku besar (baris buku besar tidak berubah):`,
    count: total,
    details: rows.map(driftDetail),
  };
}

/**
 * Sets every drifting account's stored balance to the ledger sum. The snapshot lists each changed
 * account with its stored balance before and after, for the audit row.
 */
export async function fixAccountBalanceDrift(): Promise<{ fixed: number; message: string; snapshot: unknown }> {
  return await prisma.$transaction(async (tx) => {
    const { changed } = await recalculateAccountBalances(tx);
    return {
      fixed: changed.length,
      message: `Saldo tersimpan ${changed.length} akun diisi ulang dari buku besar`,
      snapshot: {
        changed: changed.map((c) => ({
          account_code: c.accountNumber,
          account_name: c.name,
          root_type: c.rootType,
          before: c.stored.toFixed(2),
          after: c.fromLedger.toFixed(2),
          closed_year_contribution: c.closedYearContribution.toFixed(2),
        })),
        totalChanged: changed.length,
      },
    };
  }, { timeout: 60000 });
}
