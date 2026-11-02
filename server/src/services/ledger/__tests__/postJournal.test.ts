import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  assertPeriodOpen: vi.fn(),
  generateDocumentNumber: vi.fn(),
  recalcPartyOutstanding: vi.fn(),
}));
vi.mock('../../../utils/periodGuard', () => ({ assertPeriodOpen: mocks.assertPeriodOpen }));
vi.mock('../../../utils/documentNumber', () => ({ generateDocumentNumber: mocks.generateDocumentNumber }));
vi.mock('../../../utils/accountBalance', async (orig) => ({
  ...(await orig<typeof import('../../../utils/accountBalance')>()),
  recalcPartyOutstanding: mocks.recalcPartyOutstanding,
}));

import { postJournal, JOURNAL_FY_MISMATCH, type PostJournalInput } from '../postJournal';
import { DOCUMENT_RULE, manualJournalRule } from '../accountGuard';

const FY = { id: 'fy-1', name: '2178' };
const acc = (id: string, rootType: string, extra: Partial<{ isGroup: boolean; isActive: boolean }> = {}) => ({
  id, accountNumber: id, name: id, rootType, isGroup: false, isActive: true, ...extra,
});

function makeTx(accounts = [acc('ar', 'ASSET'), acc('rev', 'REVENUE'), acc('exp', 'EXPENSE')]) {
  const calls: string[] = [];
  const tx = {
    calls,
    $queryRaw: vi.fn(async () => { calls.push('lock'); return []; }),
    account: {
      findMany: vi.fn(async () => { calls.push('accounts'); return accounts; }),
      update: vi.fn(async () => ({})),
    },
    systemAccountMapping: {
      findMany: vi.fn(async () => [{ role: 'AR', accountId: 'ar', account: { accountNumber: '1.2.1', name: 'Piutang' } }]),
    },
    inventoryItem: { findMany: vi.fn(async () => []) },
    party: { findMany: vi.fn(async () => [{ id: 'cust', partyType: 'Customer' }, { id: 'supp', partyType: 'Supplier' }]) },
    journalEntry: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => {
        calls.push('create');
        return { id: 'je-1', ...data, items: data.items.create.map((i: any, n: number) => ({ id: `ji-${n}`, journalEntryId: 'je-1', ...i })) };
      }),
    },
    accountingLedgerEntry: { createMany: vi.fn(async () => { calls.push('ale'); return { count: 2 }; }) },
  };
  return tx;
}

const base = (over: Partial<PostJournalInput> = {}): PostJournalInput => ({
  date: new Date('2178-03-10T00:00:00+07:00'),
  narration: 'Uji',
  lines: [
    { accountId: 'ar', debit: '5000000.00', partyId: 'cust' },
    { accountId: 'rev', credit: '5000000.00' },
  ],
  sourceType: 'MANUAL',
  createdBy: 'u1',
  accountRule: manualJournalRule(true),
  partyRule: 'strict',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPeriodOpen.mockResolvedValue(FY);
  mocks.generateDocumentNumber.mockResolvedValue('JV-217803-0001');
});

/** A tx whose journal number call is recorded in the same call log as the account row lock. */
function numberedTx(...args: Parameters<typeof makeTx>) {
  const tx = makeTx(...args);
  mocks.generateDocumentNumber.mockImplementation(async () => { tx.calls.push('number'); return 'JV-217803-0001'; });
  return tx;
}

