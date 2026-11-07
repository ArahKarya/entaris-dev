// Former role account check for /api/health-check (E2-R8): old accounts of balance-sheet system
// account roles that still hold a balance after a remap, typically because a document dated
// before the remap was voided on the old account. Detection only: the balance is moved by the
// sweep (POST /api/system-accounts/:role/sweep), through the same reclass journal as a remap.
import { prisma } from '../../lib/prisma';
import { findFormerResidues } from '../../services/systemAccountRemap';
import type { CheckResult } from './checks';

export async function checkFormerRoleAccounts(): Promise<CheckResult> {
  const rows = await findFormerResidues(prisma);
  return {
    name: 'Former Role Accounts',
    status: rows.length === 0 ? 'ok' : 'warning',
    message: rows.length > 0
      ? `${rows.length} akun bekas peran akun sistem masih bersaldo; pindahkan sisanya lewat Pengaturan > Akun Sistem`
      : 'Akun bekas peran akun sistem tidak bersaldo',
    count: rows.length,
    details: rows.map((r) => ({
      role: r.role,
      former_account: r.fromAccount,
      current_account: r.sweepable ? r.toAccount : null,
      amount: r.amount,
      parties: r.partyCount,
    })),
    fixable: false,
  };
}
