import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeAutoTx } from '../../../__tests__/helpers/autoTx';

vi.mock('../../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { logger } from '../../../lib/logger';
import { BusinessError, handleRouteError } from '../../../utils/errors';
import {
  STOCK_BUSY,
  STOCK_INSUFFICIENT,
  assertStockAvailable,
  lockInventoryRows,
  stockKey,
  sumStockNeeds,
} from '../stockLocks';

const ITEM_A = 'item-a';
const ITEM_B = 'item-b';
const WH_1 = 'wh-1';
const WH_2 = 'wh-2';

/** SQL text of a $queryRaw call (its template strings joined). */
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

const items = [
  { id: ITEM_A, name: 'Gabah', unit: 'Kg', isActive: true, accountId: null, currentStock: '1000', averageCost: '6000' },
  { id: ITEM_B, name: 'Beras', unit: 'Kg', isActive: true, accountId: 'acc-1', currentStock: '50', averageCost: '12000' },
];

/** A tx whose stock rows are `stocks` (itemId::warehouseId -> qty) and whose items are `items`. */
function stockTx(stocks: Record<string, number>, extra: Record<string, (args: any) => unknown> = {}) {
  return makeAutoTx({
    'inventoryItem.findMany': ({ where }: any) => items.filter((i) => (where.id.in as string[]).includes(i.id)),
    'inventoryItem.findUnique': ({ where }: any) => items.find((i) => i.id === where.id) ?? null,
    'warehouse.findMany': ({ where }: any) => (where.id.in as string[]).filter((id) => id !== 'wh-gone').map((id) => ({ id })),
    'warehouse.findUnique': ({ where }: any) => ({ name: `Gudang ${where.id}` }),
    'inventoryStock.findMany': ({ where }: any) =>
      (where.OR as { itemId: string; warehouseId: string }[]).map((p) => ({
        id: `st-${p.itemId}-${p.warehouseId}`, itemId: p.itemId, warehouseId: p.warehouseId, currentStock: String(stocks[stockKey(p.itemId, p.warehouseId)] ?? 0),
      })),
    ...extra,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('sumStockNeeds', () => {
  it('sums per (item, warehouse), keeps a null warehouse apart and drops quantities <= 0', () => {
    const summed = sumStockNeeds([
      { itemId: ITEM_A, warehouseId: WH_1, quantity: 600 },
      { itemId: ITEM_A, warehouseId: WH_1, quantity: '600' },
      { itemId: ITEM_A, warehouseId: WH_2, quantity: 1 },
      { itemId: ITEM_A, warehouseId: null, quantity: 2 },
      { itemId: ITEM_B, warehouseId: WH_1, quantity: 0 },
    ]);
    expect(summed.map((n) => [n.itemId, n.warehouseId, String(n.quantity)])).toEqual([
      [ITEM_A, WH_1, '1200'],
      [ITEM_A, WH_2, '1'],
      [ITEM_A, null, '2'],
    ]);
  });
});

describe('lockInventoryRows', () => {
  it('locks items in id order, creates the missing warehouse rows, then locks those rows in id order', async () => {
    const { tx, fn } = stockTx({ [stockKey(ITEM_A, WH_1)]: 400 });
    const locked = await lockInventoryRows(tx, {
      itemIds: [ITEM_B, ITEM_A, ITEM_B],
      pairs: [{ itemId: ITEM_A, warehouseId: WH_1 }, { itemId: ITEM_A, warehouseId: WH_1 }, { itemId: ITEM_A, warehouseId: 'wh-gone' }],
    });

    const raw = fn('$queryRaw').mock.calls;
    const itemLock = raw.find((c) => sqlOf(c).includes('FROM inventory_items'))!;
    expect(sqlOf(itemLock)).toMatch(/ORDER BY id FOR NO KEY UPDATE/);
    expect(itemLock[1]).toEqual([ITEM_A, ITEM_B]);
    const stockLock = raw.find((c) => sqlOf(c).includes('FROM inventory_stocks'))!;
    expect(sqlOf(stockLock)).toMatch(/ORDER BY id FOR NO KEY UPDATE/);
    expect(raw.indexOf(itemLock)).toBeLessThan(raw.indexOf(stockLock));

    // One row per pair; the unknown warehouse is skipped (the caller reports it).
    expect(fn('inventoryStock.createMany').mock.calls[0]![0]).toEqual({
      data: [{ itemId: ITEM_A, warehouseId: WH_1, currentStock: 0 }],
      skipDuplicates: true,
    });
    expect([...locked.items.keys()]).toEqual([ITEM_A, ITEM_B]);
    expect(locked.items.get(ITEM_B)!.averageCost.toNumber()).toBe(12000);
    expect(locked.stocks.get(stockKey(ITEM_A, WH_1))!.currentStock.toNumber()).toBe(400);
    expect(locked.stocks.has(stockKey(ITEM_A, 'wh-gone'))).toBe(false);
  });

  it('with createMissing: false locks only the rows that exist and creates none', async () => {
    const existing = new Set([stockKey(ITEM_A, WH_1)]);
    const { tx, fn } = stockTx({ [stockKey(ITEM_A, WH_1)]: 400 }, {
      'inventoryStock.findMany': ({ where }: any) =>
        (where.OR as { itemId: string; warehouseId: string }[])
          .filter((p) => existing.has(stockKey(p.itemId, p.warehouseId)))
          .map((p) => ({ id: `st-${p.itemId}-${p.warehouseId}`, itemId: p.itemId, warehouseId: p.warehouseId, currentStock: '400' })),
    });
    const locked = await lockInventoryRows(tx, {
      itemIds: [ITEM_A, ITEM_B],
      pairs: [{ itemId: ITEM_A, warehouseId: WH_1 }, { itemId: ITEM_B, warehouseId: WH_1 }],
      createMissing: false,
    });
    expect(fn('inventoryStock.createMany')).not.toHaveBeenCalled();
    const stockLock = fn('$queryRaw').mock.calls.find((c) => sqlOf(c).includes('FROM inventory_stocks'))!;
    expect(stockLock[1]).toEqual([`st-${ITEM_A}-${WH_1}`]);
    expect([...locked.items.keys()]).toEqual([ITEM_A, ITEM_B]);
    expect([...locked.stocks.keys()]).toEqual([stockKey(ITEM_A, WH_1)]);
  });

  it('bounds the wait with lock_timeout and restores the previous value', async () => {
    const { tx, fn } = stockTx({}, { $queryRaw: (sql: any) => (sql.join('?').includes('current_setting') ? [{ lock_timeout: '2s' }] : []) });
    await lockInventoryRows(tx, { itemIds: [ITEM_A] });
    const settings = fn('$queryRaw').mock.calls.filter((c) => sqlOf(c).includes('set_config')).map((c) => c[1]);
    expect(settings).toEqual(['5000ms', '2s']);
  });

  it('answers 409 STOCK_BUSY when the rows stay locked past the wait', async () => {
    const timeout = Object.assign(new Error('lock timeout'), { meta: { driverAdapterError: { cause: { code: '55P03' } } } });
    const { tx } = stockTx({}, {
      $queryRaw: (sql: any) => {
        if (sql.join('?').includes('FOR NO KEY UPDATE')) throw timeout;
        return [];
      },
    });
    const err = await lockInventoryRows(tx, { itemIds: [ITEM_A] }).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe(STOCK_BUSY);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    handleRouteError(res as any, err, 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('does nothing without items', async () => {
    const { tx, fn } = stockTx({});
    const locked = await lockInventoryRows(tx, { itemIds: [] });
    expect(locked.items.size).toBe(0);
    expect(fn('$queryRaw')).not.toHaveBeenCalled();
  });
});

describe('assertStockAvailable', () => {
  const stockMap = (stocks: Record<string, number>) => ({
    'inventoryStock.findMany': ({ where }: any) =>
      (where.OR as { itemId: string; warehouseId: string }[])
        .filter((p) => stocks[stockKey(p.itemId, p.warehouseId)] !== undefined)
        .map((p) => ({ itemId: p.itemId, warehouseId: p.warehouseId, currentStock: String(stocks[stockKey(p.itemId, p.warehouseId)]) })),
  });

  it('sums two lines of one item against the warehouse: 600 + 600 from 1.000 is short', async () => {
    const { tx } = stockTx({}, stockMap({ [stockKey(ITEM_A, WH_1)]: 1000 }));
    const err = await assertStockAvailable(tx, [
      { itemId: ITEM_A, warehouseId: WH_1, quantity: 600 },
      { itemId: ITEM_A, warehouseId: WH_1, quantity: 600 },
    ], { context: 'test' }).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe(STOCK_INSUFFICIENT);
    expect(err.message).toBe("Stok 'Gabah' di Gudang wh-1 tidak cukup: tersedia 1.000 Kg, dibutuhkan 1.200 Kg.");
  });

  it('checks per warehouse, not the item total', async () => {
    const { tx } = stockTx({}, stockMap({ [stockKey(ITEM_A, WH_1)]: 1000, [stockKey(ITEM_A, WH_2)]: 0 }));
    await expect(assertStockAvailable(tx, [{ itemId: ITEM_A, warehouseId: WH_1, quantity: 1000 }], { context: 'test' })).resolves.toBeUndefined();
    await expect(assertStockAvailable(tx, [{ itemId: ITEM_A, warehouseId: WH_2, quantity: 800 }], { context: 'test' }))
      .rejects.toMatchObject({ code: STOCK_INSUFFICIENT });
  });

  it('words a reversal shortage as such', async () => {
    const { tx } = stockTx({}, stockMap({}));
    await expect(assertStockAvailable(tx, [{ itemId: ITEM_A, warehouseId: WH_1, quantity: 5 }], { context: 'test', reversal: true }))
      .rejects.toThrow("Stok 'Gabah' di Gudang wh-1 tidak cukup untuk pembalikan: tersedia 0 Kg, dibutuhkan 5 Kg.");
  });

  it('checks a legacy need without a warehouse against the item total and logs it', async () => {
    const { tx } = stockTx({}, stockMap({}));
    await expect(assertStockAvailable(tx, [{ itemId: ITEM_A, warehouseId: null, quantity: 1000 }], { context: 'legacy' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ context: 'legacy', itemId: ITEM_A }, expect.stringContaining('item total'));
    await expect(assertStockAvailable(tx, [{ itemId: ITEM_A, warehouseId: null, quantity: 1001 }], { context: 'legacy' }))
      .rejects.toThrow("Stok 'Gabah' di semua gudang tidak cukup: tersedia 1.000 Kg, dibutuhkan 1.001 Kg.");
  });

  it('with allowNegative logs every shortage with its context and reason instead of throwing', async () => {
    const { tx } = stockTx({}, stockMap({ [stockKey(ITEM_A, WH_1)]: 10 }));
    await assertStockAvailable(tx, [
      { itemId: ITEM_A, warehouseId: WH_1, quantity: 15 },
      { itemId: ITEM_B, warehouseId: WH_1, quantity: 1 },
    ], { context: 'goodsReceipt.cancel', allowNegative: true, reason: 'koreksi stok fisik', userId: 'u1' });
    const bypassLogs = vi.mocked(logger.warn).mock.calls.filter((c) => String(c[1]).includes('bypassed'));
    expect(bypassLogs.map((c) => c[0])).toEqual([
      { context: 'goodsReceipt.cancel', userId: 'u1', reason: 'koreksi stok fisik', itemId: ITEM_A, warehouseId: WH_1, available: 10, needed: 15 },
      { context: 'goodsReceipt.cancel', userId: 'u1', reason: 'koreksi stok fisik', itemId: ITEM_B, warehouseId: WH_1, available: 0, needed: 1 },
    ]);
  });

  it('lets the caller build its own error (kept codes of existing clients)', async () => {
    const { tx } = stockTx({}, stockMap({}));
    await expect(assertStockAvailable(tx, [{ itemId: ITEM_B, warehouseId: WH_1, quantity: 2 }], {
      context: 'test',
      error: (s) => new BusinessError(`${s.itemName}/${s.warehouseName}/${s.available}/${s.needed}`, 'OWN_CODE'),
    })).rejects.toMatchObject({ message: 'Beras/Gudang wh-1/0/2', code: 'OWN_CODE' });
  });

  it('reads nothing when no need takes stock out', async () => {
    const { tx, fn } = stockTx({});
    await assertStockAvailable(tx, [{ itemId: ITEM_A, warehouseId: WH_1, quantity: 0 }], { context: 'test' });
    expect(fn('inventoryStock.findMany')).not.toHaveBeenCalled();
  });
});
