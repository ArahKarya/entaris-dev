import { describe, it, expect } from 'vitest';
import type { PartyType } from '@prisma/client';
import { makeAutoTx } from '../../../__tests__/helpers/autoTx';
import { BusinessError } from '../../../utils/errors';
import { translateMessage } from '../../../i18n/translateMessage';
import {
  ACCOUNT_CONTROL,
  assertPostableAccount,
  manualJournalRule,
  postableAccountProblem,
  type AccountLite,
} from '../accountGuard';
import {
  PARTY_ROLES,
  PARTY_TYPE_OF_ROLE,
  loadPartyRoleMap,
  loadPartyTypes,
  partyLineProblem,
  roleAccountIds,
  type PartyRole,
  type PartyRule,
} from '../partyRules';
import { sourceKeys } from '../journalSource';

const line = (partyId: string | null, partyType?: PartyType | null) => ({ partyId, partyType });
const codeOf = (partyId: string | null, partyType: PartyType | null | undefined, role: PartyRole | undefined, rule: PartyRule) =>
  partyLineProblem(line(partyId, partyType), role, rule)?.code ?? null;

describe('partyLineProblem', () => {
  it('strict: Dr 6.16 (no party role) with a party is refused', () => {
    const p = partyLineProblem(line('p-1', 'Supplier'), undefined, 'strict');
    expect(p).toEqual({
      code: 'PARTY_NOT_ALLOWED',
      message: 'Pihak hanya boleh diisi di baris akun Piutang Usaha, Hutang Usaha, atau Uang Muka; kosongkan pihak di baris ini.',
    });
  });

  it('strict: a receivable line without a party is refused', () => {
    expect(partyLineProblem(line(null), 'AR', 'strict')).toEqual({
      code: 'PARTY_REQUIRED',
      message: 'Baris ke akun Piutang Usaha wajib memilih Customer.',
    });
    expect(codeOf(null, null, 'VENDOR_DEPOSIT', 'strict')).toBe('PARTY_REQUIRED');
  });

  it('strict: matching party types pass, any other account without a party passes', () => {
    expect(codeOf('c', 'Customer', 'AR', 'strict')).toBeNull();
    expect(codeOf('c', 'Customer', 'CUSTOMER_DEPOSIT', 'strict')).toBeNull();
    expect(codeOf('s', 'Supplier', 'AP', 'strict')).toBeNull();
    expect(codeOf('s', 'Supplier', 'VENDOR_DEPOSIT', 'strict')).toBeNull();
    expect(codeOf(null, null, undefined, 'strict')).toBeNull();
  });

  it('allowedOnly: a receivable line without a party passes, a party off a party-role account does not', () => {
    expect(codeOf(null, null, 'AR', 'allowedOnly')).toBeNull();
    expect(codeOf('p', 'Customer', undefined, 'allowedOnly')).toBe('PARTY_NOT_ALLOWED');
  });

  it('off: nothing is checked', () => {
    expect(codeOf('p', 'Supplier', undefined, 'off')).toBeNull();
    expect(codeOf(null, null, 'AR', 'off')).toBeNull();
    expect(codeOf('p', 'Supplier', 'AR', 'off')).toBeNull();
  });

  it('a receivable line with a Supplier or Both party is a type mismatch under strict', () => {
    expect(partyLineProblem(line('s', 'Supplier'), 'AR', 'strict')).toEqual({
      code: 'PARTY_TYPE_MISMATCH',
      message: 'Akun Piutang Usaha hanya menerima Customer; pihak yang dipilih bertipe Supplier.',
    });
    expect(codeOf('b', 'Both', 'AR', 'strict')).toBe('PARTY_TYPE_MISMATCH');
    expect(codeOf('c', 'Customer', 'AP', 'strict')).toBe('PARTY_TYPE_MISMATCH');
    expect(codeOf('c', 'Customer', 'VENDOR_DEPOSIT', 'strict')).toBe('PARTY_TYPE_MISMATCH');
  });

  it('allowedOnly: Both is accepted (documents), the wrong single type is not', () => {
    expect(codeOf('b', 'Both', 'AP', 'allowedOnly')).toBeNull();
    expect(codeOf('c', 'Customer', 'AP', 'allowedOnly')).toBe('PARTY_TYPE_MISMATCH');
  });

  it('a partyId without a known party type is PARTY_NOT_FOUND', () => {
    expect(codeOf('ghost', undefined, 'AR', 'strict')).toBe('PARTY_NOT_FOUND');
    expect(codeOf('ghost', null, 'AP', 'allowedOnly')).toBe('PARTY_NOT_FOUND');
  });

  it('each role maps to one party type', () => {
    expect(PARTY_ROLES.map((r) => PARTY_TYPE_OF_ROLE[r])).toEqual(['Customer', 'Supplier', 'Customer', 'Supplier']);
  });

  it('messages translate to English', () => {
    expect(translateMessage(partyLineProblem(line(null), 'AP', 'strict')!.message, 'en')).toBe(
      'A line to the Accounts Payable account needs a Supplier.',
    );
    expect(translateMessage(partyLineProblem(line('s', 'Supplier'), 'CUSTOMER_DEPOSIT', 'strict')!.message, 'en')).toBe(
      'The Customer deposit account only accepts a Customer; the selected party is of type Supplier.',
    );
    expect(translateMessage(partyLineProblem(line('b', 'Both'), 'AR', 'strict')!.message, 'en')).toBe(
      'The Accounts Receivable account only accepts a Customer; a partner registered as both Customer and Supplier cannot be used in a manual journal yet.',
    );
    expect(translateMessage(partyLineProblem(line('p', 'Customer'), undefined, 'strict')!.message, 'en')).toBe(
      'A party can only be set on an Accounts Receivable, Accounts Payable or deposit account line; clear the party on this line.',
    );
  });
});

