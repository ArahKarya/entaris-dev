// COA import follows the structure rules (E2-R6): the root type must match the number's first
// digit, the parent must be a stored (or accepted) group of the same type, an account with ledger
// rows keeps its structure, and every rejection names the spreadsheet row. Rows that pass still go in.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const db = vi.hoisted(() => {
  const tx: any = {
    journalEntry: { findFirst: vi.fn(), create: vi.fn() },
    accountingLedgerEntry: { createMany: vi.fn(), groupBy: vi.fn() },
    account: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    $queryRaw: vi.fn(async () => []),
  };
  return {
    ...tx,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    _tx: tx,
    rows: [] as Record<string, string>[],
  };
});
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../import/shared', () => ({
  upload: { single: () => (req: any, _res: any, next: any) => { req.file = { buffer: Buffer.from(''), originalname: 'x.csv' }; next(); } },
  parseFileDetailed: vi.fn(async () => ({ rows: db.rows, numericCells: db.rows.map(() => ({})) })),
  sanitizeCellValue: (v: unknown) => String(v ?? ''),
}));
vi.mock('../../utils/fiscalYear', () => ({ getOpenFiscalYear: vi.fn(async () => ({ id: 'fy-1' })) }));
vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async () => 'JV-202610-0099') }));
vi.mock('../../utils/accountBalance', () => ({ updateBalancesForItems: vi.fn(async () => undefined) }));
vi.mock('../../services/systemAccounts', () => ({
  systemAccounts: { getAccount: vi.fn(async (role: string) => ({ id: `acc-${role}` })) },
}));

