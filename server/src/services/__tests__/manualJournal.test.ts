// One validator (plan §2.1): the same line fixtures give the same verdict through the pure validator
// (L0), postJournal (L2) and createManualJournalInTx (L3). If a layer grew its own check, a row here
// would diverge.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertPeriodOpen: vi.fn(),
  generateDocumentNumber: vi.fn(),
  recalcPartyOutstanding: vi.fn(),
}));
vi.mock('../../utils/periodGuard', () => ({ assertPeriodOpen: mocks.assertPeriodOpen }));
vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: mocks.generateDocumentNumber }));
vi.mock('../../utils/accountBalance', async (orig) => ({
  ...(await orig<typeof import('../../utils/accountBalance')>()),
  recalcPartyOutstanding: mocks.recalcPartyOutstanding,
}));

import { validateJournalLines, type JournalLineInput } from '../../utils/journalLineRules';
import { postJournal } from '../ledger/postJournal';
import { manualJournalRule } from '../ledger/accountGuard';
import { createManualJournalInTx } from '../manualJournal';

const acc = (id: string, rootType: string) => ({ id, accountNumber: id, name: id, rootType, isGroup: false, isActive: true });

function makeTx() {
  return {
    $queryRaw: vi.fn(async () => []),
    account: {
      findMany: vi.fn(async () => [acc('ar', 'ASSET'), acc('cdep', 'LIABILITY'), acc('exp', 'EXPENSE'), acc('cash', 'ASSET')]),
      update: vi.fn(async () => ({})),
    },
    systemAccountMapping: {
      findMany: vi.fn(async () => [
        { role: 'AR', accountId: 'ar', account: { accountNumber: '1.2.1', name: 'Piutang' } },
        { role: 'CUSTOMER_DEPOSIT', accountId: 'cdep', account: { accountNumber: '2.1.2', name: 'UM Customer' } },
      ]),
    },
    inventoryItem: { findMany: vi.fn(async () => []) },
    party: { findMany: vi.fn(async () => [{ id: 'cust', partyType: 'Customer' }, { id: 'supp', partyType: 'Supplier' }]) },
    systemAccountRoleMove: { findMany: vi.fn(async () => []) },
    journalEntry: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => ({
        id: 'je-1', ...data, items: data.items.create.map((i: any, n: number) => ({ id: `ji-${n}`, journalEntryId: 'je-1', ...i })),
      })),
    },
    accountingLedgerEntry: { createMany: vi.fn(async () => ({ count: 2 })) },
  };
}

const exp = (debit: JournalLineInput['debit'], credit: JournalLineInput['credit'] = 0): JournalLineInput => ({ accountId: 'exp', debit, credit });
const cash = (debit: JournalLineInput['debit'], credit: JournalLineInput['credit'] = 0): JournalLineInput => ({ accountId: 'cash', debit, credit });

/** [label, lines, expected first issue code or null for valid]. */
const TABLE: Array<[string, JournalLineInput[], string | null]> = [
  ['balanced numbers', [exp(100_000), cash(0, 100_000)], null],
  ['balanced strings with 2 decimals', [exp('100000.01'), cash(0, '100000.01')], null],
  ['one cent off (no tolerance)', [exp(100_000.01), cash(0, 100_000)], 'JOURNAL_UNBALANCED'],
  ['debit and credit on one line', [exp(10, 10), cash(0, 0.01)], 'LINE_BOTH_SIDES'],
  ['a 0/0 line', [exp(10), cash(0, 10), exp(0, 0)], 'LINE_EMPTY'],
  ['three decimals (never rounded)', [exp('10.005'), cash(0, '10.005')], 'LINE_AMOUNT_PRECISION'],
  ['negative amount', [exp(-10), cash(0, -10)], 'LINE_AMOUNT_NEGATIVE'],
  ['thousands separator', [exp('1,000'), cash(0, '1000')], 'LINE_AMOUNT_INVALID'],
  ['beyond Decimal(15,2)', [exp('10000000000000'), cash(0, '10000000000000')], 'LINE_AMOUNT_TOO_LARGE'],
];

const DATE = '2179-03-10';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPeriodOpen.mockResolvedValue({ id: 'fy-1', name: '2179' });
  mocks.generateDocumentNumber.mockResolvedValue('JV-217903-0001');
});

