/**
 * Unit test of the as-of quantity walk (services/inventory/stockAsOf.ts, PR-6.8a) on an in-memory
 * stand-in for the two queries it makes: the business-day boundary (WIB midnight, not the server's),
 * transfers, cancelled and Revaluation rows.
 */
import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import type { Prisma, StockMovementType } from '@prisma/client';
import { qtyAsOf, qtyAsOfByWarehouse, signedQuantity } from '../stockAsOf';
import { stockKey } from '../stockLocks';

interface Row { itemId: string; warehouseId: string | null; movementType: StockMovementType; quantity: number; date: Date; isCancelled?: boolean }

const inList = (filter: { in: string[] } | undefined, v: string | null) => !filter || (v !== null && filter.in.includes(v));

/** Just enough of the client: inventoryStock.findMany and the stockMovement.groupBy the walk sends. */
function fakeDb(live: { itemId: string; warehouseId: string; currentStock: number }[], movements: Row[]) {
  return {
    inventoryStock: {
      findMany: async ({ where }: any) => live
        .filter((r) => inList(where.warehouseId, r.warehouseId) && inList(where.itemId, r.itemId))
        .map((r) => ({ ...r, currentStock: new Decimal(r.currentStock) })),
    },
    stockMovement: {
      groupBy: async ({ where }: any) => {
        const groups = new Map<string, { warehouseId: string | null; itemId: string; movementType: StockMovementType; _sum: { quantity: Decimal } }>();
        for (const m of movements) {
          if (!inList(where.warehouseId, m.warehouseId) || !inList(where.itemId, m.itemId)) continue;
          if ((m.isCancelled ?? false) !== where.isCancelled || m.date < where.date.gte) continue;
          const key = `${m.warehouseId}|${m.itemId}|${m.movementType}`;
          const g = groups.get(key) ?? { warehouseId: m.warehouseId, itemId: m.itemId, movementType: m.movementType, _sum: { quantity: new Decimal(0) } };
          groups.set(key, { ...g, _sum: { quantity: g._sum.quantity.plus(m.quantity) } });
        }
        return [...groups.values()];
      },
    },
  } as unknown as Prisma.TransactionClient;
}

const at = (iso: string) => new Date(iso);

describe('signedQuantity', () => {
  it('adds inbound and transfer-in, takes outbound and transfer-out, ignores Revaluation', () => {
    expect([
      signedQuantity('In', 5), signedQuantity('AdjustmentIn', 5), signedQuantity('TransferIn', 5),
      signedQuantity('Out', 5), signedQuantity('AdjustmentOut', 5), signedQuantity('TransferOut', 5),
      signedQuantity('Revaluation', 0),
    ].map((d) => d.toNumber())).toEqual([5, 5, 5, -5, -5, -5, 0]);
  });
});

describe('qtyAsOf', () => {
  it('walks back from the live row: a goods receipt after the day comes off (31 Dec counted after a 2 Jan receipt)', async () => {
    const db = fakeDb([{ itemId: 'gkp', warehouseId: 'A', currentStock: 10_000 }], [
      { itemId: 'gkp', warehouseId: 'A', movementType: 'In', quantity: 8_000, date: at('2117-06-10T00:00:00Z') },
      { itemId: 'gkp', warehouseId: 'A', movementType: 'In', quantity: 2_000, date: at('2117-07-02T00:00:00Z') },
    ]);
    const asOf = await qtyAsOf(db, { warehouseId: 'A', itemIds: ['gkp'], day: '2117-06-30' });
    expect(asOf.get('gkp')!.toNumber()).toBe(8_000);
  });

  it('uses the WIB day: 23:30 WIB of the day stays in, 00:30 WIB of the next day is walked back', async () => {
    const db = fakeDb([{ itemId: 'gkp', warehouseId: 'A', currentStock: 100 }], [
      // 2117-06-30 23:30 WIB = 16:30Z: on the day.
      { itemId: 'gkp', warehouseId: 'A', movementType: 'Out', quantity: 10, date: at('2117-06-30T16:30:00Z') },
      // 2117-07-01 00:30 WIB = 2117-06-30 17:30Z: the next business day, although still 30 Jun in UTC.
      { itemId: 'gkp', warehouseId: 'A', movementType: 'Out', quantity: 7, date: at('2117-06-30T17:30:00Z') },
    ]);
    const asOf = await qtyAsOf(db, { warehouseId: 'A', itemIds: ['gkp'], day: '2117-06-30' });
    expect(asOf.get('gkp')!.toNumber()).toBe(107);
  });

  it('a transfer after the day moves the stock back between the two warehouses only', async () => {
    const db = fakeDb([
      { itemId: 'gkp', warehouseId: 'A', currentStock: 60 },
      { itemId: 'gkp', warehouseId: 'B', currentStock: 40 },
    ], [
      { itemId: 'gkp', warehouseId: 'A', movementType: 'TransferOut', quantity: 40, date: at('2117-07-01T03:00:00Z') },
      { itemId: 'gkp', warehouseId: 'B', movementType: 'TransferIn', quantity: 40, date: at('2117-07-01T03:00:00Z') },
    ]);
    const all = await qtyAsOfByWarehouse(db, { warehouseIds: ['A', 'B'], day: '2117-06-30' });
    expect([all.get(stockKey('gkp', 'A'))!.toNumber(), all.get(stockKey('gkp', 'B'))!.toNumber()]).toEqual([100, 0]);
  });

  it('ignores cancelled rows, Revaluation rows and legacy rows without a warehouse', async () => {
    const db = fakeDb([{ itemId: 'gkp', warehouseId: 'A', currentStock: 50 }], [
      { itemId: 'gkp', warehouseId: 'A', movementType: 'Out', quantity: 30, date: at('2117-07-05T00:00:00Z'), isCancelled: true },
      { itemId: 'gkp', warehouseId: null, movementType: 'Revaluation', quantity: 0, date: at('2117-07-05T00:00:00Z') },
      { itemId: 'gkp', warehouseId: null, movementType: 'In', quantity: 9, date: at('2117-07-05T00:00:00Z') },
    ]);
    const asOf = await qtyAsOf(db, { warehouseId: 'A', itemIds: ['gkp'], day: '2117-06-30' });
    expect(asOf.get('gkp')!.toNumber()).toBe(50);
  });

  it('every requested item is present: 0 without a row, and an item fully used since comes back from its later movements', async () => {
    const db = fakeDb([], [
      { itemId: 'used', warehouseId: 'A', movementType: 'Out', quantity: 25, date: at('2117-07-03T00:00:00Z') },
    ]);
    const asOf = await qtyAsOf(db, { warehouseId: 'A', itemIds: ['never', 'used'], day: '2117-06-30' });
    expect([asOf.get('never')!.toNumber(), asOf.get('used')!.toNumber()]).toEqual([0, 25]);
  });

  it('asks for nothing when no warehouse or no item is given', async () => {
    const db = fakeDb([{ itemId: 'gkp', warehouseId: 'A', currentStock: 1 }], []);
    expect((await qtyAsOfByWarehouse(db, { warehouseIds: [], day: '2117-06-30' })).size).toBe(0);
    expect((await qtyAsOfByWarehouse(db, { warehouseIds: ['A'], itemIds: [], day: '2117-06-30' })).size).toBe(0);
  });
});
