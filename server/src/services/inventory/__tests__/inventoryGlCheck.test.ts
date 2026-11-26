import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { BusinessError } from '../../../utils/errors';

const mocks = vi.hoisted(() => ({
  loadControlAccountMap: vi.fn(),
  findNonJournalAle: vi.fn(),
  assertLedgerInvariant: vi.fn(),
}));
vi.mock('../../ledger/accountGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ledger/accountGuard')>()),
  loadControlAccountMap: mocks.loadControlAccountMap,
}));
vi.mock('../../ledger/nonJournalAle', () => ({ findNonJournalAle: mocks.findNonJournalAle }));
vi.mock('../inventoryLedger', () => ({ assertLedgerInvariant: mocks.assertLedgerInvariant }));
vi.mock('../../systemAccounts', () => ({
  missingMappingError: (role: string) => new BusinessError(`Akun sistem untuk "${role}" belum dikonfigurasi.`, 'ACCOUNT_MAPPING_MISSING'),
}));

import {
  findInventoryGlDiffs,
  findStockValueInvariantBreaks,
  hasInventoryGlReconciliation,
  inventoryAccountSet,
  isInventoryGlBreak,
  type InventoryGlDiff,
} from '../inventoryGlCheck';

interface FakeAccount { id: string; accountNumber: string; name: string; parentId: string | null; isGroup: boolean }

const CHART: FakeAccount[] = [
  { id: 'g14', accountNumber: '1.4', name: 'Persediaan', parentId: 'g1', isGroup: true },
  { id: 'a140', accountNumber: '1.4.0', name: 'Persediaan (Umum)', parentId: 'g14', isGroup: false },
  { id: 'a141', accountNumber: '1.4.1', name: 'Persediaan Bahan Baku', parentId: 'g14', isGroup: false },
  { id: 'a142', accountNumber: '1.4.2', name: 'Persediaan Barang Jadi', parentId: 'g14', isGroup: false },
  { id: 'a149', accountNumber: '1.4.9', name: 'Grup kosong', parentId: 'g14', isGroup: true },
  { id: 'a11', accountNumber: '1.1.1', name: 'Kas', parentId: 'g11', isGroup: false },
];

/** Raw query answers keyed by a fragment of the SQL text. */
type Answers = Partial<Record<'journal' | 'nonJournal' | 'book' | 'delivered', unknown[]>>;

function fakeDb(opts: { role?: string | null; itemAccounts?: string[]; orphan?: boolean; answers?: Answers } = {}) {
  const answers = opts.answers ?? {};
  const pick = (sql: string): unknown[] => {
    if (sql.includes('delivery_orders')) return answers.delivered ?? [];
    if (sql.includes("reference_type = 'JournalEntry'")) return answers.journal ?? [];
    if (sql.includes("reference_type <> 'JournalEntry'")) return answers.nonJournal ?? [];
    if (sql.includes('inventory_items i')) return answers.book ?? [];
    throw new Error(`unexpected query: ${sql}`);
  };
  return {
    systemAccountMapping: {
      findFirst: vi.fn(async () => (opts.role === null ? null : { accountId: opts.role ?? 'a140' })),
    },
    inventoryItem: {
      findMany: vi.fn(async () => (opts.itemAccounts ?? []).map((accountId) => ({ accountId }))),
      findFirst: vi.fn(async () => (opts.orphan ? { id: 'i-orphan' } : null)),
    },
    account: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; parentId?: { in: string[] }; isGroup?: boolean } }) => {
        let rows = CHART;
        if (where.id) rows = rows.filter((a) => where.id!.in.includes(a.id));
        if (where.parentId) rows = rows.filter((a) => a.parentId !== null && where.parentId!.in.includes(a.parentId));
        if (where.isGroup !== undefined) rows = rows.filter((a) => a.isGroup === where.isGroup);
        return [...rows].sort((x, y) => x.accountNumber.localeCompare(y.accountNumber));
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => pick(strings.join('?'))),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadControlAccountMap.mockResolvedValue(new Map([['a140', ['INVENTORY']]]));
  mocks.findNonJournalAle.mockResolvedValue({ total: 0, duplicateTotal: 0, closedTotal: 0, byType: [], rows: [] });
});

