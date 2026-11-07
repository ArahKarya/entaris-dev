// Party outstanding check for /api/health-check (E7-R13, E2-R14): the outstanding amount stored on
// each real party against the amount recalcPartyOutstanding would compute (services/
// partyOutstandingDrift.ts). The ledger side per Customer is the AR checks' (arChecks.ts). Detection
// only; the stored column is rewritten by the party recalculation, not from here.
import { prisma } from '../../lib/prisma';
import { computePartyOutstandingDrift } from '../../services/partyOutstandingDrift';
import { rowsOrAmbiguous } from './arChecks';
import type { CheckResult } from './checks';

const DETAIL_LIMIT = 20;

export async function checkPartyOutstandingDrift(scope: { partyIds?: readonly string[] } = {}): Promise<CheckResult> {
  // The manual journal part reads the AR and AP role accounts: an ambiguous mapping is this check's
  // error, not the whole health check's.
  const all = await rowsOrAmbiguous('Party Outstanding Drift', () => computePartyOutstandingDrift(prisma, scope));
  if (!Array.isArray(all)) return all;
  const rows = all.filter((r) => Number(r.storedMinusExpected) !== 0);
  return {
    name: 'Party Outstanding Drift',
    status: rows.length > 0 ? 'warning' : 'ok',
    message: rows.length > 0
      ? `${rows.length} mitra: sisa saldo tersimpan berbeda dengan hitungan saldo awal + invoice + jurnal manual`
      : 'Sisa saldo tersimpan semua mitra sama dengan hitungannya',
    count: rows.length,
    details: rows.slice(0, DETAIL_LIMIT).map((r) => ({
      party_name: r.name,
      party_type: r.partyType,
      stored: Number(r.stored),
      expected: Number(r.expected),
      difference: Number(r.storedMinusExpected),
    })),
    fixable: false,
  };
}
