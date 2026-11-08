import { describe, expect, it } from 'vitest';
import { outstandingLines, sideOutstanding } from './partySides';

describe('sideOutstanding', () => {
  const both = { partyType: 'Both', outstandingAmount: '50000000', receivableOutstanding: '20000000', payableOutstanding: '30000000' };

  it('reads the side column, not the total, for a Both party', () => {
    expect(sideOutstanding(both, 'receivable')).toBe(20_000_000);
    expect(sideOutstanding(both, 'payable')).toBe(30_000_000);
  });

  it('falls back to the total only on the party type own side when the columns are missing', () => {
    expect(sideOutstanding({ partyType: 'Customer', outstandingAmount: 500 }, 'receivable')).toBe(500);
    expect(sideOutstanding({ partyType: 'Customer', outstandingAmount: 500 }, 'payable')).toBe(0);
    expect(sideOutstanding({ partyType: 'Supplier', outstandingAmount: '700' }, 'payable')).toBe(700);
    expect(sideOutstanding({ partyType: 'Both', outstandingAmount: 900 }, 'payable')).toBe(0);
    expect(sideOutstanding(null, 'receivable')).toBe(0);
  });
});

describe('outstandingLines', () => {
  it('shows two lines for Both and one for the other types', () => {
    expect(outstandingLines({ partyType: 'Both', receivableOutstanding: 20, payableOutstanding: 30 })).toEqual([
      { side: 'receivable', value: 20 },
      { side: 'payable', value: 30 },
    ]);
    expect(outstandingLines({ partyType: 'Customer', receivableOutstanding: '-5', payableOutstanding: 0 })).toEqual([
      { side: 'receivable', value: -5 },
    ]);
    expect(outstandingLines({ partyType: 'Supplier', receivableOutstanding: 0, payableOutstanding: 8 })).toEqual([
      { side: 'payable', value: 8 },
    ]);
  });
});
