import { describe, it, expect } from 'vitest';
import { MANUAL_IN_ZERO_COST, manualMovementValue } from '../manualMovement';

describe('manualMovementValue', () => {
  it('stores an inbound body cost at UNIT_COST_DP and values the row from the stored cost', () => {
    const { unitCost, totalValue } = manualMovementValue('In', 1_000_000, 1.0000005, 0);
    expect(unitCost.toFixed()).toBe('1.000001');
    expect(totalValue.toFixed(2)).toBe('1000001.00');
  });

  it('refuses an inbound cost that rounds to 0 at UNIT_COST_DP', () => {
    expect(() => manualMovementValue('AdjustmentIn', 10, 0.0000004, 0)).toThrow(
      expect.objectContaining({ code: MANUAL_IN_ZERO_COST }),
    );
  });

  it('values an outbound row at the average and ignores the body cost', () => {
    const { unitCost, totalValue } = manualMovementValue('Out', 3, 999, '1.333333');
    expect(unitCost.toFixed()).toBe('1.333333');
    expect(totalValue.toFixed(2)).toBe('4.00');
  });
});
