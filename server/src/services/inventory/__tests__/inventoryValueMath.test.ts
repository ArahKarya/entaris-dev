import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { BusinessError } from '../../../utils/errors';
import {
  INVENTORY_VALUE_NEGATIVE,
  UNIT_COST_DP,
  VALUE_DP,
  averageAfter,
  invariantTolerance,
  negativeSettlement,
  outboundValue,
  revaluationSplit,
  revisedOutboundValue,
} from '../inventoryValueMath';

const str = (v: Decimal) => v.toFixed(2);

describe('inventoryValueMath scales', () => {
  it('stores unit costs at 6 dp and values at 2 dp', () => {
    expect(UNIT_COST_DP).toBe(6);
    expect(VALUE_DP).toBe(2);
  });
});

describe('outboundValue', () => {
  it('values the part past zero at the average: 100 @10.000 out 150 -> 1.500.000', () => {
    expect(str(outboundValue(100, 1_000_000, 10_000, 150))).toBe('1500000.00');
  });

  it('takes the whole remaining value when stock reaches 0 (no cent left behind)', () => {
    // 30.000 @5.000 + 60.000 @5.001: avg 5000.666667 would give 450.060.000,03 on qty x avg.
    expect(str(outboundValue(90_000, 450_060_000, '5000.666667', 90_000))).toBe('450060000.00');
    expect(str(outboundValue(3, '100.00', '33.333333', 3))).toBe('100.00');
  });

  it('takes the proportional share of the value while stock stays above 0', () => {
    expect(str(outboundValue(90_000, 450_060_000, '5000.666667', 30_000))).toBe('150020000.00');
    expect(str(outboundValue(3, '100.00', '33.333333', 1))).toBe('33.33');
  });

  it('values at the average in the negative-stock window', () => {
    expect(str(outboundValue(0, 0, 5_000, 10))).toBe('50000.00');
    expect(str(outboundValue(-5, '-25000.00', 5_000, 10))).toBe('50000.00');
    expect(str(outboundValue(0, 0, '1234.567891', 3))).toBe('3703.70');
  });

  it('refuses a negative value with stock on hand (INVENTORY_VALUE_NEGATIVE)', () => {
    let caught: unknown;
    try {
      outboundValue(10, '-0.01', 5_000, 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BusinessError);
    expect((caught as BusinessError).code).toBe(INVENTORY_VALUE_NEGATIVE);
    expect((caught as BusinessError).status).toBe(400);
  });

  it('allows a zero value with stock on hand (legacy zero-cost rows), valued at 0', () => {
    expect(str(outboundValue(10, 0, 0, 4))).toBe('0.00');
  });
});

describe('revisedOutboundValue', () => {
  const book = { stock: 880, stockValue: '9680000.00', avg: 11_000 };

  it('keeps the old value when the quantity does not change, whatever the average is now', () => {
    expect(str(revisedOutboundValue({ qty: 100, value: '1000000.00' }, 100, book))).toBe('1000000.00');
  });

  it('hands a lower quantity back at the row\'s own unit value', () => {
    expect(str(revisedOutboundValue({ qty: 100, value: '1000000.00' }, 80, book))).toBe('800000.00');
    // 100.00 over 3 units: one unit back is round(33.333.., 2) = 33.33, the row keeps 66.67.
    expect(str(revisedOutboundValue({ qty: 3, value: '100.00' }, 2, book))).toBe('66.67');
  });

  it('values only the extra quantity from the book now', () => {
    // 100 @10.000 kept, 20 more at round(9.680.000 x 20 / 880, 2) = 220.000.
    expect(str(revisedOutboundValue({ qty: 100, value: '1000000.00' }, 120, book))).toBe('1220000.00');
    // Past zero stock the extra is valued at the average (outboundValue).
    expect(str(revisedOutboundValue({ qty: 100, value: '1000000.00' }, 150, { stock: 10, stockValue: '110000.00', avg: 11_000 })))
      .toBe('1550000.00');
  });
});

describe('revaluationSplit', () => {
  it('sends everything to COGS when no stock is left', () => {
    const { toInventory, toCogs } = revaluationSplit(0, 0, 100_000);
    expect(str(toInventory)).toBe('0.00');
    expect(str(toCogs)).toBe('100000.00');
    const neg = revaluationSplit(-3, '-15000.00', '-2500.00');
    expect(str(neg.toInventory)).toBe('0.00');
    expect(str(neg.toCogs)).toBe('-2500.00');
  });

  it('takes inventory down to 0 and sends the rest of a larger decrease to COGS', () => {
    const { toInventory, toCogs } = revaluationSplit(10, 30_000, -50_000);
    expect(str(toInventory)).toBe('-30000.00');
    expect(str(toCogs)).toBe('-20000.00');
    expect(toInventory.plus(toCogs).toFixed(2)).toBe('-50000.00');
  });

  it('keeps a change stock can absorb in inventory', () => {
    expect(revaluationSplit(10, 30_000, 5_000)).toEqual({ toInventory: new Decimal(5_000), toCogs: new Decimal(0) });
    expect(revaluationSplit(10, 30_000, -30_000)).toEqual({ toInventory: new Decimal(-30_000), toCogs: new Decimal(0) });
  });

  it('refuses a negative value with stock on hand, like outboundValue: a decrease would raise it', () => {
    let caught: unknown;
    try {
      revaluationSplit(10, -200_000, -50_000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BusinessError);
    expect((caught as BusinessError).code).toBe(INVENTORY_VALUE_NEGATIVE);
    expect(() => revaluationSplit(10, -200_000, 50_000)).toThrow(BusinessError);
    // No stock: a negative value is the negative-stock window, not a broken book.
    expect(str(revaluationSplit(-3, '-15000.00', -100).toCogs)).toBe('-100.00');
  });
});

describe('averageAfter', () => {
  it('is stock_value / stock at 6 dp', () => {
    expect(averageAfter(90_000, 450_060_000, 0).toFixed(6)).toBe('5000.666667');
  });

  it('keeps the previous average when stock is 0 or below', () => {
    expect(averageAfter(0, 0, '5000.666667').toFixed(6)).toBe('5000.666667');
    expect(averageAfter(-2, '-10000.00', 5_000).toFixed(6)).toBe('5000.000000');
  });
});

describe('invariantTolerance', () => {
  it('is 0.01 for small stock and grows with quantity', () => {
    expect(invariantTolerance(100).toString()).toBe('0.01');
    expect(invariantTolerance(20_000).toString()).toBe('0.01');
    expect(invariantTolerance(31_990).toString()).toBe('0.015995');
    expect(invariantTolerance(-40_000).toString()).toBe('0.02');
  });
});

describe('negativeSettlement (E3-R9)', () => {
  it('PRD: stock −100 at −1.000.000, in 300 @12.000 -> −200.000 (DR COGS)', () => {
    expect(str(negativeSettlement(-100, -1_000_000, 300, 3_600_000))).toBe('-200000.00');
  });

  it('crossing zero: −50 at −500.000 (sold at 10.000), in 100 @12.000 -> −100.000 = 50 x 2.000', () => {
    expect(str(negativeSettlement(-50, -500_000, 100, 1_200_000))).toBe('-100000.00');
  });

  it('a partial cover settles only the covered share of the book', () => {
    expect(str(negativeSettlement(-100, -1_000_000, 40, 480_000))).toBe('-80000.00');
  });

  it('a cheaper inbound gives a positive change (CR COGS)', () => {
    expect(str(negativeSettlement(-10, -100_000, 10, 80_000))).toBe('20000.00');
  });

  it('a full cover takes the whole book, so stock reaching 0 holds no value', () => {
    // −3 at −10,00: 3 of 3 at 4,00 each -> −(12,00 − 10,00).
    expect(str(negativeSettlement(-3, '-10.00', 3, '12.00'))).toBe('-2.00');
    expect(str(negativeSettlement(-3, '-10.00', 5, '20.00'))).toBe('-2.00');
  });

  it('is 0 when stock is not below 0', () => {
    expect(str(negativeSettlement(0, 0, 10, 100))).toBe('0.00');
    expect(str(negativeSettlement(5, 50, 10, 100))).toBe('0.00');
  });
});
