import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { BusinessError } from '../../../utils/errors';
import type { InventoryGlDiff } from '../../../services/inventory/inventoryGlCheck';

const mocks = vi.hoisted(() => ({ findInventoryGlDiffs: vi.fn(), findStockValueInvariantBreaks: vi.fn() }));
vi.mock('../../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../../services/inventory/inventoryGlCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/inventory/inventoryGlCheck')>()),
  ...mocks,
}));

import { checkInventoryVsGl, checkStockValueInvariant } from '../inventoryChecks';

const D = (v: Decimal.Value) => new Decimal(v);

function row(accountNumber: string, parts: { gl?: number; book?: number; doUninvoiced?: number; duplicate?: number; phantom?: number } = {}): InventoryGlDiff {
  const gl = D(parts.gl ?? 0);
  const bookValue = D(parts.book ?? 0);
  const doUninvoiced = D(parts.doUninvoiced ?? 0);
  return {
    accountId: `id-${accountNumber}`, accountNumber, name: `Persediaan ${accountNumber}`, gl, bookValue, qtyTimesAvg: bookValue,
    doUninvoiced, docTypedDuplicate: D(parts.duplicate ?? 0), nonJournalOther: D(0), phantomQtyValue: D(parts.phantom ?? 0),
    difference: gl.minus(bookValue).minus(doUninvoiced),
  };
}

function result(accounts: InventoryGlDiff[]) {
  const total = accounts.reduce((t, r) => ({
    ...t, gl: t.gl.plus(r.gl), bookValue: t.bookValue.plus(r.bookValue), doUninvoiced: t.doUninvoiced.plus(r.doUninvoiced),
    difference: t.difference.plus(r.difference),
  }), { ...row('TOTAL'), accountId: null, name: 'Total' });
  return { accounts, total };
}

beforeEach(() => vi.clearAllMocks());

describe('checkInventoryVsGl', () => {
  it('is an error naming the account when GL Persediaan PK holds 1.000.000 and its stock is 0', async () => {
    mocks.findInventoryGlDiffs.mockResolvedValue(result([row('1.4.0', { gl: 5_000, book: 5_000 }), row('1.4.2', { gl: 1_000_000 })]));
    const check = await checkInventoryVsGl();
    expect(check).toMatchObject({ name: 'Inventory vs GL', status: 'error', count: 1, fixable: false });
    expect(check.details).toEqual([
      expect.objectContaining({ account: '1.4.2 Persediaan 1.4.2', gl: 1_000_000, book_value: 0, difference: 1_000_000 }),
      expect.objectContaining({ account: 'Total', difference: 1_000_000 }),
    ]);
  });

  it('is a warning when only an uninvoiced delivery note or document-typed rows are left', async () => {
    mocks.findInventoryGlDiffs.mockResolvedValue(result([
      row('1.4.0', { gl: 10_000_000, book: 6_000_000, doUninvoiced: 4_000_000 }),
      row('1.4.1', { gl: 0, duplicate: 250_000 }),
    ]));
    const check = await checkInventoryVsGl();
    expect(check).toMatchObject({ status: 'warning', count: 2 });
    expect(check.details?.[0]).toMatchObject({ do_uninvoiced: 4_000_000, difference: 0 });
  });

  it('is ok with no detail rows when every account is clean', async () => {
    mocks.findInventoryGlDiffs.mockResolvedValue(result([row('1.4.0', { gl: 5_000, book: 5_000 }), row('1.4.1')]));
    expect(await checkInventoryVsGl()).toMatchObject({ status: 'ok', count: 0, details: [] });
  });

  it('is an error on phantom quantity value even when the difference is 0', async () => {
    mocks.findInventoryGlDiffs.mockResolvedValue(result([row('1.4.0', { gl: 5_000, book: 5_000, phantom: 1_200 })]));
    expect(await checkInventoryVsGl()).toMatchObject({ status: 'error', count: 1 });
  });

  it('turns an unmapped INVENTORY role into this check\'s error, and lets other errors through', async () => {
    mocks.findInventoryGlDiffs.mockRejectedValue(new BusinessError('Akun sistem untuk "Persediaan" belum dikonfigurasi.', 'ACCOUNT_MAPPING_MISSING'));
    expect(await checkInventoryVsGl()).toEqual({
      name: 'Inventory vs GL', status: 'error', message: 'Akun sistem untuk "Persediaan" belum dikonfigurasi.', count: 1, details: [], fixable: false,
    });
    mocks.findInventoryGlDiffs.mockRejectedValue(new Error('db down'));
    await expect(checkInventoryVsGl()).rejects.toThrow('db down');
  });
});

describe('checkStockValueInvariant', () => {
  it('is an error listing the broken items, ok when there are none', async () => {
    mocks.findStockValueInvariantBreaks.mockResolvedValue({
      total: 1,
      rows: [{ itemId: 'i', code: 'PK-1', kind: 'valueSum', reportOnly: false, actual: D(100), expected: D(90), difference: D(10) }],
    });
    const broken = await checkStockValueInvariant();
    expect(broken).toMatchObject({ name: 'Stock Value Invariant', status: 'error', count: 1 });
    expect(broken.details).toEqual([{ item_code: 'PK-1', kind: 'valueSum', stock_value: 100, expected: 90, difference: 10 }]);
    mocks.findStockValueInvariantBreaks.mockResolvedValue({ total: 0, rows: [] });
    expect(await checkStockValueInvariant()).toMatchObject({ status: 'ok', count: 0, details: [] });
  });
});
