/**
 * Unit: the value true-up of a cancel (reverseMovement with trueUp 'replay', E3-R8, PR-6.5a) on an
 * in-memory book. History is written through the real postInbound / postOutbound, so every row
 * carries the value the ledger decided; only the row locks, numbers and the period guard are stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';

const store = vi.hoisted(() => ({
  items: new Map<string, any>(),
  movements: [] as any[],
  clock: 0,
  seq: 0,
  lockedDay: null as string | null,
}));

vi.mock('../../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async () => `SM-T-${String(++store.seq).padStart(4, '0')}`) }));
vi.mock('../../../utils/periodGuard', async () => {
  const { BusinessError } = await import('../../../utils/errors');
  return {
    assertPeriodOpen: vi.fn(async (_tx: unknown, ref: { date: Date }) => {
      const day = ref.date.toISOString().slice(0, 10);
      if (store.lockedDay && day <= store.lockedDay) throw new BusinessError('locked', 'PERIOD_LOCKED');
      return { id: 'fy-1' };
    }),
  };
});
vi.mock('../stockLocks', () => ({
  stockKey: (itemId: string, warehouseId: string) => `${itemId}::${warehouseId}`,
  lockInventoryRows: vi.fn(async (_tx: unknown, rows: { itemIds: string[]; pairs?: { itemId: string; warehouseId: string }[] }) => {
    const items = new Map<string, any>();
    for (const id of rows.itemIds) {
      const it = store.items.get(id);
      if (it) items.set(id, { ...it });
    }
    const stocks = new Map((rows.pairs ?? []).map((p) => [`${p.itemId}::${p.warehouseId}`, { ...p }]));
    return { items, stocks };
  }),
}));

import {
  TRUE_UP_PRE_BASELINE, TRUE_UP_UNEXPLAINED, postInbound, postOutbound, postRevaluation, reverseDocumentMovements, reverseMovement,
} from '../inventoryLedger';
import { VALUATION_BASELINE_REFERENCE } from '../inventoryValueMath';

const ITEM = 'item-1';
const WH = 'wh-1';
const USER = 'user-1';
const D = (v: Decimal.Value) => new Decimal(v);

function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]: [string, any]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('not' in cond) return v !== cond.not;
      if ('gte' in cond) return v.getTime() >= cond.gte.getTime();
    }
    return v === cond;
  });
}

const withRelation = (m: any) => {
  const adjusted = m.adjustsMovementId ? store.movements.find((x) => x.id === m.adjustsMovementId) : null;
  return { ...m, adjustsMovement: adjusted ? { isCancelled: adjusted.isCancelled, referenceType: adjusted.referenceType, referenceId: adjusted.referenceId } : null };
};

const tx: any = {
  stockMovement: {
    findUnique: async ({ where }: any) => store.movements.find((m) => m.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: any) => ({ ...store.movements.find((m) => m.id === where.id) }),
    findFirst: async ({ where }: any) => store.movements.find((m) => matches(m, where)) ?? null,
    findMany: async ({ where }: any) => store.movements.filter((m) => matches(m, where)).map(withRelation),
    updateMany: async ({ where, data }: any) => {
      const rows = store.movements.filter((m) => matches(m, where));
      rows.forEach((m) => Object.assign(m, data));
      return { count: rows.length };
    },
    create: async ({ data }: any) => {
      const row = {
        id: `m-${store.movements.length + 1}`, isCancelled: false, adjustsMovementId: null, referenceType: null, referenceId: null,
        referenceNumber: null, ...data, createdAt: new Date(Date.UTC(2113, 0, 1) + ++store.clock * 1000),
        quantity: D(data.quantity), valueDelta: D(data.valueDelta),
      };
      store.movements.push(row);
      return row;
    },
  },
  inventoryStock: { update: async () => ({}) },
  inventoryItem: {
    update: async ({ where, data }: any) => {
      const it = store.items.get(where.id);
      store.items.set(where.id, {
        ...it,
        ...(data.currentStock !== undefined ? { currentStock: D(data.currentStock) } : {}),
        ...(data.stockValue !== undefined ? { stockValue: D(data.stockValue) } : {}),
        ...(data.averageCost !== undefined ? { averageCost: D(data.averageCost) } : {}),
      });
    },
  },
};

const base = { itemId: ITEM, warehouseId: WH, date: new Date('2113-04-01'), fiscalYearId: 'fy-1', createdById: USER };
const receive = (qty: number, value: number, ref?: { referenceType: string; referenceId: string }) =>
  postInbound(tx, { ...base, ...ref, movementType: 'In', quantity: qty, value });
const ship = (qty: number, ref?: { referenceType: string; referenceId: string }) =>
  postOutbound(tx, { ...base, ...ref, movementType: 'Out', quantity: qty });
const book = () => {
  const it = store.items.get(ITEM);
  return { stock: it.currentStock.toString(), value: it.stockValue.toFixed(2), average: it.averageCost.toFixed(6) };
};
const sumActive = () => store.movements.filter((m) => !m.isCancelled).reduce((s, m) => s.plus(m.valueDelta), D(0)).toFixed(2);
const replay = { userId: USER, trueUp: 'replay' as const, sweepAtZero: true, journalDay: '2113-05-02' };

beforeEach(() => {
  store.items = new Map([[ITEM, { id: ITEM, name: 'Beras', unit: 'kg', isActive: true, accountId: null, currentStock: D(0), stockValue: D(0), averageCost: D(0) }]]);
  store.movements = [];
  store.clock = 0;
  store.seq = 0;
  store.lockedDay = null;
});

describe('reverseMovement trueUp replay', () => {
  it('PRD: A 100 @10.000, B 100 @20.000, sale 100, cancel B -> true-up +500.000 (DR inventory / CR COGS), book 0', async () => {
    await receive(100, 1_000_000);
    const b = await receive(100, 2_000_000);
    const sale = await ship(100);
    expect(sale.valueDelta.toFixed(2)).toBe('-1500000.00');

    const r = await reverseMovement(tx, b.movement.id, replay);
    expect(r.valueDelta.toFixed(2)).toBe('-2000000.00');
    expect(r.trueUp.toFixed(2)).toBe('500000.00');
    expect(r.toCogs.toFixed(2)).toBe('0.00');
    expect(r.sweep).toMatchObject({ movementType: 'Revaluation', adjustsMovementId: b.movement.id, notes: expect.stringContaining('Koreksi nilai') });
    expect(r.sweep!.valueDelta.toFixed(2)).toBe('500000.00');
    expect(r.sweep!.date.toISOString().slice(0, 10)).toBe('2113-05-02');
    expect(book()).toEqual({ stock: '0', value: '0.00', average: '15000.000000' });
    expect(sumActive()).toBe('0.00');
  });

  it('negative-stock window (PRD scenario rewritten): sale past zero, receipt, cancel the sale -> true-up 0, book 100 / 1.000.000', async () => {
    await receive(100, 900_000);
    await ship(100); // stock 0, average 9.000 stays
    const minus = await ship(100);
    expect(minus.valueDelta.toFixed(2)).toBe('-900000.00');
    await receive(100, 1_000_000);
    expect(book()).toMatchObject({ stock: '0', value: '100000.00' });

    const r = await reverseMovement(tx, minus.movement.id, replay);
    expect(r.trueUp.toFixed(2)).toBe('0.00');
    expect(r.sweep).toBeNull();
    expect(book()).toEqual({ stock: '100', value: '1000000.00', average: '10000.000000' });
  });

  it('nothing went out since the row: no replay, exact reversal', async () => {
    await receive(100, 1_000_000);
    const b = await receive(50, 600_000);
    const r = await reverseMovement(tx, b.movement.id, replay);
    expect(r.trueUp.isZero()).toBe(true);
    expect(r.sweep).toBeNull();
    expect(book()).toEqual({ stock: '100', value: '1000000.00', average: '10000.000000' });
  });

  it('partial sale: stock stays on hand, the true-up re-values what went out', async () => {
    await receive(100, 1_000_000); // A @10.000
    const b = await receive(100, 2_000_000); // B @20.000, avg 15.000
    await ship(50); // 750.000 out
    const r = await reverseMovement(tx, b.movement.id, replay);
    // Without B the 50 went out at 10.000 (500.000): 250.000 too much COGS comes back.
    expect(r.trueUp.toFixed(2)).toBe('250000.00');
    expect(book()).toEqual({ stock: '50', value: '500000.00', average: '10000.000000' });
    expect(sumActive()).toBe('500000.00');
  });

  it('cancelling a sale before a later sale: the later sale took a different average', async () => {
    await receive(100, 1_000_000); // 10.000
    const first = await ship(50); // 500.000
    await receive(50, 1_000_000); // 100 @ 15.000
    await ship(100); // 1.500.000, stock 0
    const r = await reverseMovement(tx, first.movement.id, replay);
    // Without the first sale: 150 @ 13.333,33 (2.000.000), 100 out = 1.333.333,33, 50 left = 666.666,67.
    // Exact reversal puts 500.000 back; book becomes 500.000 + true-up.
    expect(r.trueUp.toFixed(2)).toBe('166666.67');
    expect(book()).toMatchObject({ stock: '50', value: '666666.67' });
  });

  it('the true-up is rounded to 2 dp: one cent is posted', async () => {
    await receive(3, 10);
    const b = await receive(3, 10.01);
    await ship(1);
    const r = await reverseMovement(tx, b.movement.id, replay);
    // With b: 1 of 6 at 20,01 -> 3,34; without: 1 of 3 at 10 -> 3,33; true-up 0,01.
    expect(r.trueUp.toFixed(2)).toBe('0.01');
    expect(sumActive()).toBe(book().value);
  });

  it('a difference below half a cent is no true-up: no row, no journal day, a locked day does not refuse', async () => {
    await receive(300, 3_000);
    const b = await receive(3, 30.01); // average 10,000033 with b, 10 without
    await ship(1); // 10,00 either way
    store.lockedDay = '2113-12-31';
    const count = store.movements.length;
    const r = await reverseMovement(tx, b.movement.id, replay);
    expect(r.trueUp.toFixed(2)).toBe('0.00');
    expect(r.toCogs.isZero()).toBe(true);
    expect(r.sweep).toBeNull();
    expect(store.movements.length).toBe(count);
    expect(store.movements.filter((m) => m.movementType === 'Revaluation')).toEqual([]);
    expect(book()).toEqual({ stock: '299', value: '2990.00', average: '10.000000' });
    expect(sumActive()).toBe(book().value);
  });

  it('without the row goods would go out past zero where they did not: TRUE_UP_UNEXPLAINED, nothing changes (PR-6.6)', async () => {
    await receive(10, 100);
    const b = await receive(10, 200);
    await ship(10); // 150 out, 10 @ 15 left
    await ship(10); // 150 out, 0
    const before = JSON.stringify(store.movements);
    // Without b the second sale goes 10 past zero at the old average: a guess, refused.
    await expect(reverseMovement(tx, b.movement.id, replay)).rejects.toMatchObject({ code: TRUE_UP_UNEXPLAINED, status: 409 });
    expect(JSON.stringify(store.movements)).toBe(before);
    expect(book()).toMatchObject({ stock: '0', value: '0.00' });
  });

  it('a later receipt does not hide the window: A, B, sale 150, C, cancel B is TRUE_UP_UNEXPLAINED', async () => {
    await receive(100, 1_000_000); // A @10.000
    const b = await receive(100, 2_000_000); // B @20.000, avg 15.000
    await ship(150); // 2.250.000, 50 / 750.000
    await receive(100, 3_000_000); // C @30.000, 150 / 3.750.000
    // The stock check passes (150 on hand), but without B the sale goes 50 past zero at 10.000 and
    // C's full cost lands on the 50 left (book 2.500.000 for goods that cost 1.500.000).
    await expect(reverseMovement(tx, b.movement.id, replay)).rejects.toMatchObject({ code: TRUE_UP_UNEXPLAINED, status: 409 });
    expect(book()).toMatchObject({ stock: '150', value: '3750000.00' });
  });

  it('a Revaluation that would land at no stock without the row is TRUE_UP_UNEXPLAINED', async () => {
    await receive(10, 100);
    const b = await receive(10, 200);
    await ship(10); // 10 / 150 left
    await postRevaluation(tx, { itemId: ITEM, date: new Date('2113-04-02'), fiscalYearId: 'fy-1', createdById: USER, delta: 50, referenceType: 'PurchaseInvoice', referenceId: 'pi-1' });
    // Without b the revaluation finds stock 0: its value would have gone to COGS, not inventory.
    await expect(reverseMovement(tx, b.movement.id, replay)).rejects.toMatchObject({ code: TRUE_UP_UNEXPLAINED, status: 409 });
  });

  it('a window the real history had too stays allowed: the sale after the row was past zero with it as well', async () => {
    await receive(10, 100);
    await ship(20); // −10 / −100, average 10
    const b = await receive(5, 100); // −5 / 0
    await ship(5); // past zero with b too: 50 at average 10, −10 / −50
    const r = await reverseMovement(tx, b.movement.id, replay);
    // Without b the sale takes the same 50: true-up 0, the window is the real one (PR-6.6 settles it).
    expect(r.trueUp.toFixed(2)).toBe('0.00');
    expect(book()).toMatchObject({ stock: '-15', value: '-150.00' });
  });

  it('value left at zero stock is swept to COGS (sweepAtZero) in the same row', async () => {
    await receive(100, 900_000);
    await ship(100);
    await ship(100); // −100 / −900.000
    await receive(100, 1_000_000); // 0 / 100.000 (window residue)
    const late = await receive(10, 120_000);
    const r = await reverseMovement(tx, late.movement.id, replay);
    expect(r.trueUp.isZero()).toBe(true);
    expect(r.toCogs.toFixed(2)).toBe('100000.00');
    expect(r.sweep!.valueDelta.toFixed(2)).toBe('-100000.00');
    expect(book()).toMatchObject({ stock: '0', value: '0.00' });
  });

  it('a swept residue stays swept in later replays: sweep, receipts, sale, cancel -> true-up 0', async () => {
    await receive(100, 900_000);
    await ship(100);
    await ship(100); // −100 / −900.000
    await receive(100, 1_000_000); // 0 / 100.000
    await receive(10, 120_000, { referenceType: 'GoodsReceipt', referenceId: 'stt-l' });
    await reverseDocumentMovements(tx, { referenceType: 'GoodsReceipt', referenceId: 'stt-l' }, replay); // sweeps 100.000
    expect(book()).toMatchObject({ stock: '0', value: '0.00' });

    await receive(20, 200_000); // 20 / 200.000
    const r2 = await receive(10, 100_000); // 30 / 300.000
    await ship(10); // 100.000 out, 20 / 200.000
    const r = await reverseMovement(tx, r2.movement.id, replay);
    // Without r2 the sale also took 10 @ 10.000: nothing to true up.
    expect(r.trueUp.toFixed(2)).toBe('0.00');
    expect(book()).toEqual({ stock: '10', value: '100000.00', average: '10000.000000' });
    expect(sumActive()).toBe(book().value);
  });

  it('replays from the last ValuationBaseline; a row before it that went out since is TRUE_UP_PRE_BASELINE', async () => {
    const old = await receive(100, 1_000_000);
    await postRevaluation(tx, { itemId: ITEM, date: new Date('2113-01-01'), fiscalYearId: 'fy-1', createdById: USER, delta: 200_000, referenceType: VALUATION_BASELINE_REFERENCE });
    const after = await receive(100, 2_400_000); // book 200 @ 18.000
    await ship(100); // 1.800.000
    await expect(reverseMovement(tx, old.movement.id, replay)).rejects.toMatchObject({ code: TRUE_UP_PRE_BASELINE, status: 409 });
    expect(store.movements.find((m) => m.id === old.movement.id).isCancelled).toBe(false);

    // The row after the baseline: opening 100 / 1.200.000 (12.000), without it the 100 went out at 12.000.
    const r = await reverseMovement(tx, after.movement.id, replay);
    expect(r.trueUp.toFixed(2)).toBe('600000.00');
    expect(book()).toEqual({ stock: '0', value: '0.00', average: '18000.000000' });
  });

  it('a replay that does not explain current_stock is TRUE_UP_UNEXPLAINED and changes nothing', async () => {
    await receive(100, 1_000_000);
    const b = await receive(100, 2_000_000);
    await ship(50);
    store.items.set(ITEM, { ...store.items.get(ITEM), currentStock: D(170) }); // drift no row explains
    const before = JSON.stringify(store.movements);
    await expect(reverseMovement(tx, b.movement.id, replay)).rejects.toMatchObject({ code: TRUE_UP_UNEXPLAINED, status: 409 });
    expect(JSON.stringify(store.movements)).toBe(before);
  });

  it('the true-up day must be open: PERIOD_LOCKED before anything is written', async () => {
    await receive(100, 1_000_000);
    const b = await receive(100, 2_000_000);
    await ship(100);
    store.lockedDay = '2113-05-31';
    const count = store.movements.length;
    await expect(reverseMovement(tx, b.movement.id, replay)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect(store.movements.length).toBe(count);
    expect(store.movements.find((m) => m.id === b.movement.id).isCancelled).toBe(false);
  });

  it('a document with two receipts: the second reversal replays without the first (cancelled) and its settlement row', async () => {
    const doc = { referenceType: 'GoodsReceipt', referenceId: 'stt-1' };
    await receive(100, 1_000_000);
    await receive(50, 1_000_000, doc);
    await receive(50, 1_000_000, doc);
    await ship(100); // 200 @ 15.000 -> 1.500.000
    const results = await reverseDocumentMovements(tx, doc, replay);
    // Without both: the 100 went out at 10.000 -> 0 left. Total true-up = 500.000.
    const total = results.reduce((s, r) => s.plus(r.trueUp).minus(r.toCogs), D(0));
    expect(total.toFixed(2)).toBe('500000.00');
    expect(book()).toEqual({ stock: '0', value: '0.00', average: expect.any(String) });
    expect(sumActive()).toBe('0.00');
  });

  it('without trueUp the train guard still refuses (REVERSAL_NEEDS_TRUE_UP)', async () => {
    await receive(100, 1_000_000);
    const b = await receive(100, 2_000_000);
    await ship(50);
    await expect(reverseMovement(tx, b.movement.id, { userId: USER })).rejects.toMatchObject({ code: 'REVERSAL_NEEDS_TRUE_UP' });
  });
});