describe('postJournal', () => {
  it('rejects unbalanced lines before touching the database (no tolerance)', async () => {
    const tx = makeTx();
    await expect(postJournal(tx as any, base({
      lines: [{ accountId: 'exp', debit: '100000.01' }, { accountId: 'rev', credit: '100000.00' }],
    }))).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' });
    expect(mocks.assertPeriodOpen).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('takes the fiscal year from the date and refuses an unexpected one', async () => {
    const tx = makeTx();
    await expect(postJournal(tx as any, base({ expectFiscalYearId: 'fy-other' }))).rejects.toMatchObject({ code: JOURNAL_FY_MISMATCH });
    expect(mocks.assertPeriodOpen).toHaveBeenCalledWith(tx, { date: base().date }, 'jurnal', undefined);
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('passes the period options through (ignoreLock for the year-end close)', async () => {
    const tx = makeTx();
    await postJournal(tx as any, base({ periodOptions: { ignoreLock: true }, expectFiscalYearId: 'fy-1' }));
    expect(mocks.assertPeriodOpen).toHaveBeenCalledWith(tx, { date: base().date }, 'jurnal', { ignoreLock: true });
  });

  it('locks the account rows in id order before reading them', async () => {
    const tx = makeTx();
    await postJournal(tx as any, base({ lines: [{ accountId: 'rev', credit: 5 }, { accountId: 'exp', debit: 5 }], partyRule: 'off' }));
    expect(tx.calls.slice(0, 2)).toEqual(['lock', 'accounts']);
    const [strings, ...args] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...args);
    expect(sql.sql).toMatch(/FOR UPDATE/);
    expect(sql.values).toEqual(['exp', 'rev']);
  });

  it('takes the JV number (advisory lock) before the account row locks, the order of every other JV writer', async () => {
    const tx = numberedTx();
    await postJournal(tx as any, base({ lines: [{ accountId: 'rev', credit: 5 }, { accountId: 'exp', debit: 5 }], partyRule: 'off' }));
    expect(tx.calls.slice(0, 3)).toEqual(['number', 'lock', 'accounts']);
  });

  it('refuses an account in two party roles only when a line touches it', async () => {
    const twoRoles = [
      { role: 'AR', accountId: 'ar', account: { accountNumber: '1.2.1', name: 'Piutang' } },
      { role: 'AP', accountId: 'dup', account: { accountNumber: '2.1.1', name: 'Hutang' } },
      { role: 'VENDOR_DEPOSIT', accountId: 'dup', account: { accountNumber: '2.1.1', name: 'Hutang' } },
    ];
    const clean = makeTx([acc('ar', 'ASSET'), acc('rev', 'REVENUE'), acc('dup', 'LIABILITY')]);
    clean.systemAccountMapping.findMany.mockResolvedValue(twoRoles as any);
    await expect(postJournal(clean as any, base())).resolves.toBeTruthy();

    const touching = makeTx([acc('ar', 'ASSET'), acc('rev', 'REVENUE'), acc('dup', 'LIABILITY')]);
    touching.systemAccountMapping.findMany.mockResolvedValue(twoRoles as any);
    await expect(postJournal(touching as any, base({
      accountRule: DOCUMENT_RULE, partyRule: 'allowedOnly',
      lines: [{ accountId: 'dup', debit: 10, partyId: 'supp' }, { accountId: 'rev', credit: 10 }],
    }))).rejects.toMatchObject({ code: 'PARTY_ROLE_AMBIGUOUS' });
  });

  it('refuses a group or an inactive account', async () => {
    await expect(postJournal(makeTx([acc('ar', 'ASSET', { isGroup: true }), acc('rev', 'REVENUE')]) as any, base()))
      .rejects.toMatchObject({ code: 'ACCOUNT_GROUP' });
    await expect(postJournal(makeTx([acc('ar', 'ASSET'), acc('rev', 'REVENUE', { isActive: false })]) as any, base()))
      .rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('refuses a control account the rule does not allow', async () => {
    await expect(postJournal(makeTx() as any, base({ accountRule: manualJournalRule(false) })))
      .rejects.toMatchObject({ code: 'ACCOUNT_CONTROL' });
  });

  it('applies the party rule per line and names the line', async () => {
    await expect(postJournal(makeTx() as any, base({
      lines: [{ accountId: 'exp', debit: 10, partyId: 'supp' }, { accountId: 'rev', credit: 10 }],
    }))).rejects.toMatchObject({ code: 'PARTY_NOT_ALLOWED', message: expect.stringMatching(/^Baris 1: /) });
    await expect(postJournal(makeTx() as any, base({
      lines: [{ accountId: 'ar', debit: 10 }, { accountId: 'rev', credit: 10 }],
    }))).rejects.toMatchObject({ code: 'PARTY_REQUIRED' });
    await expect(postJournal(makeTx() as any, base({
      lines: [{ accountId: 'ar', debit: 10, partyId: 'supp' }, { accountId: 'rev', credit: 10 }],
    }))).rejects.toMatchObject({ code: 'PARTY_TYPE_MISMATCH' });
  });

  it('writes the journal, items, ledger rows with the party, Decimal balances and the source together', async () => {
    const tx = makeTx();
    const now = new Date('2178-03-10T03:00:00Z');
    const { journal, fiscalYear } = await postJournal(tx as any, base({ sourceKey: 'X:1', now }));
    expect(fiscalYear).toBe(FY);
    expect(tx.calls).toEqual(['lock', 'accounts', 'create', 'ale']);
    const data = tx.journalEntry.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      entryNumber: 'JV-217803-0001', status: 'Submitted', fiscalYearId: 'fy-1', sourceType: 'MANUAL', sourceKey: 'X:1',
      submittedAt: now, createdBy: 'u1', narration: 'Uji',
    });
    expect(data.items.create[0]).toMatchObject({ accountId: 'ar', partyId: 'cust' });
    expect(data.items.create[0].debit).toBeInstanceOf(Prisma.Decimal);
    const ale = (tx.accountingLedgerEntry.createMany.mock.calls[0] as any)[0].data;
    expect(ale).toHaveLength(2);
    expect(ale[0]).toMatchObject({ referenceType: 'JournalEntry', referenceId: 'je-1', fiscalYearId: 'fy-1', partyId: 'cust', description: 'Uji' });
    expect(ale[1].partyId).toBeNull();
    const balances = tx.account.update.mock.calls.map(([a]: any) => [a.where.id, a.data.balance.increment.toFixed(2)]);
    expect(balances).toEqual([['ar', '5000000.00'], ['rev', '5000000.00']]);
    expect(journal.id).toBe('je-1');
    expect(mocks.recalcPartyOutstanding).not.toHaveBeenCalled();
  });

  it('keeps ledger rows party-less with ledgerPartyless and uses a given entry number', async () => {
    const tx = makeTx();
    await postJournal(tx as any, base({ ledgerPartyless: true, entryNumber: 'CLOSE-2178', accountRule: DOCUMENT_RULE, partyRule: 'off' }));
    expect(mocks.generateDocumentNumber).not.toHaveBeenCalled();
    expect(tx.journalEntry.create.mock.calls[0][0].data.entryNumber).toBe('CLOSE-2178');
    const ale = (tx.accountingLedgerEntry.createMany.mock.calls[0] as any)[0].data;
    expect(ale.every((r: any) => r.partyId === null)).toBe(true);
    expect(tx.party.findMany).not.toHaveBeenCalled();
  });

  it('recalculates each touched party once with partyEffect recalc', async () => {
    const tx = makeTx();
    await postJournal(tx as any, base({
      partyEffect: 'recalc',
      lines: [
        { accountId: 'ar', debit: 3, partyId: 'cust' },
        { accountId: 'ar', debit: 2, partyId: 'cust' },
        { accountId: 'rev', credit: 5 },
      ],
    }));
    expect(mocks.recalcPartyOutstanding).toHaveBeenCalledTimes(1);
    expect(mocks.recalcPartyOutstanding).toHaveBeenCalledWith(tx, 'cust');
  });
});
