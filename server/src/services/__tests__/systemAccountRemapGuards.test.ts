// Checks of one system account mapping save before any reclass (E2-R8, PR-4.12 review): a shared
// old account, a swap, a clear with a balance, inventory items on the old account, and the role
// move history every balance-sheet move writes.
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({ prisma: {} }));

import type { BalancePlan, RemapPlan } from '../systemAccountRemap';
import {
  ACCOUNT_SHARED_WITH_ROLE,
  INVENTORY_ACCOUNT_ITEMS,
  REMAP_CHAIN,
  ROLE_CLEAR_HAS_BALANCE,
  assertInventoryItemsFollow,
  assertNoRemapChain,
  planRoleClears,
  recordRoleMoves,
  splitSharedPlans,
} from '../systemAccountRemapGuards';
import { translateMessage } from '../../i18n/translateMessage';

const ref = (id: string) => ({ id, accountNumber: id, name: `Akun ${id}` });
const plan = (role: BalancePlan['role'], from: string, to: string, amount = '0'): BalancePlan => ({
  kind: 'balance', role, from: ref(from), to: ref(to),
  lines: amount === '0' ? [] : [{ partyId: null, amount: new Prisma.Decimal(amount) }],
  net: new Prisma.Decimal(amount),
});
const pnl = (from: string, to: string): RemapPlan => ({ kind: 'pnl', role: 'COGS', from: ref(from), to: ref(to) });

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('splitSharedPlans', () => {
  it('an old account another role keeps after the save is not reclassed', () => {
    const drawing = plan('OWNER_DRAWING', '3.1', '3.4', '-750');
    const out = splitSharedPlans([drawing, pnl('5', '5.1')], [{ role: 'OPENING_EQUITY', accountId: '3.1' }, { role: 'OWNER_DRAWING', accountId: '3.4' }], false);
    expect(out.shared).toEqual([drawing]);
    expect(out.reclass.map((p) => p.kind)).toEqual(['pnl']);
  });

  it('a transfer asked for a shared balance is refused', () => {
    const drawing = plan('OWNER_DRAWING', '3.1', '3.4', '-750');
    expect(() => splitSharedPlans([drawing], [{ role: 'OPENING_EQUITY', accountId: '3.1' }], true)).toThrow(
      'Peran Prive / Penarikan Pemilik: akun lama 3.1 Akun 3.1 juga dipakai peran Ekuitas Saldo Awal, jadi saldonya tidak dapat dipisah per peran dan tidak dipindahkan. Simpan peran ini tanpa memindahkan saldo.',
    );
    expect(codeOf(() => splitSharedPlans([drawing], [{ role: 'OPENING_EQUITY', accountId: '3.1' }], true))).toBe(ACCOUNT_SHARED_WITH_ROLE);
  });

  it('two roles leaving one account with a balance in one save are refused; empty they pass', () => {
    const a = plan('OWNER_DRAWING', '3.1', '3.4', '-750');
    const b = plan('OPENING_EQUITY', '3.1', '3.5', '-750');
    expect(codeOf(() => splitSharedPlans([a, b], [], true))).toBe(ACCOUNT_SHARED_WITH_ROLE);
    const empty = [plan('OWNER_DRAWING', '3.1', '3.4'), plan('OPENING_EQUITY', '3.1', '3.5')];
    expect(splitSharedPlans(empty, [], false).reclass).toHaveLength(2);
  });

  it('an account held by the role alone is reclassed', () => {
    const ar = plan('AR', '1.2.1', '1.2.2', '500');
    expect(splitSharedPlans([ar], [{ role: 'AR', accountId: '1.2.2' }], true)).toEqual({ reclass: [ar], shared: [] });
  });
});

describe('assertNoRemapChain', () => {
  it('refuses a swap of two balance-sheet roles with a balance', () => {
    const swap = [plan('AR', '1.2.1', '1.2.2', '300'), plan('EMPLOYEE_ADVANCE', '1.2.2', '1.2.1', '5')];
    expect(codeOf(() => assertNoRemapChain(swap))).toBe(REMAP_CHAIN);
    expect(() => assertNoRemapChain(swap)).toThrow(
      'Peran Piutang Usaha pindah ke akun 1.2.2 Akun 1.2.2 yang ditinggalkan peran Uang Muka Karyawan dalam simpanan yang sama. Pindahkan satu peran per simpan, lewat akun lain bila perlu.',
    );
  });

  it('passes a swap of empty accounts and unrelated moves', () => {
    expect(() => assertNoRemapChain([plan('AR', '1.2.1', '1.2.2'), plan('EMPLOYEE_ADVANCE', '1.2.2', '1.2.1')])).not.toThrow();
    expect(() => assertNoRemapChain([plan('AR', '1.2.1', '1.2.2', '300'), plan('AP', '2.1.1', '2.1.9', '9')])).not.toThrow();
  });
});