describe('inventoryAccountSet', () => {
  it('holds the role account, item accounts and every detail sibling under their group, leaves without items included', async () => {
    const set = await inventoryAccountSet(fakeDb({ itemAccounts: ['a141'] }) as never);
    expect(set.map((a) => [a.accountNumber, a.kinds])).toEqual([
      ['1.4.0', ['role']],
      ['1.4.1', ['item']],
      ['1.4.2', ['sibling']],
    ]);
  });

  it('marks an account that is both the role account and an item account with both kinds', async () => {
    mocks.loadControlAccountMap.mockResolvedValue(new Map([['a140', ['INVENTORY', 'INVENTORY_ITEM']]]));
    const set = await inventoryAccountSet(fakeDb() as never);
    expect(set.find((a) => a.id === 'a140')?.kinds).toEqual(['item', 'role']);
  });
});

describe('findInventoryGlDiffs', () => {
  it('GL 1.000.000 on a leaf without items and no stock -> difference 1.000.000 on that leaf', async () => {
    const db = fakeDb({ answers: { journal: [{ account_id: 'a142', amount: '1000000.00' }] } });
    const { accounts, total } = await findInventoryGlDiffs(db as never);
    const leaf = accounts.find((a) => a.accountNumber === '1.4.2')!;
    expect(leaf.gl.toFixed(2)).toBe('1000000.00');
    expect(leaf.bookValue.toFixed(2)).toBe('0.00');
    expect(leaf.difference.toFixed(2)).toBe('1000000.00');
    expect(isInventoryGlBreak(leaf)).toBe(true);
    expect(total.difference.toFixed(2)).toBe('1000000.00');
  });

  it('puts the value of items without an account on the role account (book keyed on COALESCE(account, role))', async () => {
    const db = fakeDb({
      answers: {
        journal: [{ account_id: 'a140', amount: '500000.00' }],
        book: [{ account_id: 'a140', book: '500000.00', qty_avg: '500000.00', phantom: '0.00' }],
      },
    });
    const row = (await findInventoryGlDiffs(db as never)).accounts.find((a) => a.accountId === 'a140')!;
    expect(row.difference.isZero()).toBe(true);
    expect(isInventoryGlBreak(row)).toBe(false);
    expect(hasInventoryGlReconciliation(row)).toBe(false);
    const call = db.$queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('inventory_items i'))!;
    expect(call).toContain('a140');
  });

  it('keeps document-typed ledger rows out of the difference: twice-counted and other rows get their own columns', async () => {
    mocks.findNonJournalAle.mockResolvedValue({
      total: 1, duplicateTotal: 1, closedTotal: 0, byType: [],
      rows: [{ referenceType: 'PurchaseInvoice', referenceId: 'pi-1', fiscalYearId: 'fy' }],
    });
    const db = fakeDb({
      answers: {
        journal: [{ account_id: 'a140', amount: '300000.00' }],
        nonJournal: [
          { account_id: 'a140', reference_type: 'PurchaseInvoice', reference_id: 'pi-1', fiscal_year_id: 'fy', amount: '300000.00' },
          { account_id: 'a140', reference_type: 'SalesInvoice', reference_id: 'si-9', fiscal_year_id: 'fy', amount: '-20000.00' },
        ],
        book: [{ account_id: 'a140', book: '300000.00', qty_avg: '300000.00', phantom: '0.00' }],
      },
    });
    const row = (await findInventoryGlDiffs(db as never)).accounts.find((a) => a.accountId === 'a140')!;
    expect(row.docTypedDuplicate.toFixed(2)).toBe('300000.00');
    expect(row.nonJournalOther.toFixed(2)).toBe('-20000.00');
    expect(row.difference.toFixed(2)).toBe('0.00');
    expect(isInventoryGlBreak(row)).toBe(false);
    expect(hasInventoryGlReconciliation(row)).toBe(true);
    expect(mocks.findNonJournalAle).toHaveBeenCalledWith(db, { referenceIds: ['pi-1', 'si-9'], duplicatesOnly: true });
  });

  it('takes the uninvoiced delivery note out of the difference as a reconciliation item', async () => {
    const db = fakeDb({
      answers: {
        journal: [{ account_id: 'a140', amount: '10000000.00' }],
        book: [{ account_id: 'a140', book: '6000000.00', qty_avg: '6000000.00', phantom: '0.00' }],
        delivered: [{ account_id: 'a140', amount: '4000000.00' }],
      },
    });
    const row = (await findInventoryGlDiffs(db as never)).accounts.find((a) => a.accountId === 'a140')!;
    expect(row.doUninvoiced.toFixed(2)).toBe('4000000.00');
    expect(row.difference.toFixed(2)).toBe('0.00');
    expect(isInventoryGlBreak(row)).toBe(false);
    expect(hasInventoryGlReconciliation(row)).toBe(true);
  });

  it('narrows to accountIds and leaves today-only measures out with asOf', async () => {
    const db = fakeDb();
    const { accounts, total } = await findInventoryGlDiffs(db as never, { accountIds: ['a141'], asOf: new Date('2125-01-01T00:00:00+07:00') });
    expect(accounts.map((a) => a.accountNumber)).toEqual(['1.4.1']);
    expect(accounts[0].qtyTimesAvg).toBeNull();
    expect(accounts[0].phantomQtyValue).toBeNull();
    expect(total.qtyTimesAvg).toBeNull();
  });

  it('refuses with ACCOUNT_MAPPING_MISSING when INVENTORY is unmapped and an item without an account holds stock', async () => {
    await expect(findInventoryGlDiffs(fakeDb({ role: null, orphan: true }) as never)).rejects.toMatchObject({ code: 'ACCOUNT_MAPPING_MISSING' });
    await expect(findInventoryGlDiffs(fakeDb({ role: null, orphan: false }) as never)).resolves.toBeDefined();
  });
});

