import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { loadProductionCostContext, type ProductionCostContextInput } from '../productionCostContext';
import { STOCK_INSUFFICIENT } from '../../inventory/stockLocks';
import { PRODUCTION_BATCH_QTY_INSUFFICIENT, PRODUCTION_BATCH_WAREHOUSE } from '../../inventory/batchAvailability';

type Item = { id: string; name: string; unit: string; isActive: boolean; currentStock: number; averageCost: number; stockValue: number };
type Batch = {
  id: string; movementNumber: string; itemId: string; warehouseId: string; date: Date; isCancelled: boolean; movementType: string;
  unitCost: number; quantity: number; totalValue: number; valueDelta: number;
};

const items: Item[] = [
  { id: 'gkp', name: 'GKP', unit: 'Kg', isActive: true, currentStock: 1000, averageCost: 6000, stockValue: 6000000 },
  { id: 'beras', name: 'Beras', unit: 'Kg', isActive: true, currentStock: 0, averageCost: 0, stockValue: 0 },
  { id: 'bekatul', name: 'Bekatul', unit: 'Kg', isActive: true, currentStock: 0, averageCost: 0, stockValue: 0 },
];
const batchRow = (id: string, warehouseId: string, quantity: number): Batch => ({
  id, movementNumber: `SM-${id}`, itemId: 'gkp', warehouseId, date: new Date('2026-01-02'), isCancelled: false, movementType: 'In',
  unitCost: 5800, quantity, totalValue: quantity * 5800, valueDelta: quantity * 5800,
});
/** 600 kg at A (nothing taken from it yet) and a batch at B. */
const batches: Batch[] = [batchRow('sm-batch', 'wh-a', 600), batchRow('sm-batch-b', 'wh-b', 2000)];

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
      findFirst: async ({ where }: { where: { itemId: string; warehouseId: string } }) =>
        stocks.find((r) => r.itemId === where.itemId && r.warehouseId === where.warehouseId) ?? null,
    },
    warehouse: { findUnique: async ({ where }: { where: { id: string } }) => ({ name: where.id === 'wh-a' ? 'A' : 'B' }) },
    stockMovement: {
      findUnique: async ({ where }: { where: { id: string } }) => batches.find((b) => b.id === where.id) ?? null,
      // By id (the picked batches), else the item's inbound batches in one warehouse.
      findMany: async ({ where }: { where: { id?: { in: string[] }; itemId?: string; warehouseId?: string } }) =>
        where.id
          ? batches.filter((b) => where.id!.in.includes(b.id))
          : batches.filter((b) => b.itemId === where.itemId && (!where.warehouseId || b.warehouseId === where.warehouseId)),
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
  it('links a picked batch, ignores the client batchUnitCost and decides no cost', async () => {
    const ctx = await loadProductionCostContext(txWith(), body({
      inputs: [
        { itemId: 'gkp', quantity: 400 },
        { itemId: 'gkp', quantity: 300, sourceMovementId: 'sm-batch', batchUnitCost: 5900 },
        { itemId: 'gkp', quantity: 300, sourceMovementId: 'sm-batch' },
      ],
    }), opts);
    // The ledger values every input when it posts it (E3-R6); the batch traces the quantity only (E6-R3).
    expect(ctx.inputs).toEqual([
      { sourceMovementId: null },
      { sourceMovementId: 'sm-batch' },
      { sourceMovementId: 'sm-batch' },
    ]);
    expect(ctx.itemMap.get('beras')?.name).toBe('Beras');
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

  it('rejects lines on one batch that ask for more than it holds, summed', async () => {
    const twoLines = body({
      inputs: [
        { itemId: 'gkp', quantity: 400, sourceMovementId: 'sm-batch' },
        { itemId: 'gkp', quantity: 300, sourceMovementId: 'sm-batch' },
      ],
    });
    await expect(loadProductionCostContext(txWith(), twoLines, opts)).rejects.toMatchObject({
      code: PRODUCTION_BATCH_QTY_INSUFFICIENT,
      message: 'Sisa batch SM-sm-batch (input ke-1) tidak cukup: tersedia 600 Kg, diminta 700 Kg.',
    });
  });

  it('rejects a batch outside the production warehouse unless the edited run already used it', async () => {
    const atB = body({ inputs: [{ itemId: 'gkp', quantity: 500, sourceMovementId: 'sm-batch-b' }] });
    await expect(loadProductionCostContext(txWith(), atB, opts)).rejects.toMatchObject({
      code: PRODUCTION_BATCH_WAREHOUSE,
      message: 'Batch SM-sm-batch-b (input ke-1) tidak berada di gudang produksi A. Pilih batch dari gudang produksi.',
    });
    await expect(loadProductionCostContext(txWith(), atB, { ...opts, keepBatchIds: new Set(['sm-batch-b']) })).resolves.toBeDefined();
  });
});
