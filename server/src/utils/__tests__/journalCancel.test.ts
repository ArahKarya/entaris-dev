import { describe, it, expect, vi } from 'vitest';
import { BusinessError } from '../errors';
import { cancelDocumentJournals, voidJournalByIdInTx } from '../journalCancel';
import { PERIOD_CLOSED } from '../periodGuard';
import { cancelTrail } from '../cancelClaim';

type Line = { accountId: string; debit: number; credit: number };

const makeJournal = (id: string, entryNumber: string, items: Line[], fiscalYearId = 'fy-open', status = 'Submitted') => ({
  id,
  entryNumber,
  date: new Date('2026-03-10T00:00:00Z'),
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
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
  // assertPeriodOpen's FOR SHARE row read.
  $queryRaw: vi.fn(async (_sql: TemplateStringsArray, id: string) =>
    FISCAL_YEARS[id] ? [{ is_closed: FISCAL_YEARS[id]!.isClosed }] : [],
  ),
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
    expect(tx.journalEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'j2', status: { not: 'Cancelled' } },
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

  it('stores who cancelled and why on every voided journal when the cancel is a user action', async () => {
    const tx = makeTx([makeJournal('j1', 'JV-SI-1', lines), makeJournal('j2', 'JV-SI-1-CORR', lines)]) as any;

    await cancelDocumentJournals(tx, ['JV-SI-1'], cancelTrail('u-1', 'salah customer'));

    for (const id of ['j1', 'j2']) {
      expect(tx.journalEntry.updateMany).toHaveBeenCalledWith({
        where: { id, status: { not: 'Cancelled' } },
        data: { status: 'Cancelled', cancelledAt: expect.any(Date), cancelledById: 'u-1', cancelReason: 'salah customer' },
      });
    }
  });

  it('refuses when any journal (also a satellite) sits in a closed fiscal year', async () => {
    const tx = makeTx([
      makeJournal('j1', 'JV-SI-1', lines),
      makeJournal('j2', 'JV-SI-1-CORR', lines, 'fy-closed'),
    ]) as any;

    const e = await caught(cancelDocumentJournals(tx, ['JV-SI-1']));

    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/Tahun buku 2025 sudah ditutup; jurnal/);
    expect(tx.journalEntry.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'j2', status: { not: 'Cancelled' } } }));
  });

  it('returns [] and writes nothing when no journal matches', async () => {
    const tx = makeTx([]) as any;

    expect(await cancelDocumentJournals(tx, ['JV-SI-NONE'])).toEqual([]);
    expect(tx.journalEntry.updateMany).not.toHaveBeenCalled();
    expect(tx.fiscalYear.findUnique).not.toHaveBeenCalled();
  });
});

describe('voidJournalByIdInTx', () => {
  it('is a no-op for a missing journal', async () => {
    const tx = makeTx([]) as any;
    expect(await voidJournalByIdInTx(tx, 'nope')).toBe(false);
    expect(tx.journalEntry.updateMany).not.toHaveBeenCalled();
  });

  it('skips an already cancelled journal in an open year', async () => {
    const tx = makeTx([makeJournal('j1', 'JV-1', [], 'fy-open', 'Cancelled')]) as any;
    expect(await voidJournalByIdInTx(tx, 'j1')).toBe(false);
    expect(tx.journalEntry.updateMany).not.toHaveBeenCalled();
  });

  it('reverses nothing when a concurrent void claimed the journal first', async () => {
    const tx = makeTx([makeJournal('j1', 'JV-DP-1', [{ accountId: 'dp', debit: 4_000_000, credit: 0 }])]) as any;
    tx.journalEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await voidJournalByIdInTx(tx, 'j1', 'uang muka')).toBe(false);
    expect(tx.accountingLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(tx.account.update).not.toHaveBeenCalled();
  });

  it('names the document in the closed-year message', async () => {
    const tx = makeTx([makeJournal('j1', 'JV-UJ-1', [], 'fy-closed')]) as any;
    const e = await caught(voidJournalByIdInTx(tx, 'j1', 'uang jaminan'));
    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/; uang jaminan di periode ini/);
  });
});
