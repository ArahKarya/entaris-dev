import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { reverseManualDepositLines } from '../partyBalance';

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

describe('reverseManualDepositLines', () => {
  it('undoes only deposit lines, by the account party role (former deposit accounts included)', async () => {
    const tx = makeTx();
    tx.journalEntry.findMany.mockResolvedValue([{ sourceKey: 'REMAP:CUSTOMER_DEPOSIT:cdep-old:cdep:20260101' }]);
    await reverseManualDepositLines(tx as any, [
      { partyId: 'c1', accountId: 'ar', debit: '100.10', credit: 0 },
      { partyId: 's1', accountId: 'ap', debit: 0, credit: 40 },
      { partyId: 'c1', accountId: 'cdep', debit: 0, credit: 25 },
      { partyId: 's1', accountId: 'vdep', debit: 30, credit: 0 },
      { partyId: 'c2', accountId: 'cdep-old', debit: 0, credit: 7 },
    ]);
    expect(updates(tx)).toEqual([
      ['c1', 'customerDepositBalance', '-25.00'],
      ['s1', 'depositBalance', '-30.00'],
      ['c2', 'customerDepositBalance', '-7.00'],
    ]);
  });

  it('skips a party on a non-party account (old expense form lines) and lines without a party', async () => {
    const tx = makeTx();
    await reverseManualDepositLines(tx as any, [
      { partyId: 's1', accountId: 'expense-6.16', debit: 500, credit: 0 },
      { partyId: null, accountId: 'cdep', debit: 0, credit: 500 },
    ]);
    expect(tx.party.update).not.toHaveBeenCalled();
  });

  it('an account in two party roles only fails the lines that touch it', async () => {
    const tx = makeTx();
    tx.systemAccountMapping.findMany.mockResolvedValue([
      { role: 'CUSTOMER_DEPOSIT', accountId: 'cdep', account: { accountNumber: '9.9.1', name: 'UM Customer' } },
      { role: 'AP', accountId: 'ap', account: { accountNumber: '2.1.1', name: 'Hutang' } },
      { role: 'VENDOR_DEPOSIT', accountId: 'ap', account: { accountNumber: '2.1.1', name: 'Hutang' } },
    ]);
    await reverseManualDepositLines(tx as any, [{ partyId: 'c1', accountId: 'cdep', debit: 0, credit: 10 }]);
    expect(updates(tx)).toEqual([['c1', 'customerDepositBalance', '-10.00']]);
    await expect(reverseManualDepositLines(tx as any, [{ partyId: 's1', accountId: 'ap', debit: 10, credit: 0 }]))
      .rejects.toMatchObject({ code: 'PARTY_ROLE_AMBIGUOUS' });
  });

  it('reads no mapping when no line has a party', async () => {
    const tx = makeTx();
    await reverseManualDepositLines(tx as any, [{ partyId: null, accountId: 'cdep', debit: 1, credit: 0 }]);
    expect(tx.systemAccountMapping.findMany).not.toHaveBeenCalled();
  });
});
