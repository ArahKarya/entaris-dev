import { describe, expect, it, vi } from 'vitest';

const getAccounts = vi.fn();
vi.mock('../systemAccounts', () => ({ systemAccounts: { getAccounts: (...a: unknown[]) => getAccounts(...a) } }));

import { resolveCogsAccountId } from '../cogsAccount';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';

describe('resolveCogsAccountId', () => {
  it('returns the COGS-mapped account, or null when unmapped', async () => {
    const { tx } = makeAutoTx();
    getAccounts.mockResolvedValueOnce([{ id: 'acc-5' }]);
    expect(await resolveCogsAccountId(tx)).toBe('acc-5');
    getAccounts.mockResolvedValueOnce([]);
    expect(await resolveCogsAccountId(tx)).toBeNull();
  });
});
