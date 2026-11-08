// Preview + fix for /api/health-check/preview/:check and /fix/:check. Only the stored-balance
// recalculation is left; every other check is detect-only (E2-R14), corrected by a journal in the
// current period or a repair script. Both sides use services/ledger/storedBalances.ts: the stored
// balance is set to the sum of the account's active ledger rows over every year, and only the
// accounts that differ are written. Ledger rows are never touched.
//
// The button writes only differences that closes and reopens explain (`closed-year`). Any other
// difference (`unexplained`, which includes every balance-sheet drift) is not overwritten without
// the accountant's review (owner decision #4): while one exists the fix is refused and the
// recalculation goes through scripts/repair/e2-stored-balance-recalc.ts --include-unexplained.
import { prisma } from '../../lib/prisma';
import {
  planStoredBalanceRecalc,
  recalculateAccountBalances,
  type StoredBalancePlanRow,
} from '../../services/ledger/storedBalances';
import { BusinessError } from '../../utils/errors';
import { driftDetail } from './checks';

/** Rows the preview lists; `count` is every drifting account. */
const PREVIEW_LIMIT = 50;

export const FIX_ACTION = 'FIX_ACCOUNT_BALANCE_DRIFT';
export const STORED_BALANCE_REVIEW_REQUIRED = 'STORED_BALANCE_REVIEW_REQUIRED';

const reviewRequired = (n: number) => new BusinessError(
  `Perbaiki ditolak: ${n} akun berselisih tanpa penjelasan tutup/buka tahun buku dan perlu ditinjau akuntan lewat skrip e2-stored-balance-recalc`,
  STORED_BALANCE_REVIEW_REQUIRED,
);

/** Drifting rows of the plan, largest difference first. */
function drifting(rows: readonly StoredBalancePlanRow[]): StoredBalancePlanRow[] {
  return rows
    .filter((r) => r.class !== 'ok')
    .sort((x, y) => y.difference.abs().comparedTo(x.difference.abs()) || x.accountNumber.localeCompare(y.accountNumber));
}

export async function previewAccountBalanceDrift(): Promise<{ description: string; count: number; details: unknown[] }> {
  const rows = drifting((await planStoredBalanceRecalc(prisma)).rows);
  const held = rows.filter((r) => r.class === 'unexplained').length;
  return {
    description: rows.length === 0
      ? 'Tidak ada akun yang selisih. Semua saldo tersimpan sudah sama dengan buku besar; "Perbaiki" tidak mengubah apa pun.'
      : held > 0
        ? `"Perbaiki" ditolak: ${held} dari ${rows.length} akun berikut berselisih tanpa penjelasan tutup/buka tahun buku (kelas unexplained) dan perlu ditinjau akuntan lewat skrip e2-stored-balance-recalc. Tidak ada yang diubah dari halaman ini.`
        : `Akan MENGUBAH saldo tersimpan ${rows.length} akun berikut agar sama dengan buku besar (baris buku besar tidak berubah):`,
    count: rows.length,
    details: rows.slice(0, PREVIEW_LIMIT).map((r) => ({ ...driftDetail(r), class: r.class, explanation: r.explanation })),
  };
}

export interface FixAuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  startedAt: Date;
}

/**
 * Sets every drifting account's stored balance to the ledger sum when all differences are
 * `closed-year`; refuses (STORED_BALANCE_REVIEW_REQUIRED) when any is `unexplained`. The account
 * rows are locked before the plan is read, so what is classified is what gets written. The audit
 * row (each changed account before and after) is written in the same transaction.
 */
export async function fixAccountBalanceDrift(audit: FixAuditContext): Promise<{ fixed: number; message: string }> {
  return await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM accounts ORDER BY id FOR UPDATE`;
    const rows = drifting((await planStoredBalanceRecalc(tx)).rows);
    const held = rows.filter((r) => r.class === 'unexplained').length;
    if (held > 0) throw reviewRequired(held);

    const ids = rows.map((r) => r.accountId);
    const { changed } = ids.length > 0 ? await recalculateAccountBalances(tx, ids) : { changed: [] };
    const planOf = new Map(rows.map((r) => [r.accountId, r]));
    const message = `Saldo tersimpan ${changed.length} akun diisi ulang dari buku besar`;
    if (audit.userId) {
      await tx.auditLog.create({
        data: {
          userId: audit.userId,
          action: FIX_ACTION,
          entityType: 'health-check',
          entityId: 'account-balance-drift',
          newValues: {
            check: 'account-balance-drift',
            fixed: changed.length,
            message,
            snapshot: {
              changed: changed.map((c) => ({
                account_code: c.accountNumber,
                account_name: c.name,
                root_type: c.rootType,
                before: c.stored.toFixed(2),
                after: c.fromLedger.toFixed(2),
                closed_year_contribution: c.closedYearContribution.toFixed(2),
                explanation: planOf.get(c.accountId)?.explanation ?? null,
              })),
              totalChanged: changed.length,
            },
            startedAt: audit.startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
          },
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent,
        },
      });
    }
    return { fixed: changed.length, message };
  }, { timeout: 60000 });
}
