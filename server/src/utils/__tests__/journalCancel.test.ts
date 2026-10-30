import { describe, it, expect, vi } from 'vitest';
import { BusinessError } from '../errors';
import { cancelDocumentJournals, cancelJournalsByPrefix, voidJournalByIdInTx } from '../journalCancel';
import { PERIOD_CLOSED } from '../periodGuard';

type Line = { accountId: string; debit: number; credit: number };

const makeJournal = (id: string, entryNumber: string, items: Line[], fiscalYearId = 'fy-open', status = 'Submitted') => ({
  id,
  entryNumber,
  fiscalYearId,
  status,
  items: items.map((item, idx) => ({ id: `ji-${id}-${idx}`, ...item })),
});

const FISCAL_YEARS: Record<string, { id: string; name: string; isClosed: boolean }> = {
  'fy-open': { id: 'fy-open', name: '2026', isClosed: false },
  'fy-closed': { id: 'fy-closed', name: '2025', isClosed: true },
};

const makeTx = (journals: ReturnType<typeof makeJournal>[]) => ({
  journalEntry: {
    findMany: vi.fn().mockResolvedValue(journals),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => journals.find((j) => j.id === where.id) ?? null),
    update: vi.fn().mockResolvedValue({}),
  },
  accountingLedgerEntry: {
    updateMany: vi.fn().mockResolvedValue({ count: 2 }),
  },
  account: {
    findUnique: vi.fn().mockResolvedValue({ rootType: 'ASSET' }),
    update: vi.fn().mockResolvedValue({}),
  },
  fiscalYear: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => FISCAL_YEARS[where.id] ?? null),
  },
});

async function caught(p: Promise<unknown>): Promise<BusinessError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e;
    throw e;
  }
  throw new Error('expected a BusinessError');
}

describe('cancelJournalsByPrefix', () => {

  it('cancels a single journal matching prefix', async () => {
    const journal = makeJournal('j1', 'JV-PR0004', [
      { accountId: 'a1', debit: 1000, credit: 0 },
      { accountId: 'a2', debit: 0, credit: 1000 },
    ]);
    const tx = makeTx([journal]) as any;

    const count = await cancelJournalsByPrefix(tx, 'JV-PR0004');

    expect(count).toBe(1);
    expect(tx.journalEntry.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ entryNumber: 'JV-PR0004' }, { entryNumber: { startsWith: 'JV-PR0004-' } }],
        status: { not: 'Cancelled' },
      },
      include: { items: true },
    });
    expect(tx.journalEntry.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { status: 'Cancelled', cancelledAt: expect.any(Date) },
    });
    expect(tx.accountingLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: { referenceId: 'j1', isCancelled: false },
      data: { isCancelled: true },
    });
  });

  it('refuses a revision journal in a closed fiscal year', async () => {
    const tx = makeTx([
      makeJournal('j1', 'JV-PR0004', [{ accountId: 'a1', debit: 10, credit: 0 }]),
      makeJournal('j2', 'JV-PR0004-R1', [{ accountId: 'a1', debit: 10, credit: 0 }], 'fy-closed'),
    ]) as any;

    const e = await caught(cancelJournalsByPrefix(tx, 'JV-PR0004'));

    expect(e.code).toBe(PERIOD_CLOSED);
    expect(tx.journalEntry.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'j2' } }));
  });

  it('cancels multiple journals including revisions (JV-PR0004, JV-PR0004-R, JV-PR0004-R2)', async () => {
    const journals = [
      makeJournal('j1', 'JV-PR0004', [
        { accountId: 'inv', debit: 0, credit: 500 },
        { accountId: 'hpp', debit: 500, credit: 0 },
      ]),
      makeJournal('j2', 'JV-PR0004-R', [
        { accountId: 'inv', debit: 0, credit: 600 },
        { accountId: 'hpp', debit: 600, credit: 0 },
      ]),
      makeJournal('j3', 'JV-PR0004-R2', [
        { accountId: 'inv', debit: 0, credit: 700 },
        { accountId: 'hpp', debit: 700, credit: 0 },
      ]),
    ];
    const tx = makeTx(journals) as any;

    const count = await cancelJournalsByPrefix(tx, 'JV-PR0004');

    expect(count).toBe(3);
    expect(tx.journalEntry.update).toHaveBeenCalledTimes(3);
    expect(tx.accountingLedgerEntry.updateMany).toHaveBeenCalledTimes(3);
  });

  it('reverses account balances (swaps debit/credit)', async () => {
    const journal = makeJournal('j1', 'JV-SO0001', [
      { accountId: 'inventory', debit: 1000, credit: 0 },
      { accountId: 'variance', debit: 0, credit: 1000 },
    ]);
    const tx = makeTx([journal]) as any;

    await cancelJournalsByPrefix(tx, 'JV-SO0001');

    // Balance reversal: swap debit↔credit → call updateAccountBalance(credit, debit)
    // For inventory (debit=1000, credit=0): reversed → updateAccountBalance(0, 1000)
    // For variance (debit=0, credit=1000): reversed → updateAccountBalance(1000, 0)
    expect(tx.account.update).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when no active journals match prefix', async () => {
    const tx = makeTx([]) as any;

    const count = await cancelJournalsByPrefix(tx, 'JV-NONEXISTENT');

    expect(count).toBe(0);
    expect(tx.journalEntry.update).not.toHaveBeenCalled();
    expect(tx.accountingLedgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it('matches the exact number or a dash satellite, so JV-PR-202601-1000 never matches -10000', async () => {
    const tx = makeTx([]) as any;

    await cancelJournalsByPrefix(tx, 'JV-PR-202601-1000');

    expect(tx.journalEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ entryNumber: 'JV-PR-202601-1000' }, { entryNumber: { startsWith: 'JV-PR-202601-1000-' } }],
        }),
      })
    );
  });
});

