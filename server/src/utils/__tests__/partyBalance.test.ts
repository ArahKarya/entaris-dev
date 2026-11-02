import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { applyPartyImpact } from '../partyBalance';

const makeTx = () => ({
  systemAccountMapping: {
    findMany: vi.fn().mockResolvedValue([
      { role: 'AR', accountId: 'ar', account: { accountNumber: '1.2.1', name: 'Piutang' } },
      { role: 'AP', accountId: 'ap', account: { accountNumber: '2.1.1', name: 'Hutang' } },
      { role: 'CUSTOMER_DEPOSIT', accountId: 'cdep', account: { accountNumber: '9.9.1', name: 'UM Customer' } },
      { role: 'VENDOR_DEPOSIT', accountId: 'vdep', account: { accountNumber: '9.9.2', name: 'UM Supplier' } },
    ]),
  },
  // A remap moved AR off 'ar-old': its lines still count as receivable.
  journalEntry: { findMany: vi.fn().mockResolvedValue([{ sourceKey: 'REMAP:AR:ar-old:ar:20260101' }]) },
  party: { update: vi.fn().mockResolvedValue({}) },
});

const updates = (tx: ReturnType<typeof makeTx>) =>
  tx.party.update.mock.calls.map(([a]) => {
    const [field, op] = Object.entries(a.data)[0] as [string, { increment: Prisma.Decimal }];
    return [a.where.id, field, op.increment.toFixed(2)];
  });

describe('applyPartyImpact', () => {
  it('classifies by the account party role, not by account number', async () => {
    const tx = makeTx();
    await applyPartyImpact(tx as any, [
      { partyId: 'c1', accountId: 'ar', debit: '100.10', credit: 0 },
      { partyId: 's1', accountId: 'ap', debit: 0, credit: 40 },
      { partyId: 'c1', accountId: 'cdep', debit: 0, credit: 25 },
      { partyId: 's1', accountId: 'vdep', debit: 30, credit: 0 },
      { partyId: 'c2', accountId: 'ar-old', debit: 7, credit: 0 },
    ], 'apply');
    expect(updates(tx)).toEqual([
      ['c1', 'outstandingAmount', '100.10'],
      ['s1', 'outstandingAmount', '40.00'],
      ['c1', 'customerDepositBalance', '25.00'],
      ['s1', 'depositBalance', '30.00'],
      ['c2', 'outstandingAmount', '7.00'],
    ]);
  });

  it('reverse undoes apply', async () => {
    const tx = makeTx();
    await applyPartyImpact(tx as any, [
      { partyId: 'c1', accountId: 'ar', debit: '100.10', credit: 0 },
      { partyId: 'c1', accountId: 'cdep', debit: 0, credit: 25 },
    ], 'reverse');
    expect(updates(tx)).toEqual([
      ['c1', 'outstandingAmount', '-100.10'],
      ['c1', 'customerDepositBalance', '-25.00'],
    ]);
  });

  it('skips a party on a non-party account (old expense form lines) and lines without a party', async () => {
    const tx = makeTx();
    await applyPartyImpact(tx as any, [
      { partyId: 's1', accountId: 'expense-6.16', debit: 500, credit: 0 },
      { partyId: null, accountId: 'ar', debit: 500, credit: 0 },
    ], 'apply');
    expect(tx.party.update).not.toHaveBeenCalled();
  });

  it('reads no mapping when no line has a party', async () => {
    const tx = makeTx();
    await applyPartyImpact(tx as any, [{ partyId: null, accountId: 'ar', debit: 1, credit: 0 }], 'apply');
    expect(tx.systemAccountMapping.findMany).not.toHaveBeenCalled();
  });
});