interface Mapping { role: string; accountId: string }
const ACCOUNT_NAMES: Record<string, { accountNumber: string; name: string }> = {
  ar: { accountNumber: '1.2.1', name: 'Piutang Usaha' },
  ap: { accountNumber: '2.1.1', name: 'Hutang Usaha' },
  cdep: { accountNumber: '2.1.2', name: 'Uang Muka Customer' },
  vdep: { accountNumber: '1.3', name: 'Uang Muka Pembelian' },
};

function roleTx(mappings: Mapping[], remapKeys: string[] = []) {
  return makeAutoTx({
    'systemAccountMapping.findMany': (args: any) => {
      const roles: string[] = typeof args.where.role === 'string' ? [args.where.role] : args.where.role.in;
      return mappings
        .filter((m) => roles.includes(m.role))
        .map((m) => ({ ...m, account: ACCOUNT_NAMES[m.accountId] ?? { accountNumber: '9.9', name: m.accountId } }));
    },
    'journalEntry.findMany': () => remapKeys.map((sourceKey, i) => ({ sourceKey, createdAt: new Date(Date.UTC(2170, 0, 1 + i)) })),
    'account.findUnique': (args: any) => ACCOUNT_NAMES[args.where.id] ?? { accountNumber: '9.9', name: args.where.id },
    'party.findMany': (args: any) =>
      [{ id: 'c', partyType: 'Customer' }, { id: 's', partyType: 'Supplier' }].filter((p) => args.where.id.in.includes(p.id)),
  });
}

const BASE: Mapping[] = [
  { role: 'AR', accountId: 'ar' },
  { role: 'AP', accountId: 'ap' },
  { role: 'CUSTOMER_DEPOSIT', accountId: 'cdep' },
  { role: 'VENDOR_DEPOSIT', accountId: 'vdep' },
  { role: 'TAX_OUTPUT', accountId: 'ppn' },
];

