import { describe, expect, it } from 'vitest';
import { buildProductionRunLineItems, dropBackfilledOutputPrices, type OldOutputLine } from '../productionRunLines';

describe('buildProductionRunLineItems', () => {
  const base = {
    runId: 'run-1',
    warehouseId: 'wh-prod',
    inputs: [{ itemId: 'gkp', quantity: 1000 }],
    outputs: [
      { itemId: 'beras', quantity: 600 },
      { itemId: 'dedak', quantity: 100, isByProduct: true },
    ],
    batchSnapshots: [{ sourceMovementId: 'sm-batch', batchUnitCost: 6000 }],
    outputCosting: [
      { persistedUnitPrice: 9500, priceIsManual: true, yieldPct: 60 },
      { persistedUnitPrice: 1500, priceIsManual: false, yieldPct: null },
    ],
  };

  it('stamps the production warehouse on every input and output line', () => {
    const lines = buildProductionRunLineItems(base);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.warehouseId === 'wh-prod')).toBe(true);
    expect(lines.every((l) => l.productionRunId === 'run-1')).toBe(true);
  });

  it('keeps batch, yield and resolved price semantics', () => {
    const [input, main, byProduct] = buildProductionRunLineItems(base);
    expect(input).toMatchObject({ lineType: 'Input', sourceMovementId: 'sm-batch', batchUnitCost: 6000, unitPrice: null });
    expect(main).toMatchObject({ lineType: 'Output', unitPrice: 9500, yieldPct: 60, isByProduct: false });
    expect(byProduct).toMatchObject({ lineType: 'ByProduct', unitPrice: 1500, yieldPct: null, isByProduct: true });
  });

  it('falls back to an empty batch snapshot for unpicked inputs', () => {
    const [input] = buildProductionRunLineItems({ ...base, batchSnapshots: [] });
    expect(input).toMatchObject({ sourceMovementId: null, batchUnitCost: null });
  });
});

describe('buildProductionRunLineItems price_is_manual', () => {
  it('flags typed main output prices only, never by-products', () => {
    const lines = buildProductionRunLineItems({
      runId: 'r', warehouseId: 'w', inputs: [], batchSnapshots: [],
      outputs: [{ itemId: 'a', quantity: 1 }, { itemId: 'b', quantity: 1 }, { itemId: 'c', quantity: 1, isByProduct: true }],
      outputCosting: [
        { persistedUnitPrice: 5, priceIsManual: true, yieldPct: 10 },
        { persistedUnitPrice: 7, priceIsManual: false, yieldPct: 10 },
        { persistedUnitPrice: 20, priceIsManual: true, yieldPct: null },
      ],
    });
    expect(lines.map((l) => (l as { priceIsManual: boolean }).priceIsManual)).toEqual([true, false, false]);
  });
});

describe('dropBackfilledOutputPrices', () => {
  const old = (itemId: string, unitPrice: number | null, priceIsManual = false): OldOutputLine =>
    ({ itemId, lineType: 'Output', isByProduct: false, unitPrice, priceIsManual });

  it('drops a price equal to the old HPP on a non-manual line (within 0.005)', () => {
    const out = dropBackfilledOutputPrices([{ itemId: 'a', unitPrice: 10166.67 }], [old('a', 10166.67)], 10166.6667);
    expect(out[0]!.unitPrice).toBeNull();
  });

  it('drops a price sitting exactly a half cent from the old HPP (no float drift)', () => {
    expect(dropBackfilledOutputPrices([{ itemId: 'a', unitPrice: 11000.01 }], [old('a', 11000.01)], 11000.005)[0]!.unitPrice).toBeNull();
    expect(dropBackfilledOutputPrices([{ itemId: 'a', unitPrice: 6000.13 }], [old('a', 6000.13)], 6000.125)[0]!.unitPrice).toBeNull();
  });

  it('keeps a typed line, a different price and a by-product', () => {
    const out = dropBackfilledOutputPrices(
      [{ itemId: 'a', unitPrice: 10166.67 }, { itemId: 'b', unitPrice: 9000 }, { itemId: 'c', unitPrice: 10166.67, isByProduct: true }],
      [old('a', 10166.67, true), old('b', 10166.67)],
      10166.6667,
    );
    expect(out.map((o) => o.unitPrice)).toEqual([10166.67, 9000, 10166.67]);
  });

  it('matches several main outputs of one item by order', () => {
    const out = dropBackfilledOutputPrices(
      [{ itemId: 'a', unitPrice: 100 }, { itemId: 'a', unitPrice: 100 }],
      [old('a', 100, false), old('a', 100, true)],
      100,
    );
    expect(out.map((o) => o.unitPrice)).toEqual([null, 100]);
  });

  it('does nothing without an old HPP or a matching old line', () => {
    expect(dropBackfilledOutputPrices([{ itemId: 'a', unitPrice: 5 }], [old('a', 5)], null)[0]!.unitPrice).toBe(5);
    expect(dropBackfilledOutputPrices([{ itemId: 'z', unitPrice: 5 }], [old('a', 5)], 5)[0]!.unitPrice).toBe(5);
  });
});
