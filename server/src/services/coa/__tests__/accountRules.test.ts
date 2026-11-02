import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DEACTIVATE_BLOCKED,
  ACCOUNT_HAS_CHILDREN,
  ACCOUNT_NUMBER_FORMAT,
  ACCOUNT_PARENT_MISMATCH,
  ACCOUNT_PARENT_NOT_FOUND,
  ACCOUNT_PARENT_NOT_GROUP,
  ACCOUNT_STRUCTURE_LOCKED,
  ACCOUNT_TYPE_MISMATCH,
  deriveRootType,
  normalizeAccountNumber,
  numberPrefix,
  planCreate,
  planUpdate,
  prefixChanged,
  type CurrentAccount,
  type ParentFacts,
  type StructureFacts,
} from '../accountRules';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('prefix table', () => {
  it.each([
    ['1.1.6', 'ASSET'], ['2.1', 'LIABILITY'], ['3', 'EQUITY'], ['4.1', 'REVENUE'],
    ['5.1', 'EXPENSE'], ['6.19', 'EXPENSE'], ['7.4', 'REVENUE'], ['8.1', 'EXPENSE'],
    ['9.1', null], ['0.1', null], ['', null],
  ])('%s -> %s', (n, expected) => {
    expect(deriveRootType(n)).toBe(expected);
  });

  it('trims and compares prefixes', () => {
    expect(normalizeAccountNumber(' 6.19 ')).toBe('6.19');
    expect(numberPrefix('2.1.1.01')).toBe('2');
    expect(prefixChanged('6.19', '6.20')).toBe(false);
    expect(prefixChanged('6.19', '1.9.9')).toBe(true);
  });
});

const group = (accountNumber: string, rootType: ParentFacts['rootType'], isGroup = true): ParentFacts => ({
  id: `p-${accountNumber}`, accountNumber, rootType, isGroup,
});

describe('planCreate', () => {
  it('derives root and account type from the prefix', () => {
    const r = planCreate({ accountNumber: ' 7.4 ', name: undefined } as never, null);
    expect(r).toMatchObject({ ok: true, data: { accountNumber: '7.4', rootType: 'REVENUE', accountType: 'REVENUE', parentId: null, isGroup: false } });
  });

  it('rejects a number outside the format', () => {
    for (const n of ['9.1', '1..2', 'abc', '']) {
      expect(planCreate({ accountNumber: n }, null)).toMatchObject({ ok: false, code: ACCOUNT_NUMBER_FORMAT });
    }
  });

  it('rejects a body whose type differs from the prefix', () => {
    expect(planCreate({ accountNumber: '7.4', rootType: 'EXPENSE' }, null)).toMatchObject({ ok: false, code: ACCOUNT_TYPE_MISMATCH });
    expect(planCreate({ accountNumber: '7.4', accountType: 'EXPENSE' }, null)).toMatchObject({ ok: false, code: ACCOUNT_TYPE_MISMATCH });
    expect(planCreate({ accountNumber: '7.4', rootType: 'REVENUE', accountType: 'REVENUE' }, null).ok).toBe(true);
  });

  it('requires an existing group parent of the same type whose number prefixes the new one', () => {
    expect(planCreate({ accountNumber: '4.1.1', parentId: 'x' }, null)).toMatchObject({ code: ACCOUNT_PARENT_NOT_FOUND });
    expect(planCreate({ accountNumber: '4.1.1', parentId: 'x' }, group('4.1', 'REVENUE', false))).toMatchObject({ code: ACCOUNT_PARENT_NOT_GROUP });
    expect(planCreate({ accountNumber: '4.1.1', parentId: 'x' }, group('1.1', 'ASSET'))).toMatchObject({ code: ACCOUNT_PARENT_MISMATCH });
    expect(planCreate({ accountNumber: '4.2.1', parentId: 'x' }, group('4.1', 'REVENUE'))).toMatchObject({ code: ACCOUNT_PARENT_MISMATCH });
    expect(planCreate({ accountNumber: '4.1.1', parentId: 'x' }, group('4.1', 'REVENUE'))).toMatchObject({ ok: true, data: { parentId: 'p-4.1' } });
  });
});

const account = (over: Partial<CurrentAccount> = {}): CurrentAccount => ({
  accountNumber: '7.4', rootType: 'REVENUE', isGroup: false, isActive: true, balance: D(0), ...over,
});
const facts = (over: Partial<StructureFacts> = {}): StructureFacts => ({
  hasLedger: false, deactivationNet: D(0), childCount: 0, activeChildCount: 0, mappedRoles: [], ...over,
});

