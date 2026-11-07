import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../../utils/periodGuard', () => ({ fiscalYearOn: vi.fn() }));

import { fiscalYearOn } from '../../../utils/periodGuard';
import { currentPnlYear, currentProfit, pnlPeriodBalances } from '../pnlPeriodBalances';

const D = (v: number | string) => new Prisma.Decimal(v);

function fakeDb(rows: { accountId: string; debit: number | null; credit: number | null }[], roots: Record<string, string>) {
  const groupBy = vi.fn().mockResolvedValue(rows.map((r) => ({ accountId: r.accountId, _sum: { debit: r.debit === null ? null : D(r.debit), credit: r.credit === null ? null : D(r.credit) } })));
  const findMany = vi.fn().mockResolvedValue(Object.entries(roots).map(([id, rootType]) => ({ id, rootType })));
  return { db: { accountingLedgerEntry: { groupBy }, account: { findMany } } as never, groupBy, findMany };
}

describe('pnlPeriodBalances', () => {
  it('signs revenue as credit - debit and expense as debit - credit', async () => {
    const { db } = fakeDb(
      [
        { accountId: 'rev', debit: 50, credit: 1000 },
        { accountId: 'exp', debit: 300, credit: 20 },
      ],
      { rev: 'REVENUE', exp: 'EXPENSE' },
    );
    const out = await pnlPeriodBalances(db, 'fy1');
    expect(out.find((b) => b.accountId === 'rev')!.amount.toString()).toBe('950');
    expect(out.find((b) => b.accountId === 'exp')!.amount.toString()).toBe('280');
  });

  it('reads active rows of the given year and the P&L roots only', async () => {
    const { db, groupBy } = fakeDb([{ accountId: 'rev', debit: 0, credit: 1 }], { rev: 'REVENUE' });
    await pnlPeriodBalances(db, 'fy1');
    expect(groupBy.mock.calls[0][0].where).toEqual({
      fiscalYearId: 'fy1',
      isCancelled: false,
      account: { rootType: { in: ['REVENUE', 'EXPENSE'] } },
    });
  });

  it('is empty without ledger rows and skips the account lookup', async () => {
    const { db, findMany } = fakeDb([], {});
    expect(await pnlPeriodBalances(db, 'fy1')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('treats a null sum as zero', async () => {
    const { db } = fakeDb([{ accountId: 'rev', debit: null, credit: 5 }], { rev: 'REVENUE' });
    expect((await pnlPeriodBalances(db, 'fy1'))[0].amount.toString()).toBe('5');
  });
});

describe('currentProfit', () => {
  it('is revenue minus expense, negative for a loss, zero when empty', () => {
    expect(currentProfit([])).toEqual(D(0));
    const rows = [
      { accountId: 'r', rootType: 'REVENUE' as const, amount: D(1000) },
      { accountId: 'e', rootType: 'EXPENSE' as const, amount: D(800) },
    ];
    expect(currentProfit(rows).toString()).toBe('200');
    expect(currentProfit([{ accountId: 'e', rootType: 'EXPENSE', amount: D(5) }]).toString()).toBe('-5');
  });
});

describe('currentPnlYear', () => {
  it('returns null when no fiscal year holds the day', async () => {
    vi.mocked(fiscalYearOn).mockResolvedValueOnce(null);
    expect(await currentPnlYear({} as never, '2145-05-01')).toBeNull();
  });

  it('asks for the year holding the business day', async () => {
    vi.mocked(fiscalYearOn).mockResolvedValueOnce({ id: 'fy' } as never);
    expect(await currentPnlYear({} as never, '2145-05-01')).toEqual({ id: 'fy' });
    const asked = vi.mocked(fiscalYearOn).mock.calls.at(-1)![1];
    expect(asked.toISOString().startsWith('2145-04-30') || asked.toISOString().startsWith('2145-05-01')).toBe(true);
  });
});