describe('one validator: L0, postJournal and createManualJournalInTx agree', () => {
  it.each(TABLE)('%s', async (_label, lines, code) => {
    const l0 = validateJournalLines(lines);
    expect(l0.ok ? null : l0.issues[0].code).toBe(code);

    const l2 = postJournal(makeTx() as any, {
      date: new Date(`${DATE}T00:00:00.000Z`), narration: 'Uji', lines, sourceType: 'MANUAL', createdBy: 'u1',
      accountRule: manualJournalRule(false), partyRule: 'strict',
    });
    const l3 = createManualJournalInTx(makeTx() as any, {
      date: DATE, narration: 'Uji',
      items: lines.map((l) => ({ accountId: l.accountId, debit: l.debit as number | string, credit: l.credit as number | string })),
    }, { userId: 'u1', sourceType: 'MANUAL', canControl: false });

    if (code) {
      await expect(l2).rejects.toMatchObject({ code });
      await expect(l3).rejects.toMatchObject({ code });
    } else {
      await expect(l2).resolves.toBeTruthy();
      await expect(l3).resolves.toBeTruthy();
    }
  });
});

describe('createManualJournalInTx', () => {
  const input = (items: any[]) => ({ date: DATE, narration: 'Koreksi', items });

  it('refuses a single line with the validator message before touching the database', async () => {
    const tx = makeTx();
    await expect(createManualJournalInTx(tx as any, input([exp(10)]), { userId: 'u1', sourceType: 'MANUAL', canControl: true }))
      .rejects.toThrow('Jurnal minimal memiliki 2 baris bernilai.');
    expect(mocks.assertPeriodOpen).not.toHaveBeenCalled();
  });

  it('posts MANUAL/IMPORT with the source key, strict party rule and a recalculation of the touched party', async () => {
    const tx = makeTx();
    const { journal } = await createManualJournalInTx(tx as any, input([
      { accountId: 'ar', partyId: 'cust', debit: 5_000_000, credit: 0 },
      { accountId: 'exp', debit: 0, credit: 5_000_000, description: 'Lawan' },
    ]), { userId: 'u1', sourceType: 'IMPORT', sourceKey: 'IMPORT:abc:1', canControl: true });
    const data = tx.journalEntry.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceType: 'IMPORT', sourceKey: 'IMPORT:abc:1', createdBy: 'u1', narration: 'Koreksi' });
    expect(data.items.create.map((i: any) => i.description)).toEqual(['Koreksi', 'Lawan']);
    expect(journal.id).toBe('je-1');
    expect(mocks.recalcPartyOutstanding).toHaveBeenCalledWith(tx, 'cust');
  });

  it('a receivable line needs journal.control', async () => {
    const lines = [{ accountId: 'ar', partyId: 'cust', debit: 10, credit: 0 }, { accountId: 'exp', debit: 0, credit: 10 }];
    await expect(createManualJournalInTx(makeTx() as any, input(lines), { userId: 'u1', sourceType: 'MANUAL', canControl: false }))
      .rejects.toMatchObject({ code: 'ACCOUNT_CONTROL' });
    await expect(createManualJournalInTx(makeTx() as any, input(lines), { userId: 'u1', sourceType: 'MANUAL', canControl: true }))
      .resolves.toBeTruthy();
  });

  it('a deposit account is refused even with journal.control', async () => {
    const lines = [{ accountId: 'exp', debit: 10, credit: 0 }, { accountId: 'cdep', partyId: 'cust', debit: 0, credit: 10 }];
    await expect(createManualJournalInTx(makeTx() as any, input(lines), { userId: 'u1', sourceType: 'MANUAL', canControl: true }))
      .rejects.toMatchObject({ code: 'ACCOUNT_CONTROL' });
  });

  it('a party on an expense line is refused', async () => {
    const lines = [{ accountId: 'exp', partyId: 'supp', debit: 10, credit: 0 }, { accountId: 'cash', debit: 0, credit: 10 }];
    await expect(createManualJournalInTx(makeTx() as any, input(lines), { userId: 'u1', sourceType: 'MANUAL', canControl: false }))
      .rejects.toMatchObject({ code: 'PARTY_NOT_ALLOWED' });
  });
});
