import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async (_tx, prefix: string) => `${prefix}-202610-0001`) }));
vi.mock('../../utils/accountBalance', () => ({ updateBalancesForItems: vi.fn(async () => undefined) }));
vi.mock('../../utils/fiscalYear', () => ({ getOpenFiscalYear: vi.fn(async () => ({ id: 'fy-2026' })) }));
vi.mock('../systemAccounts', () => ({
  systemAccounts: {
    getAccount: vi.fn(async (role: string) => ({ id: role === 'INVENTORY' ? 'acc-inv' : 'acc-equity' })),
  },
}));

import { postOpeningStockInTx } from '../openingStockImport';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';

const item = { id: 'item-1', code: 'GKP' };
/** The row lockInventoryRows reads back after locking the item. */
const lockedRow = (accountId: string | null = null) => () => [
  { id: 'item-1', name: 'Gabah', unit: 'Kg', isActive: true, accountId, currentStock: '0', averageCost: '0', stockValue: '0' },
];

function journalTx(extra: Record<string, (a: any) => unknown> = {}) {
  return makeAutoTx({
    'warehouse.findFirst': () => ({ id: 'wh-default' }),
    'inventoryItem.findMany': lockedRow(),
    // lockInventoryRows reads the warehouse and its stock row back; the ledger checks both exist.
    'warehouse.findMany': ({ where }) => (where.id.in as string[]).map((id) => ({ id })),
    'inventoryStock.findMany': ({ where }) =>
      (where.OR as { itemId: string; warehouseId: string }[]).map((p) => ({ id: `st-${p.warehouseId}`, ...p, currentStock: '0' })),
    'journalEntry.create': ({ data }) => ({
      id: 'je-1',
      items: data.items.create.map((i: object, n: number) => ({ id: `ji-${n}`, ...i })),
    }),
    ...extra,
  });
}

describe('postOpeningStockInTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links the movement to the default warehouse, the equity counter account and the journal', async () => {
    const { tx, fn } = journalTx();
    const res = await postOpeningStockInTx(tx, { item, quantity: 500, unitCost: 10000, totalValue: 5_000_000, userId: 'u1' });

    const mv = fn('stockMovement.create').mock.calls[0]![0].data;
    expect(mv).toMatchObject({
      warehouseId: 'wh-default',
      offsetAccountId: 'acc-equity',
      journalEntryId: 'je-1',
      referenceType: 'OpeningBalance',
      movementType: 'In',
      quantity: '500',
      valueDelta: '5000000',
    });
    expect(fn('inventoryStock.update')).toHaveBeenCalledWith(
      expect.objectContaining({ where: { itemId_warehouseId: { itemId: 'item-1', warehouseId: 'wh-default' } } }),
    );
    expect(res).toEqual({ movementId: expect.any(String), journalEntryId: 'je-1', warehouseId: 'wh-default' });
  });

  it('keeps the journal balanced DR Persediaan / CR Ekuitas Saldo Awal', async () => {
    const { tx, fn } = journalTx();
    await postOpeningStockInTx(tx, { item, quantity: 2, unitCost: 50, totalValue: 100, userId: 'u1' });
    const lines = fn('journalEntry.create').mock.calls[0]![0].data.items.create;
    expect(lines).toEqual([
      expect.objectContaining({ accountId: 'acc-inv', debit: 100, credit: 0 }),
      expect.objectContaining({ accountId: 'acc-equity', debit: 0, credit: 100 }),
    ]);
  });

  it('uses the warehouse code from the file and rejects an unknown one', async () => {
    const { tx, fn } = journalTx({ 'warehouse.findUnique': ({ where }) => (where.code === 'GDG-2' ? { id: 'wh-2' } : null) });
    await postOpeningStockInTx(tx, { item, quantity: 1, unitCost: 1, totalValue: 1, warehouseCode: 'GDG-2', userId: 'u1' });
    expect(fn('stockMovement.create').mock.calls[0]![0].data.warehouseId).toBe('wh-2');

    await expect(
      postOpeningStockInTx(tx, { item, quantity: 1, unitCost: 1, totalValue: 1, warehouseCode: 'NOPE', userId: 'u1' }),
    ).rejects.toThrow('Gudang dengan kode "NOPE" tidak ditemukan.');
  });

  it('locks the item and takes its stock and average from the locked row, not the caller', async () => {
    const { tx, fn } = journalTx({
      'inventoryItem.findMany': () => [
        { id: 'item-1', name: 'Gabah', unit: 'Kg', isActive: true, accountId: null, currentStock: '100', averageCost: '4000', stockValue: '400000' },
      ],
    });
    await postOpeningStockInTx(tx, { item, quantity: 100, unitCost: 6000, totalValue: 600_000, userId: 'u1' });
    const lockSql = fn('$queryRaw').mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(lockSql.some((q) => q.includes('FROM inventory_items') && q.includes('FOR NO KEY UPDATE'))).toBe(true);
    // (400.000 + 600.000) / 200 = 5000: the locked stock and book value, not zeros from the caller.
    expect(fn('inventoryItem.update').mock.calls[0]![0].data).toMatchObject({ currentStock: '200', stockValue: '1000000', averageCost: '5000' });
  });

  it('rejects an item that no longer exists', async () => {
    const { tx, fn } = journalTx({ 'inventoryItem.findMany': () => [] });
    await expect(
      postOpeningStockInTx(tx, { item, quantity: 1, unitCost: 1, totalValue: 1, userId: 'u1' }),
    ).rejects.toThrow('Item stok tidak ditemukan.');
    expect(fn('journalEntry.create')).not.toHaveBeenCalled();
  });

  it('fails clearly when no warehouse can be resolved', async () => {
    const { tx, fn } = makeAutoTx();
    await expect(
      postOpeningStockInTx(tx, { item, quantity: 1, unitCost: 1, totalValue: 1, userId: 'u1' }),
    ).rejects.toThrow(/Gudang belum ditentukan/);
    expect(fn('stockMovement.create')).not.toHaveBeenCalled();
  });

  it('refuses an item whose inventory account is gone: its value would have no journal', async () => {
    const { tx, fn } = journalTx({ 'inventoryItem.findMany': lockedRow('acc-gone') });
    await expect(
      postOpeningStockInTx(tx, { item, quantity: 1, unitCost: 1, totalValue: 1, userId: 'u1' }),
    ).rejects.toThrow("Akun persediaan item 'GKP' tidak ditemukan.");
    expect(fn('journalEntry.create')).not.toHaveBeenCalled();
    expect(fn('stockMovement.create')).not.toHaveBeenCalled();
  });

  it('books the journal and the ledger at the same 2 dp amount', async () => {
    const { tx, fn } = journalTx();
    await postOpeningStockInTx(tx, { item, quantity: 3, unitCost: 3333.3333, totalValue: 9999.9999, userId: 'u1' });
    const lines = fn('journalEntry.create').mock.calls[0]![0].data.items.create;
    expect(lines[0]).toMatchObject({ debit: 10000 });
    expect(fn('stockMovement.create').mock.calls[0]![0].data).toMatchObject({ valueDelta: '10000', totalValue: '10000', unitCost: '3333.333333' });
  });
});
