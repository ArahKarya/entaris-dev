import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { loadProductionCostContext, type ProductionCostContextInput } from '../productionCostContext';
import { STOCK_INSUFFICIENT } from '../../inventory/stockLocks';

type Item = { id: string; name: string; unit: string; isActive: boolean; currentStock: number; averageCost: number; stockValue: number };
type Batch = { id: string; itemId: string; isCancelled: boolean; movementType: string; unitCost: number; quantity: number; totalValue: number; valueDelta: number };

const items: Item[] = [
  { id: 'gkp', name: 'GKP', unit: 'Kg', isActive: true, currentStock: 1000, averageCost: 6000, stockValue: 6000000 },
  { id: 'beras', name: 'Beras', unit: 'Kg', isActive: true, currentStock: 0, averageCost: 0, stockValue: 0 },
  { id: 'bekatul', name: 'Bekatul', unit: 'Kg', isActive: true, currentStock: 0, averageCost: 0, stockValue: 0 },
];
const batches: Batch[] = [{ id: 'sm-batch', itemId: 'gkp', isCancelled: false, movementType: 'In', unitCost: 5800, quantity: 100, totalValue: 580000, valueDelta: 580000 }];

/** Stock per warehouse: GKP holds 1.000 at A and 5.000 at B; the run takes from A. */
const stocks = [
  { itemId: 'gkp', warehouseId: 'wh-a', currentStock: 1000 },
  { itemId: 'gkp', warehouseId: 'wh-b', currentStock: 5000 },
];

function txWith(list: Item[] = items) {
  type Where = { id?: { in: string[] } | string; OR?: { itemId: string; warehouseId: string }[] };
  return {
    inventoryItem: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => list.filter((i) => where.id.in.includes(i.id)),
      findUnique: async ({ where }: { where: { id: string } }) => list.find((i) => i.id === where.id) ?? null,
    },
    inventoryStock: {
      findMany: async ({ where }: { where: Where }) =>
        stocks.filter((r) => where.OR!.some((p) => p.itemId === r.itemId && p.warehouseId === r.warehouseId)),
    },
    warehouse: { findUnique: async ({ where }: { where: { id: string } }) => ({ name: where.id === 'wh-a' ? 'A' : 'B' }) },
    stockMovement: {
      findUnique: async ({ where }: { where: { id: string } }) => batches.find((b) => b.id === where.id) ?? null,
      groupBy: async () => [],
    },
  } as unknown as Prisma.TransactionClient;
}

const body = (over: Partial<ProductionCostContextInput> = {}): ProductionCostContextInput => ({
  inputs: [{ itemId: 'gkp', quantity: 1000 }],
  outputs: [{ itemId: 'beras', quantity: 600 }, { itemId: 'bekatul', quantity: 100, unitPrice: 2000, isByProduct: true }],
  ...over,
});
const opts = { warehouseId: 'wh-a', context: 'test' };

describe('loadProductionCostContext', () => {
  it('costs an unpicked input at WAC and a picked one at the client snapshot, else the batch cost', async () => {
    const ctx = await loadProductionCostContext(txWith(), body({
      inputs: [
        { itemId: 'gkp', quantity: 400 },
        { itemId: 'gkp', quantity: 300, sourceMovementId: 'sm-batch', batchUnitCost: 5900 },
        { itemId: 'gkp', quantity: 300, sourceMovementId: 'sm-batch' },
      ],
    }), opts);
    expect(ctx.inputs).toEqual([
      { sourceMovementId: null, batchUnitCost: null, unitCost: 6000 },
      { sourceMovementId: 'sm-batch', batchUnitCost: 5900, unitCost: 5900 },
      { sourceMovementId: 'sm-batch', batchUnitCost: 5800, unitCost: 5800 },
    ]);
    expect(ctx.itemMap.get('beras')?.name).toBe('Beras');
  });

  it('costs an input with a non-positive WAC at 0', async () => {
    const list = items.map((i) => (i.id === 'gkp' ? { ...i, averageCost: -5 } : i));
    const ctx = await loadProductionCostContext(txWith(list), body(), opts);
    expect(ctx.inputs[0]!.unitCost).toBe(0);
  });

  it('rejects short stock at the production warehouse, lines of one item summed, unless bypassed', async () => {
    const short = body({ inputs: [{ itemId: 'gkp', quantity: 700 }, { itemId: 'gkp', quantity: 500 }] });
    await expect(loadProductionCostContext(txWith(), short, opts)).rejects.toMatchObject({
      code: STOCK_INSUFFICIENT,
      message: "Stok 'GKP' di gudang A tidak cukup. Tersedia: 1.000 Kg, dibutuhkan: 1.200 Kg. Buat penerimaan/transfer dulu.",
    });
    await expect(loadProductionCostContext(txWith(), { ...short, allowNegativeStock: true }, opts)).resolves.toBeDefined();
    // The 5.000 at B do not cover a run at A; the same run at B passes.
    await expect(loadProductionCostContext(txWith(), short, { ...opts, warehouseId: 'wh-b' })).resolves.toBeDefined();
  });

  it('rejects missing or inactive items and a by-product without NRV', async () => {
    await expect(loadProductionCostContext(txWith(), body({ inputs: [{ itemId: 'nope', quantity: 1 }] }), opts))
      .rejects.toThrow('Item input tidak ditemukan.');
    const inactive = items.map((i) => (i.id === 'beras' ? { ...i, isActive: false } : i));
    await expect(loadProductionCostContext(txWith(inactive), body(), opts)).rejects.toThrow("Item output 'Beras' tidak aktif.");
    await expect(loadProductionCostContext(txWith(), body({
      outputs: [{ itemId: 'bekatul', quantity: 100, isByProduct: true }],
    }), opts)).rejects.toThrow("NRV 'Bekatul' wajib diisi (minimal 0).");
  });

  it('names the input line when the picked batch is invalid', async () => {
    await expect(loadProductionCostContext(txWith(), body({
      inputs: [{ itemId: 'gkp', quantity: 1 }, { itemId: 'gkp', quantity: 1, sourceMovementId: 'missing' }],
    }), opts)).rejects.toThrow('Batch sumber tidak ditemukan untuk input ke-2.');
  });
});
