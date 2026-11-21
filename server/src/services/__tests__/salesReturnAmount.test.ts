import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { returnLineAmount, returnLineValue, returnTotal } from '../salesReturnSubmit';

describe('sales return amount', () => {
  it('prices a line from the invoice rate less the line discount', () => {
    expect(returnLineAmount(50, 16_000, 0)).toBe(800_000);
    expect(returnLineAmount(3, 10_000, 12.5)).toBe(26_250);
  });

  it('adds line tax to the total', () => {
    expect(returnTotal([{ amount: 800_000, taxPct: 0 }, { amount: 100_000, taxPct: 11 }])).toBe(911_000);
  });

  it('rounds each line, then tax once, then the total (posting order)', () => {
    const lines = [
      { amount: returnLineAmount(1.333, 9_999, 7.5), taxPct: 11 },
      { amount: returnLineAmount(2.5, 3_333.33, 0), taxPct: 0 },
    ];
    expect(lines.map((l) => l.amount)).toEqual([12_329.02, 8_333.33]);
    expect(returnTotal(lines)).toBe(22_018.54);
  });

  it('is zero for qty-only returns of consigned goods', () => {
    expect(returnTotal([{ amount: returnLineAmount(10, 0, 0), taxPct: 0 }])).toBe(0);
  });
});

describe('sales return value from the delivery note (E3-R7)', () => {
  const none = { quantity: new Decimal(0), value: new Decimal(0) };
  const note = { quantity: 3, value: '10000.00' };

  it('takes the proportional share of the note value, the last return the rest', () => {
    expect(returnLineValue(1, note, none).toFixed(2)).toBe('3333.33');
    expect(returnLineValue(1, note, { quantity: new Decimal(1), value: new Decimal('3333.33') }).toFixed(2)).toBe('3333.33');
    expect(returnLineValue(1, note, { quantity: new Decimal(2), value: new Decimal('6666.66') }).toFixed(2)).toBe('3333.34');
    expect(returnLineValue(3, note, none).toFixed(2)).toBe('10000.00');
  });

  it('never takes back more than earlier returns left of the note value', () => {
    // 2/3 of 100 is 66,67; only 50 is left.
    expect(returnLineValue(2, { quantity: 3, value: 100 }, { quantity: new Decimal('0.5'), value: new Decimal(50) }).toFixed(2)).toBe('50.00');
    expect(returnLineValue(1, note, { quantity: new Decimal(1), value: new Decimal('10000.00') }).toFixed(2)).toBe('0.00');
  });

  it('is 0 for a note that moved no quantity', () => {
    expect(returnLineValue(1, { quantity: 0, value: 0 }, none).toFixed(2)).toBe('0.00');
  });
});
