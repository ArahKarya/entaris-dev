import { describe, expect, it } from 'vitest';
import { computeProductionCosting, type ProductionCostingInput } from '../productionCosting';

// PRD R1: GKP 1.000 kg @6.000, conversion 300/kg on input qty, bekatul 100 kg at NRV 2.000, beras 600 kg.
function r1(overrides: Partial<ProductionCostingInput> = {}): ProductionCostingInput {
  return {
    inputs: [{ quantity: 1000, unitCost: 6000 }],
    outputs: [
      { quantity: 600, unitPrice: null },
      { quantity: 100, unitPrice: 2000, isByProduct: true },
    ],
    costs: [{ description: 'Giling', costSide: 'InputSide', basis: 'InputQty', rate: 300 }],
    hppOverride: null,
    ...overrides,
  };
}

describe('computeProductionCosting', () => {
  it('computes the PRD R1 numbers, back-fills the main price and plans the journal', () => {
    const c = computeProductionCosting(r1());
    expect(c.totalMaterialCost.toNumber()).toBe(6_000_000);
    expect(c.totalCostInputSide.toNumber()).toBe(300_000);
    expect(c.totalCostOutputSide.toNumber()).toBe(0);
    expect(c.totalByproductValue.toNumber()).toBe(200_000);
    expect(c.computedHpp?.toNumber()).toBe(10166.666667);
    expect(c.hppOverridden).toBe(false);
    expect(c.clampedNegativeNumerator).toBe(false);
    expect(c.yieldPct).toBeCloseTo(60, 6);
    expect(c.totalInputQty).toBe(1000);
    expect(c.totalMainOutputQty).toBe(600);
    expect(c.byProductQty).toBe(100);

    expect(c.inputLines).toEqual([{ unitCost: 6000, totalValue: 6_000_000 }]);
    expect(c.outputLines[0]).toEqual({
      // HPP at UNIT_COST_DP: 600 x 10.166,666667 = 6.100.000,0002 -> 6.100.000 (no 0,02 rest as at 4 dp).
      unitCost: 10166.666667, totalValue: 6_100_000, unitCostLoaded: 10166.666667, persistedUnitPrice: 10166.666667, yieldPct: 60,
    });
    expect(c.outputLines[1]).toEqual({
      unitCost: 2000, totalValue: 200_000, unitCostLoaded: 2000, persistedUnitPrice: 2000, yieldPct: null,
    });

    expect(c.resolvedCosts[0]!.qtyBasis.toNumber()).toBe(1000);
    expect(c.resolvedCosts[0]!.totalAmount.toNumber()).toBe(300_000);

    expect(c.journalPlan).toEqual({
      diff: 300_000,
      inputCredits: [{ index: 0, amount: 6_000_000 }],
      outputDebits: [{ index: 0, amount: 6_100_000 }, { index: 1, amount: 200_000 }],
      toConversion: 300_000,
      toCogs: 0,
      loss: 0,
    });
  });

  it('takes an override verbatim; the shortfall is a loss', () => {
    const c = computeProductionCosting(r1({ hppOverride: 9000 }));
    expect(c.computedHpp?.toNumber()).toBe(9000);
    expect(c.hppOverridden).toBe(true);
    expect(c.outputLines[0]).toMatchObject({ unitCost: 9000, totalValue: 5_400_000, unitCostLoaded: 9000, persistedUnitPrice: 9000 });
    expect(c.journalPlan).toMatchObject({ diff: -400_000, toConversion: 0, toCogs: 0, loss: 400_000 });
  });

  it('an override of 0 still counts as overridden', () => {
    const c = computeProductionCosting(r1({ hppOverride: 0 }));
    expect(c.hppOverridden).toBe(true);
    expect(c.computedHpp?.toNumber()).toBe(0);
    expect(c.outputLines[0]).toMatchObject({ unitCost: 0, totalValue: 0, unitCostLoaded: 0, persistedUnitPrice: null });
  });

  it('a typed main price wins; unit_cost_loaded keeps the HPP; the gain above conversion goes to COGS', () => {
    const c = computeProductionCosting(r1({
      outputs: [{ quantity: 600, unitPrice: 11_000 }, { quantity: 100, unitPrice: 2000, isByProduct: true }],
    }));
    expect(c.computedHpp?.toNumber()).toBe(10166.666667);
    expect(c.outputLines[0]).toMatchObject({ unitCost: 11_000, totalValue: 6_600_000, unitCostLoaded: 10166.666667, persistedUnitPrice: 11_000 });
    expect(c.journalPlan).toMatchObject({ diff: 800_000, toConversion: 300_000, toCogs: 500_000, loss: 0 });
  });

  it('a typed main price of 0 is back-filled like an empty one', () => {
    const c = computeProductionCosting(r1({
      outputs: [{ quantity: 600, unitPrice: 0 }, { quantity: 100, unitPrice: 2000, isByProduct: true }],
    }));
    expect(c.outputLines[0]).toMatchObject({ unitCost: 10166.666667, persistedUnitPrice: 10166.666667 });
  });

  it('clamps a negative numerator (NRV above total cost) to 0 and flags it', () => {
    const c = computeProductionCosting({
      inputs: [{ quantity: 100, unitCost: 1000 }],
      outputs: [{ quantity: 60 }, { quantity: 100, unitPrice: 2000, isByProduct: true }],
    });
    expect(c.computedHpp?.toNumber()).toBe(0);
    expect(c.clampedNegativeNumerator).toBe(true);
    expect(c.hppOverridden).toBe(false);
    expect(c.outputLines[0]).toEqual({ unitCost: 0, totalValue: 0, unitCostLoaded: 0, persistedUnitPrice: null, yieldPct: 60 });
    expect(c.journalPlan).toEqual({
      diff: 100_000,
      inputCredits: [{ index: 0, amount: 100_000 }],
      outputDebits: [{ index: 1, amount: 200_000 }],
      toConversion: 0,
      toCogs: 100_000,
      loss: 0,
    });
  });

  it('OutputQty uses the main output qty and Fixed takes the rate as the total', () => {
    const c = computeProductionCosting(r1({
      costs: [
        { description: 'Giling', costSide: 'InputSide', basis: 'OutputQty', rate: 400 },
        { description: 'Kemas', costSide: 'OutputSide', basis: 'Fixed', rate: 500_000 },
      ],
    }));
    expect(c.resolvedCosts.map((r) => [r.qtyBasis.toNumber(), r.totalAmount.toNumber()])).toEqual([[600, 240_000], [1, 500_000]]);
    expect(c.totalCostInputSide.toNumber()).toBe(240_000);
    expect(c.totalCostOutputSide.toNumber()).toBe(500_000);
    // (6.000.000 + 240.000 + 500.000 − 200.000) / 600
    expect(c.computedHpp?.toNumber()).toBe(10900);
    expect(c.journalPlan).toMatchObject({ diff: 740_000, toConversion: 740_000, toCogs: 0 });
  });

  it('zero-cost inputs leave no credit line; the HPP carries the conversion only', () => {
    const c = computeProductionCosting(r1({ inputs: [{ quantity: 1000, unitCost: 0 }] }));
    expect(c.inputLines).toEqual([{ unitCost: 0, totalValue: 0 }]);
    expect(c.totalMaterialCost.toNumber()).toBe(0);
    // (0 + 300.000 − 200.000) / 600
    expect(c.computedHpp?.toNumber()).toBe(166.666667);
    expect(c.journalPlan.inputCredits).toEqual([]);
    expect(c.journalPlan).toMatchObject({ diff: 300_000, toConversion: 300_000, toCogs: 0 });
  });

  it('a run with only by-products has no HPP and no yield', () => {
    const c = computeProductionCosting({
      inputs: [{ quantity: 100, unitCost: 1000 }],
      outputs: [{ quantity: 50, unitPrice: 1500, isByProduct: true }],
    });
    expect(c.computedHpp).toBeNull();
    expect(c.yieldPct).toBe(0);
    expect(c.outputLines[0]).toEqual({ unitCost: 1500, totalValue: 75_000, unitCostLoaded: 1500, persistedUnitPrice: 1500, yieldPct: null });
    expect(c.journalPlan).toMatchObject({ diff: -25_000, loss: 25_000, toConversion: 0, toCogs: 0 });
  });

  it('a balanced run plans no difference lines', () => {
    const c = computeProductionCosting({
      inputs: [{ quantity: 100, unitCost: 1000 }],
      outputs: [{ quantity: 50 }],
    });
    expect(c.computedHpp?.toNumber()).toBe(2000);
    expect(c.journalPlan).toMatchObject({ diff: 0, toConversion: 0, toCogs: 0, loss: 0 });
  });
});
