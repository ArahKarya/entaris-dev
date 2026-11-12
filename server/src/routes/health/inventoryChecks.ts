// Inventory checks for /api/health-check (step 6). Detection only.
// Inventory Variance account (owner decision #2): manual stock out without an offset, and later the
// stock count and the drift repair, post shrinkage to the INVENTORY_VARIANCE role. Those postings
// are refused while the role is unmapped, mapped to a group, or shares its account with
// ROUNDING_ACCOUNT (services/inventory/varianceAccount.ts); this check shows it before a posting does.
import { prisma } from '../../lib/prisma';
import { inspectVarianceAccount } from '../../services/inventory/varianceAccount';
import type { CheckResult } from './checks';

const VARIANCE_MESSAGES = {
  missing: 'Akun Selisih Persediaan belum dipetakan; mutasi stok keluar tanpa akun lawan ditolak',
  group: 'Akun Selisih Persediaan dipetakan ke akun grup; mutasi stok keluar tanpa akun lawan ditolak',
  shared: 'Akun Selisih Persediaan sama dengan akun Pembulatan; mutasi stok keluar tanpa akun lawan ditolak',
} as const;

export async function checkInventoryVarianceAccount(): Promise<CheckResult> {
  const state = await inspectVarianceAccount(prisma);
  const name = 'Inventory Variance Account';
  if (state.status === 'ok') {
    return { name, status: 'ok', message: 'Akun Selisih Persediaan adalah akun rinci tersendiri', count: 0, fixable: false };
  }
  return {
    name,
    status: 'warning',
    message: VARIANCE_MESSAGES[state.status],
    count: 1,
    details: state.status === 'missing' ? [] : [{ account: `${state.account.accountNumber} ${state.account.name}`, problem: state.status }],
    fixable: false,
  };
}
