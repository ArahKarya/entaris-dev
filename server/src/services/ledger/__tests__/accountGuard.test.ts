import { describe, it, expect } from 'vitest';
import { makeAutoTx } from '../../../__tests__/helpers/autoTx';
import { BusinessError } from '../../../utils/errors';
import { translateMessage } from '../../../i18n/translateMessage';
import {
  ACCOUNT_CONTROL,
  ACCOUNT_GROUP,
  ACCOUNT_INACTIVE,
  ACCOUNT_NOT_FOUND,
  ACCOUNT_ROOT_TYPE,
  CONTROL_ACCOUNT_ROLES,
  INVENTORY_ITEM,
  TAX_ACCOUNT_ROLES,
  assertPostableAccount,
  assertPostableAccounts,
  isControlAccount,
  postableAccountProblem,
  type AccountLite,
} from '../accountGuard';

const acc = (over: Partial<AccountLite> = {}): AccountLite => ({
  id: 'a-1', accountNumber: '6.16', name: 'Beban Sewa', rootType: 'EXPENSE', isGroup: false, isActive: true, ...over,
});
const rule = { label: 'Akun lawan' };

describe('control account lists', () => {
  it('holds the subledger roles, without PROJECT_GUARANTEE or tax', () => {
    expect([...CONTROL_ACCOUNT_ROLES].sort()).toEqual(
      ['ACCRUED_PAYABLE', 'AP', 'AR', 'CUSTOMER_DEPOSIT', 'INVENTORY', 'VENDOR_DEPOSIT'],
    );
    expect(CONTROL_ACCOUNT_ROLES).not.toContain('PROJECT_GUARANTEE');
    expect(TAX_ACCOUNT_ROLES).toEqual(['TAX_INPUT', 'TAX_OUTPUT']);
  });
});

describe('postableAccountProblem', () => {
  it('accepts an active detail account', () => {
    expect(postableAccountProblem(acc(), rule, null)).toBeNull();
  });

  it('rejects a missing account', () => {
    expect(postableAccountProblem(null, rule, null)?.code).toBe(ACCOUNT_NOT_FOUND);
  });

  it('rejects a group account, before the inactive check', () => {
    const p = postableAccountProblem(acc({ isGroup: true, isActive: false }), rule, null);
    expect(p?.code).toBe(ACCOUNT_GROUP);
    expect(p?.message).toMatch(/akun grup/);
  });

  it('rejects an inactive account', () => {
    const p = postableAccountProblem(acc({ isActive: false }), rule, null);
    expect(p?.code).toBe(ACCOUNT_INACTIVE);
    expect(p?.message).toMatch(/tidak aktif/);
  });

  it('rejects a root type outside the rule', () => {
    const p = postableAccountProblem(acc(), { ...rule, rootTypes: ['REVENUE'] }, null);
    expect(p).toEqual({
      code: ACCOUNT_ROOT_TYPE,
      message: 'Akun lawan: akun 6.16 Beban Sewa bertipe EXPENSE, seharusnya REVENUE.',
    });
  });

  it('rejects a control account unless allowed', () => {
    const ar = acc({ accountNumber: '1.2.1', name: 'Piutang Usaha (Dagang)', rootType: 'ASSET' });
    const p = postableAccountProblem(ar, { ...rule, controlHint: 'Gunakan modul Pembayaran.' }, 'AR');
    expect(p?.code).toBe(ACCOUNT_CONTROL);
    expect(p?.message).toBe(
      'Akun lawan: akun 1.2.1 Piutang Usaha (Dagang) adalah akun kontrol Piutang Usaha dan tidak boleh diposting langsung. Gunakan modul Pembayaran.',
    );
    expect(postableAccountProblem(ar, { ...rule, allowControl: true }, 'AR')).toBeNull();
    expect(postableAccountProblem(ar, { ...rule, allowControl: ['AR'] }, 'AR')).toBeNull();
    expect(postableAccountProblem(ar, { ...rule, allowControl: ['AP'] }, 'AR')?.code).toBe(ACCOUNT_CONTROL);
  });

  it('messages translate to English', () => {
    const p = postableAccountProblem(acc({ accountNumber: '1.4.1', name: 'Persediaan Beras', rootType: 'ASSET' }), rule, INVENTORY_ITEM);
    expect(translateMessage(p!.message, 'en')).toBe(
      'Akun lawan: account 1.4.1 Persediaan Beras is a control account (item inventory) and cannot be posted to directly.',
    );
  });
});

