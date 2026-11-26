import { describe, expect, it } from 'vitest';
import { runLineUnitCost } from './run-pdf-props';

describe('runLineUnitCost', () => {
  it('prices an input at the ledger cost stored in unit_price, not the batch snapshot', () => {
    expect(runLineUnitCost({ unitPrice: '6000.000000', batchUnitCost: '7000.000000', item: { averageCost: '6500' } })).toBe(6000);
  });

  it('falls back to the batch snapshot for a run posted before the value ledger, then to the average', () => {
    expect(runLineUnitCost({ unitPrice: null, batchUnitCost: '7000', item: { averageCost: '6500' } })).toBe(7000);
    expect(runLineUnitCost({ unitPrice: null, batchUnitCost: null, item: { averageCost: '6500' } })).toBe(6500);
    expect(runLineUnitCost({})).toBe(0);
  });
});
