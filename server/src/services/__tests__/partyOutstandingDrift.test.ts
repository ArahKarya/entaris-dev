import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildDriftRows, type DriftSums } from '../partyOutstandingDrift';

const D = (v: number) => new Prisma.Decimal(v);
const sums = (s: Partial<Record<keyof DriftSums, Record<string, number>>>): DriftSums => {
  const m = (r?: Record<string, number>) => new Map(Object.entries(r ?? {}).map(([k, v]) => [k, D(v)]));
  return {
    salesOutstanding: m(s.salesOutstanding), purchaseOutstanding: m(s.purchaseOutstanding), arLedger: m(s.arLedger), apLedger: m(s.apLedger),
    arManual: m(s.arManual), apManual: m(s.apManual),
  };
};
const party = (id: string, partyType: string, outstandingAmount: number, openingOutstanding: number) => ({ id, name: id, partyType, outstandingAmount, openingOutstanding });

describe('buildDriftRows', () => {
  it('flags a customer whose 25 jt opening balance was wiped by the old recalculation', () => {
    const rows = buildDriftRows([party('c1', 'Customer', 0, 25_000_000)], sums({ arLedger: { c1: 25_000_000 } }));
    expect(rows).toEqual([
      expect.objectContaining({ partyId: 'c1', stored: '0.00', expected: '25000000.00', ledger: '25000000.00', storedMinusExpected: '-25000000.00', expectedMinusLedger: '0.00' }),
    ]);
  });

  it('skips parties that agree on all three amounts', () => {
    const rows = buildDriftRows(
      [party('c1', 'Customer', 1_500_000, 500_000), party('s1', 'Supplier', 200_000, 0)],
      sums({ salesOutstanding: { c1: 1_000_000 }, arLedger: { c1: 1_500_000 }, purchaseOutstanding: { s1: 200_000 }, apLedger: { s1: 200_000 } }),
    );
    expect(rows).toEqual([]);
  });

  it('counts only the side of the party type, and both sides for Both', () => {
    const rows = buildDriftRows(
      [party('c1', 'Customer', 100, 0), party('b1', 'Both', 300, 0)],
      // c1 has a stray purchase sum that must be ignored; b1 adds sales and purchase.
      sums({ salesOutstanding: { c1: 100, b1: 100 }, purchaseOutstanding: { c1: 999, b1: 200 }, arLedger: { c1: 100, b1: 100 }, apLedger: { b1: 150 } }),
    );
    expect(rows).toEqual([expect.objectContaining({ partyId: 'b1', stored: '300.00', expected: '300.00', ledger: '250.00', expectedMinusLedger: '50.00' })]);
  });

  it('adds the manual party adjustment like recalcPartyOutstanding: AR for a Customer, AP for a Supplier, none for Both', () => {
    const rows = buildDriftRows(
      [party('c1', 'Customer', 5_000_000, 0), party('s1', 'Supplier', 300, 0), party('b1', 'Both', 0, 0)],
      sums({ arManual: { c1: 5_000_000, b1: 70 }, arLedger: { c1: 5_000_000, b1: 70 }, apManual: { s1: 300 }, apLedger: { s1: 300 } }),
    );
    expect(rows).toEqual([expect.objectContaining({ partyId: 'b1', stored: '0.00', expected: '0.00', ledger: '70.00' })]);
  });
});