describe('planUpdate', () => {
  it('renaming never touches rootType', () => {
    const r = planUpdate(account(), { name: 'Pendapatan lain', accountNumber: '7.4' }, facts({ hasLedger: true }), null);
    expect(r).toEqual({ ok: true, data: { name: 'Pendapatan lain' } });
  });

  it('keeps a number change inside the prefix and only changes the number', () => {
    const r = planUpdate(account({ accountNumber: '6.19', rootType: 'EXPENSE' }), { accountNumber: '6.20' }, facts({ hasLedger: true }), null);
    expect(r).toEqual({ ok: true, data: { accountNumber: '6.20' } });
  });

  it('locks the prefix of an account with ledger rows', () => {
    const cur = account({ accountNumber: '6.19', rootType: 'EXPENSE' });
    expect(planUpdate(cur, { accountNumber: '1.9.9' }, facts({ hasLedger: true }), null)).toMatchObject({ ok: false, code: ACCOUNT_STRUCTURE_LOCKED });
  });

  it('locks the group flag of an account with ledger rows', () => {
    expect(planUpdate(account(), { isGroup: true }, facts({ hasLedger: true }), null)).toMatchObject({ ok: false, code: ACCOUNT_STRUCTURE_LOCKED });
    expect(planUpdate(account(), { isGroup: false }, facts({ hasLedger: true }), null).ok).toBe(true);
  });

  it('re-derives the type when the prefix changes without ledger rows', () => {
    const r = planUpdate(account({ accountNumber: '6.19', rootType: 'EXPENSE' }), { accountNumber: '7.19' }, facts(), null);
    expect(r).toEqual({ ok: true, data: { accountNumber: '7.19', rootType: 'REVENUE', accountType: 'REVENUE' } });
  });

  it('refuses a prefix change on an account with children', () => {
    const cur = account({ accountNumber: '6.19', rootType: 'EXPENSE', isGroup: true });
    expect(planUpdate(cur, { accountNumber: '7.19' }, facts({ childCount: 1 }), null)).toMatchObject({ code: ACCOUNT_STRUCTURE_LOCKED });
  });

  it('keeps a renumbered child under its parent number', () => {
    const cur = account({ accountNumber: '4.1.1', rootType: 'REVENUE' });
    expect(planUpdate(cur, { accountNumber: '4.2.1' }, facts(), group('4.1', 'REVENUE'))).toMatchObject({ code: ACCOUNT_PARENT_MISMATCH });
    expect(planUpdate(cur, { accountNumber: '4.1.2' }, facts(), group('4.1', 'REVENUE')).ok).toBe(true);
  });

  it('rejects a malformed number before any lock or children check', () => {
    expect(planUpdate(account(), { accountNumber: '9.1' }, facts({ hasLedger: true, childCount: 2 }), null)).toMatchObject({ code: ACCOUNT_NUMBER_FORMAT });
  });

  it('does not re-check the format of an unchanged legacy number', () => {
    expect(planUpdate(account({ accountNumber: '1.a' }), { accountNumber: '1.a', name: 'x' }, facts(), null).ok).toBe(true);
  });

  it('refuses to turn a group with children into a detail account', () => {
    expect(planUpdate(account({ isGroup: true }), { isGroup: false }, facts({ childCount: 2 }), null)).toMatchObject({ code: ACCOUNT_HAS_CHILDREN });
  });

  describe('deactivation', () => {
    it('allows an empty account', () => {
      expect(planUpdate(account(), { isActive: false }, facts(), null)).toEqual({ ok: true, data: { isActive: false } });
    });

    it('blocks a balance of 0.01 but not 0.00', () => {
      expect(planUpdate(account({ balance: D('0.00') }), { isActive: false }, facts(), null).ok).toBe(true);
      expect(planUpdate(account({ balance: D('0.01') }), { isActive: false }, facts(), null)).toMatchObject({ code: ACCOUNT_DEACTIVATE_BLOCKED });
      expect(planUpdate(account(), { isActive: false }, facts({ deactivationNet: D('-0.01') }), null)).toMatchObject({ code: ACCOUNT_DEACTIVATE_BLOCKED });
    });

    it('blocks a mapped account and one with active children', () => {
      expect(planUpdate(account(), { isActive: false }, facts({ mappedRoles: ['COGS'] }), null)).toMatchObject({ code: ACCOUNT_DEACTIVATE_BLOCKED });
      expect(planUpdate(account({ isGroup: true }), { isActive: false }, facts({ childCount: 2, activeChildCount: 1 }), null)).toMatchObject({ code: ACCOUNT_DEACTIVATE_BLOCKED });
      expect(planUpdate(account({ isGroup: true }), { isActive: false }, facts({ childCount: 2, activeChildCount: 0 }), null).ok).toBe(true);
    });

    it('lets an already inactive account be reactivated and saved without the checks', () => {
      expect(planUpdate(account({ isActive: false, balance: D(5) }), { isActive: true }, facts(), null)).toEqual({ ok: true, data: { isActive: true } });
      expect(planUpdate(account({ isActive: false, balance: D(5) }), { isActive: false }, facts(), null)).toEqual({ ok: true, data: {} });
    });
  });

  it('reports format, then structure, before deactivation problems', () => {
    const r = planUpdate(account({ balance: D(9) }), { accountNumber: '9.9', isActive: false }, facts({ hasLedger: true }), null);
    expect(r).toMatchObject({ code: ACCOUNT_NUMBER_FORMAT });
  });
});
