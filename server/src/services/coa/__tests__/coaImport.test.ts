// The COA import parser reads the opening balance as an exact decimal (E2-R12): at most 2
// decimals, no thousands separators, no exponent; negative stays valid (contra balance); a blank
// cell means "leave the opening balance as it is", not zero.
import { describe, expect, it } from 'vitest';
import { parseCoaRows } from '../coaImport';

const sanitize = (v: string) => v;
const row = (over: Record<string, string>) => ({ accountNumber: '1.1.1', name: 'Kas', rootType: 'ASSET', ...over });

function parseOne(over: Record<string, string>, numeric: Record<string, boolean> = {}) {
  return parseCoaRows([row(over)], sanitize, [numeric]);
}

describe('parseCoaRows opening balance', () => {
  it('keeps the text amount exactly, as a decimal string', () => {
    const { parsed, errors } = parseOne({ openingBalance: '1234567890123.45' });
    expect(errors).toEqual([]);
    expect(parsed[0].openingBalance).toBe('1234567890123.45');
  });

  it('accepts a negative (contra) balance', () => {
    expect(parseOne({ openingBalance: '-2500000' }).parsed[0].openingBalance).toBe('-2500000');
  });

  it('reads a blank cell as null (no change), not zero', () => {
    expect(parseOne({ openingBalance: '' }).parsed[0].openingBalance).toBeNull();
    expect(parseOne({}).parsed[0].openingBalance).toBeNull();
    expect(parseOne({ openingBalance: '0' }).parsed[0].openingBalance).toBe('0');
  });

  it.each(['500000.123', '1e6', '5.000.000', '5,000,000', '1.000,50', 'abc', '12 000'])('refuses %s', (text) => {
    const { parsed, errors } = parseOne({ openingBalance: text });
    expect(parsed).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(2);
    expect(errors[0].message).toContain('openingBalance');
  });

  it('rounds a number cell float to 2 decimals and refuses a real third decimal', () => {
    expect(parseOne({ openingBalance: '110000.00000000001' }, { openingBalance: true }).parsed[0].openingBalance).toBe('110000.00');
    expect(parseOne({ openingBalance: '110000.005' }, { openingBalance: true }).errors).toHaveLength(1);
  });

  it('reads the aliases saldoAwal / opening_balance, never the running "balance" column', () => {
    expect(parseOne({ saldoAwal: '100' }).parsed[0].openingBalance).toBe('100');
    expect(parseOne({ opening_balance: '200' }).parsed[0].openingBalance).toBe('200');
    expect(parseOne({ balance: '300' }).parsed[0].openingBalance).toBeNull();
    expect(parseOne({ outstandingAmount: '300' }).parsed[0].openingBalance).toBeNull();
  });

  it('reads an optional openingDate; blank means the cut-over date', () => {
    expect(parseOne({ openingBalance: '1', openingDate: '2026-01-01' }).parsed[0].openingDate).toBe('2026-01-01');
    expect(parseOne({ openingBalance: '1', openingDate: '01/02/2026' }).parsed[0].openingDate).toBe('2026-02-01');
    expect(parseOne({ openingBalance: '1' }).parsed[0].openingDate).toBeNull();
    expect(parseOne({ openingBalance: '1', openingDate: '2026-02-30' }).errors[0].message).toContain('openingDate');
  });
});
