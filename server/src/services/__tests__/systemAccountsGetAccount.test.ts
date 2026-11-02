// An unmapped role is a 400-class BusinessError with ACCOUNT_MAPPING_MISSING, not a plain Error
// (E2-R9 groundwork, PR-4.11). The message is unchanged.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({ prisma: { systemAccountMapping: { findMany: async () => [] } } }));
import { BusinessError } from '../../utils/errors';
import { ACCOUNT_MAPPING_MISSING } from '../../types/systemAccounts';
import { mappedAccount, systemAccounts } from '../systemAccounts';

const MESSAGE = 'Akun sistem untuk "Piutang Usaha" belum dikonfigurasi. Silakan atur di Pengaturan > Akun Sistem.';

describe('systemAccounts.getAccount', () => {
  it('unmapped role: BusinessError with ACCOUNT_MAPPING_MISSING and the same message', async () => {
    systemAccounts.invalidateCache();
    const err = await systemAccounts.getAccount('AR').catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe(ACCOUNT_MAPPING_MISSING);
    expect(err.message).toBe(MESSAGE);
  });
});

describe('mappedAccount', () => {
  it('reads through the given transaction and returns the first account', async () => {
    const findFirst = vi.fn(async () => ({ account: { id: 'a-1', accountNumber: '1.2.1', name: 'Piutang' } }));
    const tx = { systemAccountMapping: { findFirst } } as any;
    await expect(mappedAccount(tx, 'AR')).resolves.toEqual({ id: 'a-1', accountNumber: '1.2.1', name: 'Piutang' });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { role: 'AR' }, orderBy: { sortOrder: 'asc' } }));
  });

  it('unmapped role: BusinessError ACCOUNT_MAPPING_MISSING', async () => {
    const tx = { systemAccountMapping: { findFirst: async () => null } } as any;
    const err = await mappedAccount(tx, 'AR').catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe(ACCOUNT_MAPPING_MISSING);
    expect(err.message).toBe(MESSAGE);
  });
});
