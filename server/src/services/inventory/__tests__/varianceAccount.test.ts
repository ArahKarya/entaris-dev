import { describe, it, expect } from 'vitest';
import { makeAutoTx } from '../../../__tests__/helpers/autoTx';
import { INVENTORY_VARIANCE_UNSAFE, assertVarianceAccountUsable, inspectVarianceAccount } from '../varianceAccount';

const acc = (id: string, isGroup = false) => ({ account: { id, accountNumber: id, name: `Akun ${id}`, isGroup } });

/** A transaction whose first INVENTORY_VARIANCE / ROUNDING_ACCOUNT mappings are `variance` / `rounding`. */
const txWith = (variance: object | null, rounding: object | null) =>
  makeAutoTx({ 'systemAccountMapping.findFirst': ({ where }: any) => (where.role === 'INVENTORY_VARIANCE' ? variance : rounding) }).tx;

describe('Inventory Variance account guard', () => {
  it('accepts a detail account of its own', async () => {
    const tx = txWith(acc('6.38'), acc('8.8'));
    expect(await inspectVarianceAccount(tx)).toEqual({ status: 'ok', account: { id: '6.38', accountNumber: '6.38', name: 'Akun 6.38' } });
    expect((await assertVarianceAccountUsable(tx)).id).toBe('6.38');
  });

  it('refuses the rounding account (dev maps both roles to 8.8)', async () => {
    const tx = txWith(acc('8.8'), acc('8.8'));
    expect((await inspectVarianceAccount(tx)).status).toBe('shared');
    await expect(assertVarianceAccountUsable(tx)).rejects.toMatchObject({ code: INVENTORY_VARIANCE_UNSAFE });
  });

  it('refuses a group account', async () => {
    const tx = txWith(acc('6', true), null);
    expect((await inspectVarianceAccount(tx)).status).toBe('group');
    await expect(assertVarianceAccountUsable(tx)).rejects.toMatchObject({ code: INVENTORY_VARIANCE_UNSAFE });
  });

  it('refuses an unmapped role with ACCOUNT_MAPPING_MISSING', async () => {
    const tx = txWith(null, acc('8.8'));
    expect((await inspectVarianceAccount(tx)).status).toBe('missing');
    await expect(assertVarianceAccountUsable(tx)).rejects.toMatchObject({ code: 'ACCOUNT_MAPPING_MISSING' });
  });
});
