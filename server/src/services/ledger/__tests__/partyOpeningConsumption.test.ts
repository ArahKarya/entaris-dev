import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  OPENING_ALLOCATION_TYPE,
  consumePartyOpening,
  isOpeningAllocation,
  openingBucketOf,
  paymentOpeningSide,
  planOpeningConsumption,
  restorePartyOpening,
} from '../partyOpeningConsumption';

const plan = (c: Parameters<typeof planOpeningConsumption>[0], side: 'RECEIVABLE' | 'PAYABLE', amount: number) => {
  const p = planOpeningConsumption(c, side, amount);
  return { side: p.side.toFixed(2), unassigned: p.unassigned.toFixed(2) };
};

describe('planOpeningConsumption', () => {
  it('a Customer Receive takes the receivable column, capped at what it holds', () => {
    const c = { partyType: 'Customer' as const, openingReceivable: 50, openingPayable: 0, openingOutstanding: 50 };
    expect(plan(c, 'RECEIVABLE', 10)).toEqual({ side: '10.00', unassigned: '0.00' });
    expect(plan(c, 'RECEIVABLE', 70)).toEqual({ side: '50.00', unassigned: '0.00' });
  });

  it('a Both Pay takes the payable column only, never the receivable opening or the undirected rest', () => {
    const c = { partyType: 'Both' as const, openingReceivable: 30, openingPayable: 5, openingOutstanding: 45 };
    expect(plan(c, 'PAYABLE', 20)).toEqual({ side: '5.00', unassigned: '0.00' });
  });

  it('the undirected rest is taken after the column on the side it counts on', () => {
    const customer = { partyType: 'Customer' as const, openingReceivable: 10, openingPayable: 0, openingOutstanding: 40 };
    expect(plan(customer, 'RECEIVABLE', 25)).toEqual({ side: '10.00', unassigned: '15.00' });
    const supplier = { partyType: 'Supplier' as const, openingReceivable: 0, openingPayable: 0, openingOutstanding: 40 };
    expect(plan(supplier, 'PAYABLE', 50)).toEqual({ side: '0.00', unassigned: '40.00' });
    expect(plan(supplier, 'RECEIVABLE', 50)).toEqual({ side: '0.00', unassigned: '0.00' });
  });

  it('a negative rest (a remainder before PR-5.13) already took part of the column', () => {
    const c = { partyType: 'Customer' as const, openingReceivable: 50, openingPayable: 0, openingOutstanding: 40 };
    expect(plan(c, 'RECEIVABLE', 45)).toEqual({ side: '40.00', unassigned: '0.00' });
    const gone = { partyType: 'Customer' as const, openingReceivable: 10, openingPayable: 0, openingOutstanding: -5 };
    expect(plan(gone, 'RECEIVABLE', 5)).toEqual({ side: '0.00', unassigned: '0.00' });
  });

  it('nothing for a zero or negative amount', () => {
    const c = { partyType: 'Customer' as const, openingReceivable: 50, openingPayable: 0, openingOutstanding: 50 };
    expect(plan(c, 'RECEIVABLE', 0)).toEqual({ side: '0.00', unassigned: '0.00' });
    expect(plan(c, 'RECEIVABLE', -5)).toEqual({ side: '0.00', unassigned: '0.00' });
  });
});

describe('opening allocation types', () => {
  it('maps the three buckets both ways and leaves invoices alone', () => {
    expect(OPENING_ALLOCATION_TYPE).toEqual({ RECEIVABLE: 'OpeningReceivable', PAYABLE: 'OpeningPayable', UNASSIGNED: 'OpeningUnassigned' });
    expect(openingBucketOf('OpeningUnassigned')).toBe('UNASSIGNED');
    expect(openingBucketOf('SalesInvoice')).toBeNull();
    expect(isOpeningAllocation('OpeningPayable')).toBe(true);
    expect(isOpeningAllocation('PurchaseInvoice')).toBe(false);
    expect(paymentOpeningSide('Receive')).toBe('RECEIVABLE');
    expect(paymentOpeningSide('Pay')).toBe('PAYABLE');
  });
});

describe('consumePartyOpening / restorePartyOpening', () => {
  /** $queryRaw: first call the locked row, then one adjustPartyOpening result per bucket. */
  const fakeTx = (row: Record<string, string> | null, changes: string[]) => {
    const queue = [row ? [row] : [], ...changes.map((change) => [{ change }])];
    return {
      $queryRaw: vi.fn().mockImplementation(async () => queue.shift() ?? []),
      paymentAllocation: { create: vi.fn().mockResolvedValue({}) },
    };
  };

  it('records one allocation per bucket for what was actually taken', async () => {
    const tx = fakeTx({ party_type: 'Customer', opening_receivable: '10.00', opening_payable: '0.00', opening_outstanding: '40.00' }, ['-10.00', '-15.00']);
    const taken = await consumePartyOpening(tx as any, 'pay1', 'c1', 'RECEIVABLE', 25);
    expect(taken.toFixed(2)).toBe('25.00');
    expect(tx.paymentAllocation.create.mock.calls.map(([a]) => [a.data.invoiceType, a.data.invoiceId, new Prisma.Decimal(a.data.allocatedAmount).toFixed(2)]))
      .toEqual([['OpeningReceivable', 'c1', '10.00'], ['OpeningUnassigned', 'c1', '15.00']]);
  });

  it('records nothing when the opening is empty or the party is gone', async () => {
    const empty = fakeTx({ party_type: 'Customer', opening_receivable: '0.00', opening_payable: '0.00', opening_outstanding: '0.00' }, []);
    expect((await consumePartyOpening(empty as any, 'pay1', 'c1', 'RECEIVABLE', 25)).toFixed(2)).toBe('0.00');
    expect(empty.paymentAllocation.create).not.toHaveBeenCalled();
    const gone = fakeTx(null, []);
    expect((await consumePartyOpening(gone as any, 'pay1', 'x', 'PAYABLE', 25)).toFixed(2)).toBe('0.00');
  });

  it('restores into the allocation bucket and ignores invoice allocations', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ change: '15.00' }]) };
    expect((await restorePartyOpening(tx as any, 'c1', 'OpeningUnassigned', 15)).toFixed(2)).toBe('15.00');
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(Prisma.sql(strings, ...values).sql).toContain('opening_outstanding - opening_receivable - opening_payable AS v');
    expect((await restorePartyOpening(tx as any, 'c1', 'SalesInvoice', 15)).toFixed(2)).toBe('0.00');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
