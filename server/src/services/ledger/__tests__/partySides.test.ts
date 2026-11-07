import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { adjustPartyOpening, computePartySides, legacyUnassignedOf, type PartySideInput } from '../partySides';

const JT = 1_000_000;
const input = (i: Partial<PartySideInput> & Pick<PartySideInput, 'partyType'>): PartySideInput => ({
  openingReceivable: 0, openingPayable: 0, legacyUnassigned: 0, siOutstanding: 0, piOutstanding: 0, adjAr: 0, adjAp: 0, ...i,
});
const fixed = (s: ReturnType<typeof computePartySides>) => ({
  receivable: s.receivable.toFixed(2), payable: s.payable.toFixed(2), outstanding: s.outstanding.toFixed(2),
});

describe('computePartySides', () => {
  it('Customer: opening receivable + sales invoices + AR adjustment; purchase side ignored', () => {
    const s = computePartySides(input({ partyType: 'Customer', openingReceivable: 50 * JT, siOutstanding: 10 * JT, adjAr: 2 * JT, piOutstanding: 7 * JT, adjAp: 1 }));
    expect(fixed(s)).toEqual({ receivable: '62000000.00', payable: '0.00', outstanding: '62000000.00' });
  });

  it('Supplier: opening payable + purchase invoices + AP adjustment; sales side ignored', () => {
    const s = computePartySides(input({ partyType: 'Supplier', openingPayable: 5 * JT, piOutstanding: 3 * JT, adjAp: -JT, siOutstanding: 9 * JT, adjAr: 4 }));
    expect(fixed(s)).toEqual({ receivable: '0.00', payable: '7000000.00', outstanding: '7000000.00' });
  });

  it('Both: payable 30 jt and receivable 20 jt stay apart', () => {
    const s = computePartySides(input({ partyType: 'Both', openingPayable: 10 * JT, piOutstanding: 20 * JT, openingReceivable: 5 * JT, siOutstanding: 15 * JT }));
    expect(fixed(s)).toEqual({ receivable: '20000000.00', payable: '30000000.00', outstanding: '50000000.00' });
  });

  it('Both gets the manual adjustment on each side', () => {
    const s = computePartySides(input({ partyType: 'Both', adjAr: 70, adjAp: 30 }));
    expect(fixed(s)).toEqual({ receivable: '70.00', payable: '30.00', outstanding: '100.00' });
  });

  it('an undirected positive opening counts on the receivable side of a Customer or Both, the payable side of a Supplier', () => {
    expect(fixed(computePartySides(input({ partyType: 'Customer', legacyUnassigned: 25 * JT })))).toMatchObject({ receivable: '25000000.00', payable: '0.00' });
    expect(fixed(computePartySides(input({ partyType: 'Both', legacyUnassigned: 25 * JT })))).toMatchObject({ receivable: '25000000.00', payable: '0.00' });
    expect(fixed(computePartySides(input({ partyType: 'Supplier', legacyUnassigned: 25 * JT })))).toMatchObject({ receivable: '0.00', payable: '25000000.00' });
  });

  it('a negative undirected opening (old import, or a payment remainder after the split) lowers that side', () => {
    // Directed 50 jt, then a payment remainder of 10 jt took opening_outstanding down to 40 jt alone.
    const legacy = legacyUnassignedOf({ openingOutstanding: new Prisma.Decimal(40 * JT), openingReceivable: new Prisma.Decimal(50 * JT), openingPayable: new Prisma.Decimal(0) });
    expect(legacy.toFixed(2)).toBe('-10000000.00');
    expect(fixed(computePartySides(input({ partyType: 'Customer', openingReceivable: 50 * JT, legacyUnassigned: legacy })))).toMatchObject({ receivable: '40000000.00' });
    expect(fixed(computePartySides(input({ partyType: 'Supplier', legacyUnassigned: -300 })))).toMatchObject({ payable: '-300.00' });
  });

  it('with both side columns still zero the whole opening_outstanding is the fallback (nothing dropped)', () => {
    const legacy = legacyUnassignedOf({ openingOutstanding: new Prisma.Decimal(1234.56), openingReceivable: new Prisma.Decimal(0), openingPayable: new Prisma.Decimal(0) });
    expect(fixed(computePartySides(input({ partyType: 'Customer', legacyUnassigned: legacy, siOutstanding: 100 })))).toEqual({
      receivable: '1334.56', payable: '0.00', outstanding: '1334.56',
    });
  });

  it('an opening on a side the type does not have stays on that side instead of vanishing', () => {
    const s = computePartySides(input({ partyType: 'Customer', openingPayable: 500, siOutstanding: 100 }));
    expect(fixed(s)).toEqual({ receivable: '100.00', payable: '500.00', outstanding: '600.00' });
  });

  it('keeps cents exact (Decimal, no float)', () => {
    const s = computePartySides(input({ partyType: 'Customer', openingReceivable: '0.10', siOutstanding: '0.20' }));
    expect(s.receivable.toFixed(2)).toBe('0.30');
  });
});

describe('adjustPartyOpening', () => {
  const tx = (change: string | null) => ({ $queryRaw: vi.fn().mockResolvedValue(change === null ? [] : [{ change }]) });

  it('does nothing for a zero delta', async () => {
    const t = tx('0');
    expect((await adjustPartyOpening(t as any, 'p1', 'RECEIVABLE', 0)).toFixed(2)).toBe('0.00');
    expect(t.$queryRaw).not.toHaveBeenCalled();
  });

  it('a reduction is capped at what the side holds and moves opening_outstanding with it', async () => {
    const t = tx('-400.00');
    expect((await adjustPartyOpening(t as any, 'p1', 'RECEIVABLE', -1000)).toFixed(2)).toBe('-400.00');
    const [strings, ...values] = t.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...values);
    expect(sql.sql).toContain('FOR UPDATE');
    expect(sql.sql).toContain('LEAST(GREATEST(cur.v, 0)');
    expect(sql.sql).toContain('opening_receivable');
    expect(sql.sql).toContain('opening_outstanding = p.opening_outstanding');
    expect(sql.values).toContain('1000.00');
  });

  it('a restore adds to the payable side', async () => {
    const t = tx('250.00');
    expect((await adjustPartyOpening(t as any, 'p1', 'PAYABLE', 250)).toFixed(2)).toBe('250.00');
    const [strings, ...values] = t.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...values);
    expect(sql.sql).toContain('opening_payable');
    expect(sql.sql).not.toContain('LEAST');
  });

  it('an unknown party changes nothing', async () => {
    expect((await adjustPartyOpening(tx(null) as any, 'missing', 'PAYABLE', -5)).toFixed(2)).toBe('0.00');
  });
});
