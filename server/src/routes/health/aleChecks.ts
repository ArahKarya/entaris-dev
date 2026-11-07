// Ledger row checks for /api/health-check (E2-R14): journal lines vs ledger rows per journal over
// the whole book with a cause (services/ledger/aleSyncCheck.ts), ledger rows whose source record is
// gone, and ledger rows booked to a document instead of a journal (services/ledger/nonJournalAle.ts).
// Detection only: corrections go through a journal in the current period or a repair script. Each
// check takes an optional scope so a test can look at its own fixture.
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { businessDayOf } from '../../utils/businessDate';
import { findAleJournalMismatches, type AleMismatchScope } from '../../services/ledger/aleSyncCheck';
import { findNonJournalAle, type NonJournalAleScope } from '../../services/ledger/nonJournalAle';
import type { CheckResult } from './checks';

const DETAIL_LIMIT = 20;

/**
 * ok without findings. warning when every finding is a legacy cancel pair in an open year: the old
 * STT cancel posted a "-CXL" journal and left the original's ledger rows active, the totals are
 * right and the legacy STT data script (PR-6b) moves them to the void model. error otherwise, and
 * for any finding in a closed year.
 */
export async function checkAleSync(scope: AleMismatchScope = {}): Promise<CheckResult> {
  const { total, closedTotal, byCause, rows } = await findAleJournalMismatches(prisma, scope, { limit: DETAIL_LIMIT });
  const onlyLegacyPairs = total > 0 && closedTotal === 0 && byCause['legacy-stt-pair'] === total;
  return {
    name: 'ALE vs JournalItem Sync',
    status: total === 0 ? 'ok' : onlyLegacyPairs ? 'warning' : 'error',
    message: total === 0
      ? 'Baris Buku Besar setiap jurnal sama dengan baris jurnalnya'
      : onlyLegacyPairs
        ? `${total} jurnal STT dibatalkan dengan cara lama (jurnal -CXL); menunggu skrip data STT lama`
        : `${total} jurnal: baris Buku Besar berbeda dengan baris jurnalnya`,
    count: total,
    details: rows.map((r) => ({
      journal_number: r.entryNumber ?? r.journalId,
      date: r.date ? businessDayOf(r.date) : null,
      status: r.status,
      cause: r.cause,
      difference: r.difference.toNumber(),
      fiscal_year: r.fiscalYearName,
      closed_year: r.yearClosed,
    })),
    fixable: false,
  };
}

interface OrphanRow {
  ale_id: string;
  reference_type: string;
  reference_id: string;
  account_code: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  fiscal_year: string;
  closed_year: boolean;
  total: bigint;
}

/** Active ledger rows whose journal, stock movement or stock opname no longer exists. */
export async function checkOrphanAle(scope: { referenceIds?: readonly string[] } = {}): Promise<CheckResult> {
  if (scope.referenceIds && scope.referenceIds.length === 0) {
    return { name: 'Orphan ALE Entries', status: 'ok', message: 'Tidak ada ALE orphan', count: 0, details: [], fixable: false };
  }
  const ids = scope.referenceIds ? Prisma.sql`AND ale.reference_id IN (${Prisma.join([...scope.referenceIds])})` : Prisma.empty;
  const orphans = await prisma.$queryRaw<OrphanRow[]>`
    SELECT ale.id AS ale_id,
           ale.reference_type,
           ale.reference_id,
           a."accountNumber" AS account_code,
           ale.debit,
           ale.credit,
           fy.name AS fiscal_year,
           fy.is_closed AS closed_year,
           COUNT(*) OVER () AS total
      FROM accounting_ledger_entries ale
      JOIN accounts a ON a.id = ale.account_id
      JOIN fiscal_years fy ON fy.id = ale.fiscal_year_id
     WHERE ale.is_cancelled = false ${ids}
       AND (
         (ale.reference_type = 'JournalEntry'
           AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = ale.reference_id))
         OR
         (ale.reference_type = 'StockMovement'
           AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.id = ale.reference_id))
         OR
         (ale.reference_type = 'StockOpname'
           AND NOT EXISTS (SELECT 1 FROM stock_opnames so WHERE so.id = ale.reference_id))
       )
     ORDER BY ale.reference_type, ale.reference_id, ale.id
     LIMIT ${DETAIL_LIMIT}
  `;
  const total = orphans.length > 0 ? Number(orphans[0]!.total) : 0;

  return {
    name: 'Orphan ALE Entries',
    status: total > 0 ? 'warning' : 'ok',
    message: total > 0
      ? `${total} entri ALE merujuk ke record yang tidak ada`
      : 'Tidak ada ALE orphan',
    count: total,
    details: orphans.map((o) => ({
      ale_id: o.ale_id,
      reference_type: o.reference_type,
      reference_id: o.reference_id,
      account_code: o.account_code,
      debit: Number(o.debit),
      credit: Number(o.credit),
      fiscal_year: o.fiscal_year,
      closed_year: o.closed_year,
    })),
    // No fix: open-year orphans go through the repair script, closed years are reported (decision #6).
    fixable: false,
  };
}

/**
 * Ledger rows booked to a document instead of a journal, summed per reference type. A warning: the
 * per-document list is the ledger audit's (section nonJournalAle), and a document also booked
 * through a journal blocks the year close (non-journal-ale-duplicate).
 */
export async function checkNonJournalAle(scope: Omit<NonJournalAleScope, 'limit' | 'duplicatesOnly'> = {}): Promise<CheckResult> {
  const { total, duplicateTotal, byType } = await findNonJournalAle(prisma, { ...scope, limit: 1 });
  return {
    name: 'Non-Journal Ledger Entries',
    status: total > 0 ? 'warning' : 'ok',
    message: total > 0
      ? `${total} dokumen punya baris Buku Besar di luar jurnal; ${duplicateTotal} di antaranya juga tercatat lewat jurnal (ganda)`
      : 'Semua baris Buku Besar tercatat lewat jurnal',
    count: total,
    details: byType.map((t) => ({
      reference_type: t.referenceType,
      documents: t.documents,
      entries: t.rows,
      debit: t.debit.toNumber(),
      duplicated_documents: t.duplicates,
    })),
    fixable: false,
  };
}
