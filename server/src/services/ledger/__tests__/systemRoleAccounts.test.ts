import { describe, it, expect, vi } from 'vitest';
import {
  cogsAccountFor,
  salesReturnAccount,
  productionConversionAccount,
  productionDiffAccounts,
  splitProductionDiff,
} from '../systemRoleAccounts';
import { ACCOUNT_MAPPING_MISSING } from '../../../types/systemAccounts';

type MappingRow = { account: { id: string; accountNumber: string; name: string } } | null;

function fakeTx(byRole: Record<string, MappingRow>) {
  const findFirst = vi.fn(async ({ where }: { where: { role: string } }) => byRole[where.role] ?? null);
  return { tx: { systemAccountMapping: { findFirst } } as any, findFirst };
}

const acct = (id: string, accountNumber: string) => ({ account: { id, accountNumber, name: `Acct ${accountNumber}` } });

describe('role account helpers', () => {
  it('read the account mapped to each role', async () => {
    const { tx, findFirst } = fakeTx({
      COGS: acct('a1', '5.2'),
      SALES_RETURN: acct('a2', '4.1.9'),
      PRODUCTION_CONVERSION: acct('a3', '5.12'),
    });
    expect((await cogsAccountFor(tx)).accountNumber).toBe('5.2');
    expect((await salesReturnAccount(tx)).accountNumber).toBe('4.1.9');
    expect((await productionConversionAccount(tx)).accountNumber).toBe('5.12');
    expect(findFirst.mock.calls.map((c) => c[0].where.role)).toEqual(['COGS', 'SALES_RETURN', 'PRODUCTION_CONVERSION']);
  });

  it('throw ACCOUNT_MAPPING_MISSING for an unmapped role instead of falling back', async () => {
    const { tx } = fakeTx({});
    for (const fn of [cogsAccountFor, salesReturnAccount, productionConversionAccount]) {
      await expect(fn(tx)).rejects.toMatchObject({ code: ACCOUNT_MAPPING_MISSING });
    }
  });
});

describe('splitProductionDiff', () => {
  it('sends up to the conversion cost to conversion and the rest to COGS', () => {
    expect(splitProductionDiff(100, 60)).toEqual({ toConversion: 60, toCogs: 40 });
    expect(splitProductionDiff(50, 60)).toEqual({ toConversion: 50, toCogs: 0 });
  });

  it('sends the whole gain to COGS when there is no conversion cost', () => {
    expect(splitProductionDiff(100, 0)).toEqual({ toConversion: 0, toCogs: 100 });
    expect(splitProductionDiff(100, -5)).toEqual({ toConversion: 0, toCogs: 100 });
  });

  it('rounds the remainder to cents', () => {
    expect(splitProductionDiff(0.3, 0.1).toCogs).toBe(0.2);
  });

  it('returns nothing for a loss or a zero difference', () => {
    expect(splitProductionDiff(-10, 5)).toEqual({ toConversion: 0, toCogs: 0 });
    expect(splitProductionDiff(0, 5)).toEqual({ toConversion: 0, toCogs: 0 });
  });
});

describe('productionDiffAccounts', () => {
  it('needs only COGS for a loss', async () => {
    const { tx, findFirst } = fakeTx({ COGS: acct('a1', '5.2') });
    const res = await productionDiffAccounts(tx, -5);
    expect(res.conversion).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('needs the conversion account for a gain and fails when it is unmapped', async () => {
    const { tx } = fakeTx({ COGS: acct('a1', '5.2') });
    await expect(productionDiffAccounts(tx, 10)).rejects.toMatchObject({ code: ACCOUNT_MAPPING_MISSING });
  });

  it('returns both accounts for a gain', async () => {
    const { tx } = fakeTx({ COGS: acct('a1', '5.2'), PRODUCTION_CONVERSION: acct('a3', '5.12') });
    const res = await productionDiffAccounts(tx, 10);
    expect(res.cogs.id).toBe('a1');
    expect(res.conversion?.id).toBe('a3');
  });
});