describe('cancelDocumentJournals', () => {
  const lines: Line[] = [
    { accountId: 'ar', debit: 11_100_000, credit: 0 },
    { accountId: 'revenue', debit: 0, credit: 11_100_000 },
  ];

  it('looks up the base numbers and their dash satellites, oldest first', async () => {
    const tx = makeTx([]) as any;

    await cancelDocumentJournals(tx, ['JV-SI-202604-0038', 'JV-COGS-SI-202604-0038']);

    expect(tx.journalEntry.findMany).toHaveBeenCalledWith({
      where: {
        status: { not: 'Cancelled' },
        OR: [
          { entryNumber: 'JV-SI-202604-0038' },
          { entryNumber: { startsWith: 'JV-SI-202604-0038-' } },
          { entryNumber: 'JV-COGS-SI-202604-0038' },
          { entryNumber: { startsWith: 'JV-COGS-SI-202604-0038-' } },
        ],
      },
      include: { items: true },
      orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
    });
  });

  it('voids each journal: status, ledger entries and reversed balances; returns the numbers', async () => {
    const tx = makeTx([
      makeJournal('j1', 'JV-SI-1', lines),
      makeJournal('j2', 'JV-SI-1-CORR', lines),
    ]) as any;

    const cancelled = await cancelDocumentJournals(tx, ['JV-SI-1']);

    expect(cancelled).toEqual(['JV-SI-1', 'JV-SI-1-CORR']);
    expect(tx.journalEntry.update).toHaveBeenCalledWith({
      where: { id: 'j2' },
      data: { status: 'Cancelled', cancelledAt: expect.any(Date) },
    });
    expect(tx.accountingLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: { referenceId: 'j1', isCancelled: false },
      data: { isCancelled: true },
    });
    // Asset AR was debited 11.1 jt; the void credits it back (balance decrement).
    expect(tx.account.update).toHaveBeenCalledWith({ where: { id: 'ar' }, data: { balance: { increment: expect.anything() } } });
    expect(tx.account.update).toHaveBeenCalledTimes(4);
  });

  it('refuses when any journal (also a satellite) sits in a closed fiscal year', async () => {
    const tx = makeTx([
      makeJournal('j1', 'JV-SI-1', lines),
      makeJournal('j2', 'JV-SI-1-CORR', lines, 'fy-closed'),
    ]) as any;

    const e = await caught(cancelDocumentJournals(tx, ['JV-SI-1']));

    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/Tahun buku 2025 sudah ditutup; jurnal/);
    expect(tx.journalEntry.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'j2' } }));
  });

  it('returns [] and writes nothing when no journal matches', async () => {
    const tx = makeTx([]) as any;

    expect(await cancelDocumentJournals(tx, ['JV-SI-NONE'])).toEqual([]);
    expect(tx.journalEntry.update).not.toHaveBeenCalled();
    expect(tx.fiscalYear.findUnique).not.toHaveBeenCalled();
  });
});

describe('voidJournalByIdInTx', () => {
  it('is a no-op for a missing journal', async () => {
    const tx = makeTx([]) as any;
    expect(await voidJournalByIdInTx(tx, 'nope')).toBe(false);
    expect(tx.journalEntry.update).not.toHaveBeenCalled();
  });

  it('skips an already cancelled journal in an open year', async () => {
    const tx = makeTx([makeJournal('j1', 'JV-1', [], 'fy-open', 'Cancelled')]) as any;
    expect(await voidJournalByIdInTx(tx, 'j1')).toBe(false);
    expect(tx.journalEntry.update).not.toHaveBeenCalled();
  });

  it('names the document in the closed-year message', async () => {
    const tx = makeTx([makeJournal('j1', 'JV-UJ-1', [], 'fy-closed')]) as any;
    const e = await caught(voidJournalByIdInTx(tx, 'j1', 'uang jaminan'));
    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/; uang jaminan di periode ini/);
  });
});