import coaRouter from '../import/coa';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: 'u-1' }; next(); });
  app.use('/api/import', coaRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = async (url: string) => {
  const r = await fetch(base + url, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as any };
};

const stored = [
  { id: 'a-1', accountNumber: '1', rootType: 'ASSET', isGroup: true, parentId: null },
  { id: 'a-11', accountNumber: '1.1', rootType: 'ASSET', isGroup: true, parentId: 'a-1' },
  { id: 'a-4', accountNumber: '4', rootType: 'REVENUE', isGroup: true, parentId: null },
  // Detail account with ledger rows.
  { id: 'a-12', accountNumber: '1.2', rootType: 'ASSET', isGroup: false, parentId: 'a-1' },
];

const upsertedNumbers = () => db._tx.account.upsert.mock.calls.map((c: any[]) => c[0].where.accountNumber);

beforeEach(() => {
  vi.clearAllMocks();
  db.account.findMany.mockResolvedValue(stored);
  db.accountingLedgerEntry.groupBy.mockResolvedValue([{ accountId: 'a-12' }]);
  db._tx.account.findUnique.mockImplementation(async ({ where }: any) => {
    const hit = stored.find((a) => a.accountNumber === where.accountNumber);
    return hit ? { id: hit.id } : { id: `new-${where.accountNumber}` };
  });
  db._tx.account.upsert.mockImplementation(async ({ create }: any) => ({ id: `new-${create.accountNumber}`, rootType: create.rootType }));
  db._tx.accountingLedgerEntry.groupBy.mockResolvedValue([{ accountId: 'a-12' }]);
  // Inside the write transaction the stored accounts are read again, with the rows already imported.
  db._tx.account.findMany.mockImplementation(async () => [
    ...stored,
    ...db._tx.account.upsert.mock.calls.map((c: any[]) => ({
      id: `new-${c[0].create.accountNumber}`,
      accountNumber: c[0].create.accountNumber,
      rootType: c[0].create.rootType,
      isGroup: c[0].create.isGroup,
      parentId: null,
    })),
  ]);
});

describe('POST /api/import/coa structure rules', () => {
  it('rejects 4.1 typed ASSET on its row and still imports the other rows', async () => {
    db.rows = [
      { accountNumber: '4.1', name: 'Penjualan', rootType: 'ASSET' },
      { accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET' },
    ];

    const res = await post('/api/import/coa');

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_TYPE_MISMATCH' })]);
    expect(res.body).toMatchObject({ success: 1, failed: 1 });
    expect(upsertedNumbers()).toEqual(['1.1.2']);
  });

  it('reads a blank accountType as the root type and refuses a different one', async () => {
    db.rows = [
      { accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET' },
      { accountNumber: '1.1.3', name: 'Bank 2', rootType: 'ASSET', accountType: 'LIABILITY' },
    ];

    const res = await post('/api/import/coa');

    expect(db._tx.account.upsert.mock.calls[0][0].create).toMatchObject({ accountType: 'ASSET', rootType: 'ASSET', parentId: 'a-11' });
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 3, code: 'ACCOUNT_TYPE_MISMATCH' })]);
  });

  it('refuses an account whose parent does not exist instead of importing it as an orphan', async () => {
    db.rows = [{ accountNumber: '1.9.9', name: 'Yatim', rootType: 'ASSET' }];

    const res = await post('/api/import/coa');

    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_PARENT_NOT_FOUND' })]);
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
  });

  it('refuses a stored parent that is a detail account or of another type', async () => {
    db.rows = [
      { accountNumber: '1.2.1', name: 'Anak akun detail', rootType: 'ASSET' },
      { accountNumber: '4.1', name: 'Pendapatan', rootType: 'REVENUE', parentNumber: '1.1' },
    ];

    const res = await post('/api/import/coa');

    expect(res.body.errors.map((e: any) => [e.row, e.code])).toEqual([[2, 'ACCOUNT_PARENT_NOT_GROUP'], [3, 'ACCOUNT_PARENT_MISMATCH']]);
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
  });

  it('turns the ancestors that are in the file into groups, but not an account with ledger rows', async () => {
    db.rows = [
      { accountNumber: '1.3', name: 'Persediaan', rootType: 'ASSET' },
      { accountNumber: '1.3.1', name: 'Persediaan A', rootType: 'ASSET' },
      { accountNumber: '1.2', name: 'Kas', rootType: 'ASSET' },
      { accountNumber: '1.2.1', name: 'Kas kecil', rootType: 'ASSET' },
    ];

    const res = await post('/api/import/coa');

    const created = Object.fromEntries(db._tx.account.upsert.mock.calls.map((c: any[]) => [c[0].where.accountNumber, c[0].create.isGroup]));
    expect(created).toEqual({ '1.3': true, '1.3.1': false, '1.2': false });
    // 1.2 stays a detail account, so its child has no group to sit under.
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 5, code: 'ACCOUNT_PARENT_NOT_GROUP' })]);
  });

  it('keeps an account with ledger rows as it is: structure differs -> row rejected, name untouched', async () => {
    db.rows = [{ accountNumber: '1.2', name: 'Nama baru', rootType: 'ASSET', isGroup: 'true' }];

    const res = await post('/api/import/coa');

    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_STRUCTURE_LOCKED' })]);
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
  });

  it('lets an account with ledger rows be re-imported with the same structure', async () => {
    db.rows = [{ accountNumber: '1.2', name: 'Kas (nama baru)', rootType: 'ASSET' }];

    const res = await post('/api/import/coa');

    expect(res.body).toMatchObject({ success: 1, errors: [] });
    expect(db._tx.account.upsert.mock.calls[0][0].update).toMatchObject({ name: 'Kas (nama baru)', parentId: 'a-1', isGroup: false });
  });

  it('does not re-type a group that has children (7 EXPENSE -> REVENUE) and leaves it unchanged', async () => {
    const legacy = [
      { id: 'g-7', accountNumber: '7', rootType: 'EXPENSE', isGroup: true, parentId: null },
      { id: 'g-71', accountNumber: '7.1', rootType: 'EXPENSE', isGroup: false, parentId: 'g-7' },
    ];
    db.account.findMany.mockResolvedValue(legacy);
    db._tx.account.findMany.mockResolvedValue(legacy);
    db.accountingLedgerEntry.groupBy.mockResolvedValue([{ accountId: 'g-71' }]);
    db.rows = [
      { accountNumber: '7', name: 'Pendapatan lain', rootType: 'REVENUE' },
      { accountNumber: '7.1', name: 'Bunga', rootType: 'REVENUE' },
    ];

    const res = await post('/api/import/coa');

    expect(res.body.errors.map((e: any) => [e.row, e.code])).toEqual([[2, 'ACCOUNT_STRUCTURE_LOCKED'], [3, 'ACCOUNT_PARENT_NOT_FOUND']]);
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
  });

  it('keeps a posted detail account that has a stored child from becoming a group on a blank isGroup', async () => {
    const legacy = [
      { id: 'a-1', accountNumber: '1', rootType: 'ASSET', isGroup: true, parentId: null },
      { id: 'a-15', accountNumber: '1.5', rootType: 'ASSET', isGroup: false, parentId: 'a-1' },
      { id: 'a-151', accountNumber: '1.5.1', rootType: 'ASSET', isGroup: false, parentId: 'a-15' },
    ];
    db.account.findMany.mockResolvedValue(legacy);
    db.accountingLedgerEntry.groupBy.mockResolvedValue([{ accountId: 'a-15' }]);
    db.rows = [{ accountNumber: '1.5', name: 'Nama baru', rootType: 'ASSET' }];

    const res = await post('/api/import/coa');

    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_STRUCTURE_LOCKED' })]);
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
  });

  it('skips a row whose account got ledger rows after the validation (plan no longer holds)', async () => {
    db.rows = [
      { accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET' },
      { accountNumber: '1.1.2.1', name: 'Bank anak', rootType: 'ASSET' },
    ];
    // Validation sees 1.1.2 as new; by the write it exists as a posted detail account.
    const posted = [...stored, { id: 'a-112', accountNumber: '1.1.2', rootType: 'ASSET', isGroup: false, parentId: 'a-11' }];
    // (db and its transaction share these mocks: the first read is the validation, the rest are writes.)
    db.account.findMany.mockReset().mockResolvedValueOnce(stored).mockResolvedValue(posted);
    db.accountingLedgerEntry.groupBy.mockReset().mockResolvedValueOnce([]).mockResolvedValue([{ accountId: 'a-112' }]);

    const res = await post('/api/import/coa');

    expect(res.body.errors[0]).toMatchObject({ row: 2, code: 'ACCOUNT_IMPORT_STALE' });
    expect(upsertedNumbers()).not.toContain('1.1.2');
  });

  it('rejects the second row of a repeated number', async () => {
    db.rows = [
      { accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET' },
      { accountNumber: '1.1.2', name: 'Bank lagi', rootType: 'ASSET' },
    ];

    const res = await post('/api/import/coa');

    expect(res.body.errors).toEqual([expect.objectContaining({ row: 3, code: 'ACCOUNT_IMPORT_DUPLICATE' })]);
    expect(upsertedNumbers()).toEqual(['1.1.2']);
  });

  it('preview reads the stored accounts, reports the same errors and writes nothing', async () => {
    db.rows = [
      { accountNumber: '4.1', name: 'Penjualan', rootType: 'ASSET' },
      { accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET' },
    ];

    const res = await post('/api/import/coa?preview=true');

    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_TYPE_MISMATCH' })]);
    expect(res.body.data).toEqual([expect.objectContaining({ accountNumber: '1.1.2', parentNumber: '1.1' })]);
    expect(res.body.total).toBe(2);
    expect(db.account.findMany).toHaveBeenCalled();
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('carries the row number on a database error', async () => {
    db.rows = [{ accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET' }];
    db._tx.account.upsert.mockRejectedValue(new Error('connection reset'));

    const res = await post('/api/import/coa');

    expect(res.body.errors[0]).toMatchObject({ row: 2 });
    expect(res.body.errors[0].message).toContain('Baris 2');
    expect(res.body).toMatchObject({ success: 0, failed: 1 });
  });
});