describe('tolerance', () => {
  const row = (difference: string, extra: Partial<InventoryGlDiff> = {}): InventoryGlDiff => ({
    accountId: 'a', accountNumber: '1.4.0', name: 'x', gl: new Decimal(0), bookValue: new Decimal(0), qtyTimesAvg: new Decimal(0),
    doUninvoiced: new Decimal(0), docTypedDuplicate: new Decimal(0), nonJournalOther: new Decimal(0), phantomQtyValue: new Decimal(0),
    difference: new Decimal(difference), ...extra,
  });

  it('breaks only above 0.01, either sign', () => {
    expect(isInventoryGlBreak(row('0.01'))).toBe(false);
    expect(isInventoryGlBreak(row('-0.01'))).toBe(false);
    expect(isInventoryGlBreak(row('0.02'))).toBe(true);
    expect(isInventoryGlBreak(row('-0.02'))).toBe(true);
  });

  it('breaks on any value on stock no warehouse holds (owner decision #18)', () => {
    expect(isInventoryGlBreak(row('0', { phantomQtyValue: new Decimal('0.01') }))).toBe(true);
    expect(isInventoryGlBreak(row('0', { phantomQtyValue: null }))).toBe(false);
  });
});

describe('findStockValueInvariantBreaks', () => {
  it('reports invariants (a) and (b), largest first, not the report-only warehouse sum', async () => {
    const drift = (code: string, kind: string, difference: string, reportOnly = false) => ({
      itemId: code, code, kind, reportOnly, actual: new Decimal(0), expected: new Decimal(0), difference: new Decimal(difference),
    });
    mocks.assertLedgerInvariant.mockResolvedValue([
      drift('A', 'valueSum', '5'), drift('B', 'average', '-70'), drift('C', 'warehouseSum', '900', true),
    ]);
    const result = await findStockValueInvariantBreaks({} as never, { limit: 1 });
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.code)).toEqual(['B']);
  });
});
