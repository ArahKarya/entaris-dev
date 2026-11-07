import { describe, it, expect } from 'vitest';
import { makeAutoTx } from '../../../__tests__/helpers/autoTx';
import { BusinessError } from '../../../utils/errors';
import { translateMessage } from '../../../i18n/translateMessage';
import { sourceKeys } from '../journalSource';
import {
  ACCOUNT_CONTROL,
  ACCOUNT_GROUP,
  ACCOUNT_INACTIVE,
  ACCOUNT_NOT_FOUND,
  ACCOUNT_ROOT_TYPE,
  CONTROL_ACCOUNT_ROLES,
  DOCUMENT_RULE,
  INVENTORY_ITEM,
  MANUAL_CONTROL_KINDS,
  TEMPLATE_RULE,
  TAX_ACCOUNT_ROLES,
  assertPostableAccount,
  assertPostableAccounts,
  isControlAccount,
  manualCancelRule,
  manualJournalRule,
  postableAccountProblem,
  restrictedKindProblem,
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
    const p = postableAccountProblem(ar, { ...rule, controlHint: 'Gunakan modul Pembayaran.' }, ['AR']);
    expect(p?.code).toBe(ACCOUNT_CONTROL);
    expect(p?.message).toBe(
      'Akun lawan: akun 1.2.1 Piutang Usaha (Dagang) adalah akun kontrol Piutang Usaha dan tidak boleh diposting langsung. Gunakan modul Pembayaran.',
    );
    expect(postableAccountProblem(ar, { ...rule, allowControl: true }, ['AR'])).toBeNull();
    expect(postableAccountProblem(ar, { ...rule, allowControl: ['AR'] }, ['AR'])).toBeNull();
    expect(postableAccountProblem(ar, { ...rule, allowControl: ['AP'] }, ['AR'])?.code).toBe(ACCOUNT_CONTROL);
  });

  it('messages translate to English', () => {
    const p = postableAccountProblem(acc({ accountNumber: '1.4.1', name: 'Persediaan Beras', rootType: 'ASSET' }), rule, [INVENTORY_ITEM]);
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

  it('an account mapped under several roles is postable only when every role is allowed', async () => {
    // 2.1.1 doubles as AP and GRNI; rows come back in either order.
    for (const rows of [
      [{ role: 'AP', accountId: 'ap' }, { role: 'ACCRUED_PAYABLE', accountId: 'ap' }],
      [{ role: 'ACCRUED_PAYABLE', accountId: 'ap' }, { role: 'AP', accountId: 'ap' }],
    ]) {
      const { tx: t } = makeAutoTx({
        'account.findMany': () => [acc({ id: 'ap', accountNumber: '2.1.1', name: 'Hutang Usaha', rootType: 'LIABILITY' })],
        'systemAccountMapping.findMany': () => rows,
      });
      expect(await codeOf(assertPostableAccount(t, 'ap', { ...rule, allowControl: ['ACCRUED_PAYABLE'] }))).toBe(ACCOUNT_CONTROL);
      expect(await codeOf(assertPostableAccount(t, 'ap', { ...rule, allowControl: ['AP'] }))).toBe(ACCOUNT_CONTROL);
      await expect(assertPostableAccount(t, 'ap', { ...rule, allowControl: ['AP', 'ACCRUED_PAYABLE'] })).resolves.toMatchObject({ id: 'ap' });
      expect(await isControlAccount(t, 'ap')).toBe('AP');
    }
  });

  it('a former party-role account keeps its role: AR needs journal.control, a deposit is never manual', async () => {
    const { tx: t } = makeAutoTx({
      'account.findMany': (args: any) =>
        [
          acc({ id: 'old-ar', accountNumber: '1.2.9', name: 'Piutang Lama' }),
          acc({ id: 'old-dep', accountNumber: '2.1.9', name: 'Uang Muka Lama', rootType: 'LIABILITY' }),
        ].filter((a) => args.where.id.in.includes(a.id)),
      'systemAccountMapping.findMany': () => [{ role: 'AR', accountId: 'ar' }, { role: 'CUSTOMER_DEPOSIT', accountId: 'cdep' }],
      'journalEntry.findMany': () => [
        { sourceKey: sourceKeys.remap('AR', 'old-ar', 'ar', '2170-01-31'), createdAt: new Date('2170-01-31') },
        { sourceKey: sourceKeys.remap('CUSTOMER_DEPOSIT', 'old-dep', 'cdep', '2170-01-31'), createdAt: new Date('2170-01-31') },
      ],
    });
    expect(await codeOf(assertPostableAccount(t, 'old-ar', manualJournalRule(false)))).toBe(ACCOUNT_CONTROL);
    await expect(assertPostableAccount(t, 'old-ar', manualJournalRule(true))).resolves.toMatchObject({ id: 'old-ar' });
    expect(await codeOf(assertPostableAccount(t, 'old-dep', manualJournalRule(true)))).toBe(ACCOUNT_CONTROL);
    expect(await codeOf(assertPostableAccount(t, 'old-ar', TEMPLATE_RULE))).toBe(ACCOUNT_CONTROL);
    expect(await isControlAccount(t, 'old-dep')).toBe('CUSTOMER_DEPOSIT');
  });

  it('reports missing and group accounts', async () => {
    const { tx: t } = tx();
    expect(await codeOf(assertPostableAccount(t, 'nope', rule))).toBe(ACCOUNT_NOT_FOUND);
    expect(await codeOf(assertPostableAccount(t, 'grp', rule))).toBe(ACCOUNT_GROUP);
  });
});

