import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildPartyWhere,
  DEFAULT_PARTY_SORT,
  isPartyListQuery,
  parsePartySort,
  partyOrderBy,
  summarizeParties,
} from '../partyList';

describe('isPartyListQuery', () => {
  it('keeps picker calls on the legacy path', () => {
    expect(isPartyListQuery({})).toBe(false);
    expect(isPartyListQuery({ type: 'Customer', limit: '200' })).toBe(false);
    expect(isPartyListQuery({ page: '2', limit: '5' })).toBe(false);
    expect(isPartyListQuery({ partyType: 'Supplier', limit: '500' })).toBe(false);
    expect(isPartyListQuery({ search: '  ' })).toBe(false);
  });

  it('switches to list mode on any list-only param', () => {
    expect(isPartyListQuery({ sort: 'name' })).toBe(true);
    expect(isPartyListQuery({ search: 'budi' })).toBe(true);
    expect(isPartyListQuery({ isActive: 'true' })).toBe(true);
    expect(isPartyListQuery({ hasOutstanding: 'true' })).toBe(true);
  });
});

describe('buildPartyWhere', () => {
  it('returns an empty where without filters', () => {
    expect(buildPartyWhere({})).toEqual({ ok: true, where: {}, type: null });
  });

  it('includes Both for Customer/Supplier and only Both for Both', () => {
    const c = buildPartyWhere({ type: 'Customer' });
    expect(c).toEqual({ ok: true, type: 'Customer', where: { AND: [{ partyType: { in: ['Customer', 'Both'] } }] } });
    const b = buildPartyWhere({ type: 'Both' });
    expect(b.ok && b.where).toEqual({ AND: [{ partyType: 'Both' }] });
  });

  it('builds active, outstanding and search filters', () => {
    const r = buildPartyWhere({ isActive: 'false', hasOutstanding: 'true', search: '0812' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const and = (r.where.AND ?? []) as Prisma.PartyWhereInput[];
    expect(and[0]).toEqual({ isActive: false });
    expect(and[1]).toEqual({ outstandingAmount: { gt: 0 } });
    expect(JSON.stringify(and[2])).toContain('"taxId":{"contains":"0812","mode":"insensitive"}');
    expect(JSON.stringify(and[2])).toContain('"phone"');
    expect(JSON.stringify(and[2])).toContain('"email"');
  });

  it('rejects unknown values', () => {
    expect(buildPartyWhere({ type: 'Vendor' }).ok).toBe(false);
    expect(buildPartyWhere({ isActive: 'yes' }).ok).toBe(false);
    expect(buildPartyWhere({ hasOutstanding: '1' }).ok).toBe(false);
  });
});

describe('sorting', () => {
  it('whitelists fields and falls back to name asc', () => {
    expect(parsePartySort('-outstanding')).toEqual({ field: 'outstanding', dir: 'desc' });
    expect(parsePartySort('createdAt')).toEqual(DEFAULT_PARTY_SORT);
    expect(parsePartySort(undefined)).toEqual(DEFAULT_PARTY_SORT);
  });

  it('maps deposit to the balance of the active tab, with stable ties', () => {
    expect(partyOrderBy({ field: 'deposit', dir: 'desc' }, 'Supplier')[0]).toEqual({ depositBalance: 'desc' });
    expect(partyOrderBy({ field: 'deposit', dir: 'desc' }, null)[0]).toEqual({ customerDepositBalance: 'desc' });
    expect(partyOrderBy({ field: 'outstanding', dir: 'asc' }, null)).toEqual([
      { outstandingAmount: 'asc' },
      { name: 'asc' },
      { id: 'asc' },
    ]);
  });
});

describe('summarizeParties', () => {
  const d = (v: string) => new Prisma.Decimal(v);
  const row = (partyType: string, isActive: boolean, receivable: string, payable: string, vendorDeposit: string, customerDeposit: string) => ({
    partyType, isActive,
    outstandingAmount: d(receivable).plus(d(payable)),
    receivableOutstanding: d(receivable),
    payableOutstanding: d(payable),
    depositBalance: d(vendorDeposit),
    customerDepositBalance: d(customerDeposit),
  });

  it('sums the positive side columns and deposits (dashboard rules)', () => {
    const s = summarizeParties([
      row('Customer', true, '1000.10', '0', '0', '50'),
      row('Customer', false, '-200', '0', '0', '0'),
      row('Supplier', true, '0', '300', '75', '0'),
      row('Both', true, '4', '6', '5', '7'),
    ]);
    expect(s).toEqual({
      total: 4,
      activeCount: 3,
      inactiveCount: 1,
      byType: { Customer: 2, Supplier: 1, Both: 1 },
      totalReceivable: 1004.1,
      totalPayable: 306,
      totalCustomerDeposit: 57,
      totalVendorDeposit: 80,
      withOutstandingCount: 3,
    });
  });

  it('counts each side of a Both party once (payable 30 jt, receivable 20 jt)', () => {
    const s = summarizeParties([row('Both', true, '20000000', '30000000', '0', '0')]);
    expect(s.totalReceivable).toBe(20_000_000);
    expect(s.totalPayable).toBe(30_000_000);
  });

  it('leaves a negative side out without cancelling the other side', () => {
    const s = summarizeParties([row('Both', true, '-500', '800', '0', '0')]);
    expect(s).toMatchObject({ totalReceivable: 0, totalPayable: 800, withOutstandingCount: 1 });
  });

  it('handles an empty list', () => {
    expect(summarizeParties([]).total).toBe(0);
  });
});
