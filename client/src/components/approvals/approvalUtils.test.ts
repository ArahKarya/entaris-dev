import { describe, expect, it } from 'vitest';
import { piLineTotal, piTotals, prodCostSummary, resolvePiTotals } from './approval-utils';

describe('piLineTotal', () => {
  it('uses timbanganDiterima when it is above zero, else quantity', () => {
    expect(piLineTotal({ quantity: 1, timbanganDiterima: 1000, rate: 6500 })).toBe(6_500_000);
    expect(piLineTotal({ quantity: 1000, timbanganDiterima: 0, rate: 6500 })).toBe(6_500_000);
  });

  it('rounds each step to 2 decimals like the server and deducts potonganItem', () => {
    expect(piLineTotal({ quantity: 33.333, rate: 1.005 })).toBe(33.5);
    expect(piLineTotal({ quantity: 1000, rate: 6500, taxPct: 11, pphPct: 0.5, potonganItem: 100_000 })).toBe(7_082_500);
  });
});

describe('piTotals', () => {
  it('grand total = Σ line totals + biayaLain; the header potongan is not subtracted again', () => {
    const payload = {
      potongan: 100_000,
      biayaLain: -50_000,
      items: [
        { quantity: 1000, rate: 6500, potonganItem: 100_000 },
        { quantity: 1, rate: 3_600_000 },
      ],
    };
    expect(piTotals(payload)).toEqual({ subtotal: 10_000_000, potonganItem: 100_000, biayaLain: -50_000, grandTotal: 9_950_000 });
  });

  it('is zero for an empty payload', () => {
    expect(piTotals(undefined)).toEqual({ subtotal: 0, potonganItem: 0, biayaLain: 0, grandTotal: 0 });
  });
});

describe('resolvePiTotals', () => {
  const payload = { items: [{ quantity: 1, rate: 1000 }] };

  it('prefers the totals the server computed', () => {
    const server = { subtotal: 5, potonganItem: 0, biayaLain: 0, grandTotal: 5, headerPotonganMismatch: true };
    expect(resolvePiTotals({ piTotals: server }, payload)).toEqual(server);
  });

  it('falls back to the local estimate while the context loads or when the server sends none', () => {
    const local = { subtotal: 1000, potonganItem: 0, biayaLain: 0, grandTotal: 1000, headerPotonganMismatch: false };
    expect(resolvePiTotals(undefined, payload)).toEqual(local);
    expect(resolvePiTotals({ piTotals: null }, payload)).toEqual(local);
  });
});

describe('prodCostSummary', () => {
  it('sums conversion costs and by-product value; a batchUnitCost in the payload values nothing', () => {
    const payload = {
      inputs: [{ itemId: 'gkp', quantity: 5000, sourceMovementId: 'b1', batchUnitCost: 7000 }],
      outputs: [{ itemId: 'beras', quantity: 3000 }, { itemId: 'bekatul', quantity: 200, unitPrice: 2000, isByProduct: true }],
      costs: [{ basis: 'InputQty', rate: 300 }, { basis: 'OutputQty', rate: 100 }, { basis: 'Fixed', rate: 50_000 }],
    };
    expect(prodCostSummary(payload)).toEqual({ byproductValue: 400_000, costTotal: 1_850_000, mainQty: 3000 });
  });
});