const ACCOUNTS: Record<string, AccountLite> = {
  exp: acc({ id: 'exp' }),
  ar: acc({ id: 'ar', accountNumber: '1.2.1', name: 'Piutang', rootType: 'ASSET' }),
  item: acc({ id: 'item', accountNumber: '1.4.1', name: 'Persediaan Beras', rootType: 'ASSET' }),
  ppn: acc({ id: 'ppn', accountNumber: '2.1.3', name: 'PPN Keluaran', rootType: 'LIABILITY' }),
  grp: acc({ id: 'grp', accountNumber: '6', name: 'Beban', isGroup: true }),
};

function tx() {
  return makeAutoTx({
    'account.findMany': (args: any) => args.where.id.in.map((id: string) => ACCOUNTS[id]).filter(Boolean),
    'systemAccountMapping.findMany': (args: any) =>
      [{ role: 'AR', accountId: 'ar' }, { role: 'TAX_OUTPUT', accountId: 'ppn' }].filter((m) => args.where.role.in.includes(m.role)),
    'inventoryItem.findMany': () => [{ accountId: 'item' }, { accountId: 'ar' }],
  });
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return undefined;
}

describe('assertPostableAccounts', () => {
  it('returns the accounts when all are postable', async () => {
    const { tx: t } = tx();
    const map = await assertPostableAccounts(t, ['exp', 'exp', 'ppn'], rule);
    expect([...map.keys()].sort()).toEqual(['exp', 'ppn']);
  });

  it('reads the control map through tx: role and item inventory accounts', async () => {
    const { tx: t, fn } = tx();
    expect(await codeOf(assertPostableAccounts(t, ['exp', 'ar'], rule))).toBe(ACCOUNT_CONTROL);
    expect(await codeOf(assertPostableAccount(t, 'item', rule))).toBe(ACCOUNT_CONTROL);
    expect(fn('inventoryItem.findMany')).toHaveBeenCalledWith({
      where: { accountId: { not: null }, account: { rootType: 'ASSET' } },
      select: { accountId: true },
      distinct: ['accountId'],
    });
  });

  it('a role mapping wins over the item-account kind', async () => {
    const { tx: t } = tx();
    expect(await isControlAccount(t, 'ar')).toBe('AR');
    expect(await isControlAccount(t, 'item')).toBe(INVENTORY_ITEM);
    expect(await isControlAccount(t, 'exp')).toBeNull();
  });

  it('restricts tax accounts only when the rule opts in', async () => {
    const { tx: t } = tx();
    expect(await codeOf(assertPostableAccount(t, 'ppn', { ...rule, alsoRestrict: TAX_ACCOUNT_ROLES }))).toBe(ACCOUNT_CONTROL);
    await expect(assertPostableAccount(t, 'ppn', rule)).resolves.toMatchObject({ id: 'ppn' });
  });

  it('skips the control map when every control account is allowed', async () => {
    const { tx: t, fn } = tx();
    await assertPostableAccount(t, 'ar', { ...rule, allowControl: true });
    expect(fn('systemAccountMapping.findMany')).not.toHaveBeenCalled();
  });

  it('reports missing and group accounts', async () => {
    const { tx: t } = tx();
    expect(await codeOf(assertPostableAccount(t, 'nope', rule))).toBe(ACCOUNT_NOT_FOUND);
    expect(await codeOf(assertPostableAccount(t, 'grp', rule))).toBe(ACCOUNT_GROUP);
  });
});