describe('loadPartyRoleMap', () => {
  it('maps the four party roles from the caller transaction, nothing else', async () => {
    const { tx, fn } = roleTx(BASE);
    const map = await loadPartyRoleMap(tx);
    expect(Object.fromEntries(map)).toEqual({ ar: 'AR', ap: 'AP', cdep: 'CUSTOMER_DEPOSIT', vdep: 'VENDOR_DEPOSIT' });
    expect(fn('systemAccountMapping.findMany').mock.calls[0][0].where).toEqual({ role: { in: [...PARTY_ROLES] } });
  });

  it('one account under AR and CUSTOMER_DEPOSIT is PARTY_ROLE_AMBIGUOUS', async () => {
    const { tx } = roleTx([{ role: 'AR', accountId: 'ar' }, { role: 'CUSTOMER_DEPOSIT', accountId: 'ar' }]);
    const err = await loadPartyRoleMap(tx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe('PARTY_ROLE_AMBIGUOUS');
    expect((err as BusinessError).message).toBe(
      'Akun 1.2.1 Piutang Usaha dipetakan ke dua peran pihak (Piutang Usaha dan Uang Muka Customer). Perbaiki pemetaan di Pengaturan > Akun Sistem.',
    );
    expect(translateMessage((err as BusinessError).message, 'en')).toBe(
      'Account 1.2.1 Accounts Receivable is mapped to two party roles (Accounts Receivable and Customer deposit). Fix the mapping in Settings > System Accounts.',
    );
  });

  it('with account ids, refuses a conflict only on those accounts', async () => {
    const { tx } = roleTx([...BASE, { role: 'VENDOR_DEPOSIT', accountId: 'ap' }]);
    const map = await loadPartyRoleMap(tx, ['ar', 'rev']);
    expect(map.get('ar')).toBe('AR');
    expect(map.get('ap')).toBe('AP');
    expect(((await loadPartyRoleMap(tx, ['ar', 'ap']).catch((e: unknown) => e)) as BusinessError).code).toBe('PARTY_ROLE_AMBIGUOUS');
    expect(((await loadPartyRoleMap(tx).catch((e: unknown) => e)) as BusinessError).code).toBe('PARTY_ROLE_AMBIGUOUS');
  });

  it('two accounts under one role are fine', async () => {
    const { tx } = roleTx([...BASE, { role: 'AR', accountId: 'ar2' }]);
    expect((await loadPartyRoleMap(tx)).get('ar2')).toBe('AR');
  });

  it('holds former role accounts from remap keys; a role remapped back is not a conflict', async () => {
    const { tx, fn } = roleTx(BASE, [
      sourceKeys.remap('AR', 'old-ar', 'ar', '2170-01-31'),
      sourceKeys.remap('AP', 'ap', 'ap-new', '2170-02-28'), // ap is still mapped AP: stays AP
      sourceKeys.remap('AP', 'ap-new', 'ap', '2170-03-31'), // remapped back
      sourceKeys.remap('COGS', 'old-cogs', 'cogs', '2170-01-01'), // not a party role
      'REMAP:broken',
    ]);
    const map = await loadPartyRoleMap(tx);
    expect(map.get('old-ar')).toBe('AR');
    expect(map.get('ap')).toBe('AP');
    expect(map.get('ap-new')).toBe('AP');
    expect(map.has('old-cogs')).toBe(false);
    expect(fn('journalEntry.findMany').mock.calls[0][0]).toMatchObject({
      where: { sourceType: 'SYSTEM_DOC', sourceKey: { startsWith: 'REMAP:' }, status: { not: 'Cancelled' } },
    });
  });

  it('a former deposit account now mapped AR is PARTY_ROLE_AMBIGUOUS', async () => {
    // CUSTOMER_DEPOSIT moved from x to cdep, then AR was mapped to x.
    const { tx } = roleTx([...BASE, { role: 'AR', accountId: 'x' }], [sourceKeys.remap('CUSTOMER_DEPOSIT', 'x', 'cdep', '2170-01-31')]);
    const err = await loadPartyRoleMap(tx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe('PARTY_ROLE_AMBIGUOUS');
    expect((err as BusinessError).message).toBe(
      'Akun 9.9 x memegang dua peran pihak (Piutang Usaha dan Uang Muka Customer) lewat pemindahan akun sistem. Satu akun hanya boleh memegang satu peran pihak; pilih akun lain di Pengaturan > Akun Sistem.',
    );
    expect(translateMessage((err as BusinessError).message, 'en')).toBe(
      'Account 9.9 x has held two party roles (Accounts Receivable and Customer deposit) through a system account move. One account can hold only one party role; choose another account in Settings > System Accounts.',
    );
  });

  it('an account that was AR and later AP (both former) is PARTY_ROLE_AMBIGUOUS', async () => {
    const { tx } = roleTx(BASE, [sourceKeys.remap('AR', 'x', 'ar', '2170-03-01'), sourceKeys.remap('AP', 'x', 'ap', '2170-04-01')]);
    expect(((await loadPartyRoleMap(tx).catch((e: unknown) => e)) as BusinessError).code).toBe('PARTY_ROLE_AMBIGUOUS');
  });
});

describe('roleAccountIds', () => {
  const remaps = [sourceKeys.remap('AR', 'old-ar', 'ar', '2170-01-31'), sourceKeys.remap('AP', 'old-ap', 'ap', '2170-01-31')];

  it('returns the current accounts of one role', async () => {
    const { tx, fn } = roleTx([...BASE, { role: 'AR', accountId: 'ar2' }], remaps);
    expect(await roleAccountIds(tx, 'AR')).toEqual(['ar', 'ar2']);
    expect(fn('journalEntry.findMany')).not.toHaveBeenCalled();
  });

  it('adds the former accounts of that role with includeFormer', async () => {
    const { tx } = roleTx(BASE, [...remaps, sourceKeys.remap('AR', 'ar', 'ar', '2170-02-01')]);
    expect(await roleAccountIds(tx, 'AR', { includeFormer: true })).toEqual(['ar', 'old-ar']);
    expect(await roleAccountIds(tx, 'AP', { includeFormer: true })).toEqual(['ap', 'old-ap']);
  });

  it('never lists one account under two roles: it refuses the same conflicts as loadPartyRoleMap', async () => {
    const formerDepositNowAr = roleTx([...BASE, { role: 'AR', accountId: 'x' }], [sourceKeys.remap('CUSTOMER_DEPOSIT', 'x', 'cdep', '2170-01-31')]);
    for (const role of ['AR', 'CUSTOMER_DEPOSIT'] as const) {
      const err = await roleAccountIds(formerDepositNowAr.tx, role, { includeFormer: true }).catch((e: unknown) => e);
      expect((err as BusinessError).code, role).toBe('PARTY_ROLE_AMBIGUOUS');
    }
    const formerArThenAp = roleTx(BASE, [sourceKeys.remap('AR', 'x', 'ar', '2170-03-01'), sourceKeys.remap('AP', 'x', 'ap', '2170-04-01')]);
    const err = await roleAccountIds(formerArThenAp.tx, 'AP', { includeFormer: true }).catch((e: unknown) => e);
    expect((err as BusinessError).code).toBe('PARTY_ROLE_AMBIGUOUS');
  });

  it('a conflict between two other roles does not concern this one', async () => {
    const apVdep = roleTx([...BASE, { role: 'VENDOR_DEPOSIT', accountId: 'ap' }]);
    expect(await roleAccountIds(apVdep.tx, 'AR', { includeFormer: true })).toEqual(['ar']);
    expect(await roleAccountIds(apVdep.tx, 'CUSTOMER_DEPOSIT', { includeFormer: true })).toEqual(['cdep']);
    for (const role of ['AP', 'VENDOR_DEPOSIT'] as const) {
      const err = await roleAccountIds(apVdep.tx, role, { includeFormer: true }).catch((e: unknown) => e);
      expect((err as BusinessError).code, role).toBe('PARTY_ROLE_AMBIGUOUS');
    }
    const formerArThenAp = roleTx(BASE, [sourceKeys.remap('AR', 'x', 'ar', '2170-03-01'), sourceKeys.remap('AP', 'x', 'ap', '2170-04-01')]);
    expect(await roleAccountIds(formerArThenAp.tx, 'CUSTOMER_DEPOSIT', { includeFormer: true })).toEqual(['cdep']);
  });

  it('a role remapped away and back lists the account once', async () => {
    const { tx } = roleTx(BASE, [sourceKeys.remap('AR', 'ar', 'ar-tmp', '2170-01-31'), sourceKeys.remap('AR', 'ar-tmp', 'ar', '2170-02-28')]);
    expect(await roleAccountIds(tx, 'AR', { includeFormer: true })).toEqual(['ar', 'ar-tmp']);
    expect(await roleAccountIds(tx, 'CUSTOMER_DEPOSIT', { includeFormer: true })).toEqual(['cdep']);
  });
});

describe('loadPartyTypes', () => {
  it('loads the type of each distinct party id, skipping blanks', async () => {
    const { tx, fn } = roleTx(BASE);
    const types = await loadPartyTypes(tx, ['c', 's', 'c', null, undefined, 'ghost']);
    expect(Object.fromEntries(types)).toEqual({ c: 'Customer', s: 'Supplier' });
    expect(fn('party.findMany').mock.calls[0][0].where).toEqual({ id: { in: ['c', 's', 'ghost'] } });
  });

  it('does not query without party ids', async () => {
    const { tx, fn } = roleTx(BASE);
    expect((await loadPartyTypes(tx, [null])).size).toBe(0);
    expect(fn('party.findMany')).not.toHaveBeenCalled();
  });
});

describe('manualJournalRule and the deposit accounts', () => {
  const dep = (id: string, accountNumber: string): AccountLite => ({
    id, accountNumber, name: 'Uang Muka', rootType: 'LIABILITY', isGroup: false, isActive: true,
  });

  it('refuses customer and supplier deposit accounts even with journal.control', () => {
    for (const kind of ['CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'] as const) {
      const p = postableAccountProblem(dep('d', '2.1.2'), manualJournalRule(true), [kind]);
      expect(p?.code, kind).toBe(ACCOUNT_CONTROL);
      expect(p?.message).toMatch(/hanya bisa dikoreksi lewat modul Uang Muka\.$/);
    }
  });

  it('refuses an account mapped under AR and a deposit role even with journal.control', () => {
    expect(postableAccountProblem(dep('d', '1.2.1'), manualJournalRule(true), ['AR', 'CUSTOMER_DEPOSIT'])?.code).toBe(ACCOUNT_CONTROL);
  });

  it('reads the deposit mapping through tx', async () => {
    const { tx } = makeAutoTx({
      'account.findMany': () => [dep('vdep', '1.3')],
      'systemAccountMapping.findMany': (args: any) =>
        [{ role: 'VENDOR_DEPOSIT', accountId: 'vdep' }].filter((m) => args.where.role.in.includes(m.role)),
    });
    const err = await assertPostableAccount(tx, 'vdep', manualJournalRule(true)).catch((e: unknown) => e);
    expect((err as BusinessError).code).toBe(ACCOUNT_CONTROL);
  });
});
