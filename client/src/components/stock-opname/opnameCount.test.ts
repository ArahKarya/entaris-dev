import { describe, it, expect } from 'vitest';
import { buildSubmitLines, findStaleLines, parseCount } from './opnameCount';

const rows = [
  { itemId: 'a', code: 'A', name: 'A', unit: 'Kg', systemStock: 10000 },
  { itemId: 'b', code: 'B', name: 'B', unit: 'Kg', systemStock: 500 },
];

describe('opnameCount', () => {
  it('parseCount: blank or not a number is an untouched line; 0 is a count', () => {
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount('  ')).toBeNull();
    expect(parseCount('abc')).toBeNull();
    expect(parseCount('0')).toBe(0);
    expect(parseCount('12.5')).toBe(12.5);
  });

  it('buildSubmitLines sends only filled-in lines with the shown system stock', () => {
    expect(buildSubmitLines(rows, { b: '480', a: '' })).toEqual([{ itemId: 'b', actualStock: 480, expectedSystemStock: 500 }]);
  });

  it('findStaleLines flags filled-in lines that moved beyond the 0.0005 tolerance', () => {
    const fresh = [{ ...rows[0], systemStock: 8000 }, { ...rows[1], systemStock: 500.0004 }];
    expect(findStaleLines(rows, fresh, { a: '9990', b: '480' })).toEqual({ a: { expectedSystemStock: 10000, systemStock: 8000 } });
    // An untouched line that moved is not sent, so it is not flagged.
    expect(findStaleLines(rows, fresh, { b: '480' })).toEqual({});
    // A line that disappeared from the answer is a stock of 0.
    expect(findStaleLines(rows, [rows[0]], { b: '480' })).toEqual({ b: { expectedSystemStock: 500, systemStock: 0 } });
  });
});