function clearTx(residue: Array<{ amount: string | null }>) {
  return {
    $queryRaw: vi.fn(async () => residue),
    account: { findUnique: async () => ({ accountNumber: '2.1.5', name: 'Hutang Belum Ditagih' }) },
  } as any;
}

describe('planRoleClears', () => {
  const stored = [{ role: 'ACCRUED_PAYABLE', accountId: 'grni' }, { role: 'SALES_DISCOUNT', accountId: 'disc' }];

  it('refuses clearing a balance-sheet role whose account holds a balance', async () => {
    const err = await planRoleClears(clearTx([{ amount: '-40000000.00' }]), ['ACCRUED_PAYABLE'], [], stored, []).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ROLE_CLEAR_HAS_BALANCE });
    expect((err as Error).message).toBe(
      'Peran Hutang Belum Tagih: akun 2.1.5 Hutang Belum Ditagih masih bersaldo -40000000.00. Peran neraca yang akunnya bersaldo tidak dapat dilepas; pindahkan ke akun lain beserta saldonya.',
    );
    expect(translateMessage((err as Error).message, 'en')).toContain('cannot be cleared');
  });

  it('an empty account is cleared and listed for the history; profit and loss roles are not', async () => {
    const tx = clearTx([{ amount: null }]);
    expect(await planRoleClears(tx, ['ACCRUED_PAYABLE', 'SALES_DISCOUNT'], [], stored, [])).toEqual([
      { role: 'ACCRUED_PAYABLE', fromAccountId: 'grni' },
    ]);
  });

  it('an account another role keeps is not checked; a role mapped again in the request is no clear', async () => {
    const tx = clearTx([{ amount: '-1.00' }]);
    expect(await planRoleClears(tx, ['ACCRUED_PAYABLE'], [], stored, [{ role: 'OTHER', accountId: 'grni' }])).toHaveLength(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(await planRoleClears(tx, ['ACCRUED_PAYABLE'], [{ role: 'ACCRUED_PAYABLE', accountId: 'x' }], stored, [])).toEqual([]);
  });
});

describe('assertInventoryItemsFollow', () => {
  it('refuses an INVENTORY reclass while items with stock name the old account', async () => {
    const count = vi.fn(async () => 2);
    const err = await assertInventoryItemsFollow({ inventoryItem: { count } } as any, [plan('INVENTORY', '1.4.0', '1.4.1', '20')]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: INVENTORY_ACCOUNT_ITEMS });
    expect(translateMessage((err as Error).message, 'en')).toContain('Clear the inventory account on those items first');
    expect(count).toHaveBeenCalledWith({
      where: { accountId: '1.4.0', OR: [{ currentStock: { not: 0 } }, { stocks: { some: { currentStock: { not: 0 } } } }] },
    });
  });

  it('passes without such items and ignores other roles', async () => {
    const count = vi.fn(async () => 0);
    await expect(assertInventoryItemsFollow({ inventoryItem: { count } } as any, [plan('INVENTORY', 'a', 'b', '1'), plan('AR', 'c', 'd', '1')])).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledOnce();
  });
});

describe('recordRoleMoves', () => {
  it('writes one row per move and clear with the actor and reason; nothing to write is no call', async () => {
    const createMany = vi.fn(async () => ({ count: 2 }));
    const tx = { systemAccountRoleMove: { createMany } } as any;
    await recordRoleMoves(tx, [], { actorId: 'u1' });
    expect(createMany).not.toHaveBeenCalled();
    await recordRoleMoves(tx, [
      { role: 'AR', fromAccountId: 'a', toAccountId: 'b' },
      { role: 'ACCRUED_PAYABLE', fromAccountId: 'g', toAccountId: null },
    ], { actorId: 'u1', reason: 'pindah akun' });
    const { data } = (createMany.mock.calls[0] as any[])[0];
    expect(data).toEqual([
      expect.objectContaining({ role: 'AR', fromAccountId: 'a', toAccountId: 'b', movedBy: 'u1', reason: 'pindah akun' }),
      expect.objectContaining({ role: 'ACCRUED_PAYABLE', fromAccountId: 'g', toAccountId: null, movedBy: 'u1', reason: 'pindah akun' }),
    ]);
    expect(data[0].movedAt).toBeInstanceOf(Date);
  });
});