describe('named rules', () => {
  const ar = acc({ accountNumber: '1.2.1', name: 'Piutang Usaha (Dagang)', rootType: 'ASSET' });
  const kindsOk = (r: Parameters<typeof postableAccountProblem>[1], kind: Parameters<typeof postableAccountProblem>[2]) =>
    postableAccountProblem(ar, r, kind) === null;

  it('manual journal kinds = every control role except the deposits, plus item inventory and tax', () => {
    const deposits = ['CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'];
    expect([...MANUAL_CONTROL_KINDS].sort()).toEqual(
      [...CONTROL_ACCOUNT_ROLES.filter((r) => !deposits.includes(r)), INVENTORY_ITEM, ...TAX_ACCOUNT_ROLES].sort(),
    );
  });

  it('manualJournalRule(false) refuses control and tax accounts, naming the journal.control right', () => {
    const r = manualJournalRule(false);
    expect(r.alsoRestrict).toEqual(TAX_ACCOUNT_ROLES);
    for (const kind of [...MANUAL_CONTROL_KINDS, 'CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'] as const) expect(kindsOk(r, [kind]), kind).toBe(false);
    expect(postableAccountProblem(ar, r, ['AR'])?.message).toBe(
      'Akun jurnal: akun 1.2.1 Piutang Usaha (Dagang) adalah akun kontrol Piutang Usaha dan tidak boleh diposting langsung. Butuh hak Jurnal ke akun kontrol (journal.control); akun uang muka hanya lewat modul Uang Muka.',
    );
    expect(kindsOk(r, null)).toBe(true);
  });

  it('manualJournalRule(true) allows control and tax accounts but never the deposit accounts', () => {
    const r = manualJournalRule(true);
    for (const kind of MANUAL_CONTROL_KINDS) expect(kindsOk(r, [kind]), kind).toBe(true);
    expect(kindsOk(r, ['CUSTOMER_DEPOSIT'])).toBe(false);
    expect(kindsOk(r, ['VENDOR_DEPOSIT'])).toBe(false);
  });

  it('manualCancelRule: without journal.control every control, deposit and tax kind is refused; with it all may be reversed', () => {
    const all = [...MANUAL_CONTROL_KINDS, 'CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'] as const;
    for (const kind of all) expect(restrictedKindProblem(ar, manualCancelRule(false), [kind])?.code, kind).toBe(ACCOUNT_CONTROL);
    for (const kind of all) expect(restrictedKindProblem(ar, manualCancelRule(true), [kind]), kind).toBeNull();
    expect(manualCancelRule(false).alsoRestrict).toEqual(TAX_ACCOUNT_ROLES);
    expect(restrictedKindProblem(ar, manualCancelRule(false), null)).toBeNull();
    // Only the control part: an inactive or group account does not stop a reversal.
    expect(restrictedKindProblem(acc({ isActive: false, isGroup: true }), manualCancelRule(false), null)).toBeNull();
    expect(translateMessage(restrictedKindProblem(ar, manualCancelRule(false), ['INVENTORY'])!.message, 'en')).toBe(
      'Journal cancel: account 1.2.1 Piutang Usaha (Dagang) is a control account (Inventory) and cannot be posted to directly. Cancelling a journal that holds a control account requires the Journal to control accounts right (journal.control).',
    );
  });

  it('TEMPLATE_RULE refuses every control and tax account', () => {
    for (const kind of [...MANUAL_CONTROL_KINDS, 'CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'] as const) expect(kindsOk(TEMPLATE_RULE, [kind]), kind).toBe(false);
    expect(TEMPLATE_RULE.alsoRestrict).toEqual(TAX_ACCOUNT_ROLES);
  });

  it('DOCUMENT_RULE allows every control account but still needs an active detail account', () => {
    expect(kindsOk(DOCUMENT_RULE, ['AR', 'CUSTOMER_DEPOSIT', 'INVENTORY_ITEM'])).toBe(true);
    expect(postableAccountProblem(acc({ isGroup: true }), DOCUMENT_RULE, null)?.code).toBe(ACCOUNT_GROUP);
    expect(postableAccountProblem(acc({ isActive: false }), DOCUMENT_RULE, null)?.code).toBe(ACCOUNT_INACTIVE);
  });

  it('rule messages translate to English', () => {
    expect(translateMessage(postableAccountProblem(ar, manualJournalRule(false), ['AR'])!.message, 'en')).toBe(
      'Journal account: account 1.2.1 Piutang Usaha (Dagang) is a control account (Accounts Receivable) and cannot be posted to directly. Requires the Journal to control accounts right (journal.control); deposit accounts only through the Deposits module.',
    );
    expect(translateMessage(postableAccountProblem(ar, manualJournalRule(true), ['CUSTOMER_DEPOSIT'])!.message, 'en')).toBe(
      'Journal account: account 1.2.1 Piutang Usaha (Dagang) is a control account (Customer deposit) and cannot be posted to directly. Deposit accounts can only be corrected through the Deposits module.',
    );
    expect(translateMessage(postableAccountProblem(ar, TEMPLATE_RULE, ['TAX_OUTPUT'])!.message, 'en')).toBe(
      'Template account: account 1.2.1 Piutang Usaha (Dagang) is a control account (Output VAT) and cannot be posted to directly. Recurring journal templates cannot use control or tax accounts.',
    );
  });
});
