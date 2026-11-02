// Fiscal year check for /api/health-check (E2-R5): ledger rows of a journal booked to a year other
// than the one holding their date (services/ledger/aleFiscalYearCheck.ts). Detection only: moving
// rows between years is decided by the accountant, and a closed year cannot be changed here.
import { prisma } from '../../lib/prisma';
import { findAleFiscalYearMismatches } from '../../services/ledger/aleFiscalYearCheck';
import type { CheckResult } from './checks';

const DETAIL_LIMIT = 20;

export async function checkAleFiscalYear(): Promise<CheckResult> {
  const { total, closedTotal, rows } = await findAleFiscalYearMismatches(prisma, { limit: DETAIL_LIMIT });
  return {
    name: 'ALE vs Fiscal Year',
    status: total === 0 ? 'ok' : closedTotal > 0 ? 'error' : 'warning',
    message: total > 0
      ? `${total} jurnal: entri Buku Besar tercatat di Tahun Buku yang berbeda dengan tanggal jurnalnya`
      : 'Entri Buku Besar semua jurnal tercatat di Tahun Buku sesuai tanggalnya',
    count: total,
    details: rows.map((r) => ({
      journal_number: r.entryNumber ?? r.journalId,
      date: r.day,
      entries: r.aleCount,
      amount: r.debit.toNumber(),
      stored_year: r.storedYear,
      expected_year: r.expectedYear,
      closed_year: r.storedYearClosed || r.expectedYearClosed === true,
    })),
    fixable: false,
  };
}
