// Status mapping of the "Former Role Accounts" health check (E2-R8): a warning per former account of
// a balance-sheet role that still holds a balance, ok otherwise; never fixable from the dashboard.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const find = vi.hoisted(() => vi.fn());
vi.mock('../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../services/systemAccountRemap', () => ({ findFormerResidues: find }));

import { checkFormerRoleAccounts } from '../health/formerRoleAccountChecks';

beforeEach(() => find.mockReset());

describe('checkFormerRoleAccounts', () => {
  it('is ok when no former account holds a balance', async () => {
    find.mockResolvedValue([]);
    expect(await checkFormerRoleAccounts()).toMatchObject({ name: 'Former Role Accounts', status: 'ok', count: 0, fixable: false });
  });

  it('warns with one detail row per former account', async () => {
    find.mockResolvedValue([
      { role: 'AR', roleLabel: 'Piutang Usaha', fromAccountId: 'a', fromAccount: '1.2.1 Piutang', toAccountId: 'b', toAccount: '1.2.2 Piutang Baru', amount: '-3000000.00', partyCount: 1, sweepable: true },
      { role: 'INVENTORY', roleLabel: 'Persediaan', fromAccountId: 'c', fromAccount: '1.4.0 Persediaan', toAccountId: 'd', toAccount: '1.4.1 X', amount: '10.00', partyCount: 0, sweepable: false },
    ]);
    const res = await checkFormerRoleAccounts();
    expect(res).toMatchObject({ status: 'warning', count: 2, fixable: false });
    expect(res.message).toContain('2 akun bekas');
    expect(res.details).toEqual([
      { role: 'AR', former_account: '1.2.1 Piutang', current_account: '1.2.2 Piutang Baru', amount: '-3000000.00', parties: 1 },
      { role: 'INVENTORY', former_account: '1.4.0 Persediaan', current_account: null, amount: '10.00', parties: 0 },
    ]);
  });
});
