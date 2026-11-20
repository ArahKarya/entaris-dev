import { describe, expect, it } from 'vitest';
import {
  formatQty,
  isInbound,
  isProductionLinkedMovement,
  isValueOnly,
  MOVEMENT_TYPES,
  itemStockStatus,
  movementCancelBlock,
  movementEditBlock,
  movementTypeLabel,
  referenceTypeLabel,
  splitRunLines,
  toItemExportRows,
} from './inventory-rows';

describe('itemStockStatus', () => {
  it('prefers the server value, else derives out / low / ok', () => {
    expect(itemStockStatus({ currentStock: '0', minimumStock: '0', stockStatus: 'low' })).toBe('low');
    expect(itemStockStatus({ currentStock: '0', minimumStock: '5' })).toBe('out');
    expect(itemStockStatus({ currentStock: '3', minimumStock: '5' })).toBe('low');
    expect(itemStockStatus({ currentStock: '3', minimumStock: '0' })).toBe('ok');
  });
});

describe('movement rules', () => {
  const row = (referenceType: string | null, referenceId: string | null, movementType = 'In', isCancelled = false) =>
    ({ referenceType, referenceId, movementType, isCancelled });

  it('blocks edit and cancel of a movement owned by a document, like the server', () => {
    expect(movementEditBlock(row('GoodsReceipt', 'gr-1'))).toMatch(/STT/);
    expect(movementCancelBlock(row('GoodsReceipt', 'gr-1'))).toMatch(/STT/);
    expect(movementEditBlock(row('ProductionRun', 'pr-1'))).toMatch(/produksi/);
    expect(movementCancelBlock(row('ProductionRun', 'pr-1'))).toMatch(/halaman Produksi/);
    expect(movementCancelBlock(row('StockOpname', 'so-1'))).toMatch(/Stok Opname/);
    expect(movementCancelBlock(row('SalesReturn', 'sr-1'))).toMatch(/retur penjualan/);
    expect(movementCancelBlock(row('SalesInvoice', 'si-1'))).toMatch(/invoice penjualan/);
  });

  it('opens the edit form read-only only for a production row that names its run', () => {
    expect(isProductionLinkedMovement(row('ProductionRun', 'pr-1'))).toBe(true);
    // No referenceId (demo generator, old manual data): the server accepts the edit, so the form is editable.
    expect(movementEditBlock(row('ProductionRun', null))).toBeNull();
    expect(isProductionLinkedMovement(row('ProductionRun', null))).toBe(false);
    expect(isProductionLinkedMovement(null)).toBe(false);
  });

  it('always blocks opening balance, drift repair and transfer rows', () => {
    expect(movementCancelBlock(row('OpeningBalance', null))).toMatch(/Penyesuaian Stok/);
    expect(movementEditBlock(row('OpeningBalance', null))).toMatch(/saldo awal/);
    expect(movementCancelBlock(row('StockDriftRepair', null, 'AdjustmentOut'))).toMatch(/selisih gudang .*Penyesuaian Stok/);
    expect(movementEditBlock(row('StockDriftRepair', null, 'AdjustmentOut'))).toMatch(/selisih gudang/);
    expect(movementCancelBlock(row(null, null, 'TransferOut'))).toMatch(/Transfer Stok/);
    expect(movementEditBlock(row('StockTransfer', 'st-1', 'TransferIn'))).toMatch(/transfer stok/);
  });

  it('leaves manual rows, also those with a typed reference and no document id, open', () => {
    expect(movementEditBlock(row(null, null))).toBeNull();
    expect(movementCancelBlock(row('PurchaseInvoice', null, 'Out'))).toBeNull();
    expect(movementCancelBlock(row(null, null, 'In', true))).not.toBeNull();
  });

  it('labels types, directions and references in Indonesian', () => {
    expect(movementTypeLabel('AdjustmentOut')).toBe('Penyesuaian −');
    expect(isInbound('TransferIn')).toBe(true);
    expect(isInbound('TransferOut')).toBe(false);
    expect(movementTypeLabel('Revaluation')).toBe('Revaluasi Nilai');
    expect(isInbound('Revaluation')).toBe(false);
    expect(isValueOnly('Revaluation')).toBe(true);
    expect(isValueOnly('Out')).toBe(false);
    expect(MOVEMENT_TYPES).toContain('Revaluation');
    expect(referenceTypeLabel('GoodsReceipt')).toBe('STT');
    expect(referenceTypeLabel('Custom')).toBe('Custom');
    expect(referenceTypeLabel(null)).toBe('');
  });
});

describe('helpers', () => {
  it('formats quantities with up to 3 decimals', () => {
    expect(formatQty('1250.5')).toBe('1.250,5');
    expect(formatQty(null)).toBe('—');
  });

  it('splits production lines into inputs and outputs', () => {
    const { inputs, outputs } = splitRunLines({
      items: [
        { id: '1', lineType: 'Input', quantity: 10 },
        { id: '2', lineType: 'Output', quantity: 6 },
        { id: '3', lineType: 'ByProduct', quantity: 2 },
      ],
    });
    expect(inputs.map((l) => l.id)).toEqual(['1']);
    expect(outputs.map((l) => l.id)).toEqual(['2', '3']);
  });

  it('keeps the import-template export shape', () => {
    expect(
      toItemExportRows([{ id: 'x', code: 'A', name: 'B', unit: 'Kg', currentStock: '5', minimumStock: '1', isActive: true }]),
    ).toEqual([
      { code: 'A', name: 'B', unit: 'Kg', category: '', description: '', currentStock: 5, minimumStock: 1, openingQty: '', openingPrice: '' },
    ]);
  });
});
