// Re-importing COA or parties must never delete posted opening-balance journals (audit G-25).
// COA (E2-R12): the opening balance goes through the opening balance service; the same amount is
// 'unchanged', a replacement needs confirmReplace, a refusal is reported and the account stays saved.
// Parties: a party that already has an opening balance keeps it and the row is reported.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const db = vi.hoisted(() => {
  const tx: any = {
    journalEntry: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    journalItem: { deleteMany: vi.fn() },
    accountingLedgerEntry: { createMany: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn() },
    account: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    payment: { create: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    party: { create: vi.fn() },
  };
  return {
    ...tx,
    account: tx.account,
    party: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    _tx: tx,
    rows: [] as Record<string, string>[],
  };
});
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../import/shared', () => ({
  upload: { single: () => (req: any, _res: any, next: any) => { req.file = { buffer: Buffer.from(''), originalname: 'x.csv' }; next(); } },
  parseFile: vi.fn(async () => db.rows),
  parseFileDetailed: vi.fn(async () => ({ rows: db.rows, numericCells: db.rows.map(() => ({})) })),
  sanitizeCellValue: (v: unknown) => String(v ?? ''),
}));
vi.mock('../../utils/fiscalYear', () => ({ getOpenFiscalYear: vi.fn(async () => ({ id: 'fy-1' })) }));
vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async () => 'JV-202610-0099') }));
vi.mock('../../utils/accountBalance', () => ({ updateBalancesForItems: vi.fn(async () => undefined) }));
vi.mock('../../services/systemAccounts', () => ({
  systemAccounts: { getAccount: vi.fn(async (role: string) => ({ id: `acc-${role}` })) },
}));

const opening = vi.hoisted(() => ({ previewAccountOpening: vi.fn(), setOpeningBalanceInTx: vi.fn() }));
vi.mock('../../services/ledger/openingBalance', () => opening);

import { BusinessError } from '../../utils/errors';
import coaRouter, { OPENING_REPLACE_UNCONFIRMED, OPENING_RUNNING_BALANCE } from '../import/coa';
import partiesRouter from '../import/parties';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: 'u-1' }; next(); });
  app.use('/api/import', coaRouter);
  app.use('/api/import', partiesRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = async (url: string) => {
  const r = await fetch(base + url, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as any };
};

const noDeletes = () => {
  expect(db._tx.journalEntry.delete).not.toHaveBeenCalled();
  expect(db._tx.journalItem.deleteMany).not.toHaveBeenCalled();
  expect(db._tx.accountingLedgerEntry.deleteMany).not.toHaveBeenCalled();
  expect(db.journalEntry.delete).not.toHaveBeenCalled();
  expect(db.payment.delete).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  db.account.findUnique.mockResolvedValue({ id: 'parent-1' });
  db.account.findMany.mockResolvedValue([{ id: 'parent-1', accountNumber: '1.1', rootType: 'ASSET', isGroup: true, parentId: null }]);
  db.accountingLedgerEntry.groupBy.mockResolvedValue([]);
  db.account.upsert.mockResolvedValue({ id: 'acc-cash', rootType: 'ASSET' });
  db._tx.journalEntry.create.mockResolvedValue({ id: 'je-new', items: [] });
});

describe('POST /api/import/coa re-import', () => {
  const preview = (over: Record<string, unknown> = {}) => ({
    allowed: true, reason: null, cutoverDate: '2026-01-01', recorded: '500000.00', action: 'unchanged', runningBalance: false, ...over,
  });
  const outcome = (over: Record<string, unknown> = {}) => ({
    action: 'unchanged', asOfDate: '2026-01-01', amount: '500000', journal: { entryNumber: 'JV-202601-0001' }, cancelled: [], ...over,
  });

  beforeEach(() => {
    db.rows = [{ accountNumber: '1.1.1', name: 'Kas Kecil', rootType: 'ASSET', openingBalance: '500000' }];
    opening.previewAccountOpening.mockResolvedValue(preview());
    opening.setOpeningBalanceInTx.mockResolvedValue(outcome());
  });

  it('same amount: the service reports unchanged, nothing is posted or deleted', async () => {
    const res = await post('/api/import/coa');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: 1, failed: 0, errors: [] });
    expect(res.body.openings).toEqual([{ row: 2, accountNumber: '1.1.1', action: 'unchanged', journalNumber: 'JV-202601-0001', cancelled: [] }]);
    // The opening is set on the saved account by its id (never matched by number prefix: 1.1.1 vs 1.1.10).
    expect(opening.setOpeningBalanceInTx.mock.calls[0][1]).toMatchObject({ target: { kind: 'ACCOUNT', accountId: 'acc-cash' }, amount: '500000', userId: 'u-1' });
    expect(opening.setOpeningBalanceInTx.mock.calls[0][1].asOfDate).toBeUndefined();
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
    noDeletes();
  });

  it('a blank opening balance cell leaves the opening balance alone', async () => {
    db.rows = [{ accountNumber: '1.1.1', name: 'Kas Kecil', rootType: 'ASSET', openingBalance: '' }];

    const res = await post('/api/import/coa');

    expect(res.body).toMatchObject({ success: 1, errors: [], openings: [] });
    expect(opening.previewAccountOpening).not.toHaveBeenCalled();
    expect(opening.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it('a replacement without confirmReplace is refused per row; the account stays saved', async () => {
    opening.previewAccountOpening.mockResolvedValue(preview({ action: 'replace', recorded: '400000.00' }));

    const res = await post('/api/import/coa');

    expect(res.body).toMatchObject({ success: 1, failed: 0 });
    expect(res.body.errors[0]).toMatchObject({ row: 2, code: OPENING_REPLACE_UNCONFIRMED });
    expect(res.body.errors[0].message).toContain('400000.00');
    expect(db._tx.account.upsert).toHaveBeenCalledTimes(1);
    expect(opening.setOpeningBalanceInTx).not.toHaveBeenCalled();
    noDeletes();
  });

  it('a replacement with confirmReplace goes through the service', async () => {
    opening.previewAccountOpening.mockResolvedValue(preview({ action: 'replace', recorded: '400000.00' }));
    opening.setOpeningBalanceInTx.mockResolvedValue(outcome({ action: 'replaced', journal: { entryNumber: 'JV-202601-0002' }, cancelled: ['JV-202601-0001'] }));

    const res = await post('/api/import/coa?confirmReplace=true');

    expect(res.body.errors).toEqual([]);
    expect(res.body.openings[0]).toMatchObject({ action: 'replaced', journalNumber: 'JV-202601-0002', cancelled: ['JV-202601-0001'] });
  });

  it('refuses a value that equals the running balance unless confirmed', async () => {
    opening.previewAccountOpening.mockResolvedValue(preview({ action: 'post', recorded: null, runningBalance: true }));

    const res = await post('/api/import/coa');

    expect(res.body.errors[0]).toMatchObject({ code: OPENING_RUNNING_BALANCE });
    expect(opening.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it('rolls back when the service replaced a journal the preview did not see and nothing was confirmed', async () => {
    opening.previewAccountOpening.mockResolvedValue(preview({ action: 'post', recorded: null }));
    opening.setOpeningBalanceInTx.mockResolvedValue(outcome({ action: 'replaced', cancelled: ['JV-202601-0001'] }));

    const res = await post('/api/import/coa');

    expect(res.body.errors[0]).toMatchObject({ code: OPENING_REPLACE_UNCONFIRMED });
    expect(res.body.openings).toEqual([]);
  });

  it('reports a refusal of the service with its code (old unkeyed opening journal)', async () => {
    opening.previewAccountOpening.mockResolvedValue(preview({ allowed: false, reason: 'OPENING_LEGACY_REVIEW', action: 'post', recorded: null }));
    opening.setOpeningBalanceInTx.mockRejectedValue(new BusinessError('Akun 1.1.1 masih memiliki jurnal saldo awal lama tanpa kunci (OB-1).', 'OPENING_LEGACY_REVIEW'));

    const res = await post('/api/import/coa');

    expect(res.body).toMatchObject({ success: 1, failed: 0 });
    expect(res.body.errors[0]).toMatchObject({ row: 2, code: 'OPENING_LEGACY_REVIEW' });
    expect(res.body.errors[0].message).toContain('OB-1');
    noDeletes();
  });

  it('skips the same amount on an account that takes no opening balance (0 on a revenue account)', async () => {
    db.rows = [{ accountNumber: '1.1.1', name: 'Kas Kecil', rootType: 'ASSET', openingBalance: '0' }];
    opening.previewAccountOpening.mockResolvedValue(preview({ allowed: false, reason: 'ACCOUNT_ROOT_TYPE', recorded: null }));

    const res = await post('/api/import/coa');

    expect(res.body).toMatchObject({ success: 1, errors: [], openings: [] });
    expect(opening.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it('refuses an amount with more than two decimals or a thousands separator before writing', async () => {
    db.rows = [
      { accountNumber: '1.1.1', name: 'Kas Kecil', rootType: 'ASSET', openingBalance: '500000.123' },
      { accountNumber: '1.1.2', name: 'Bank', rootType: 'ASSET', openingBalance: '5.000.000' },
    ];

    const res = await post('/api/import/coa');

    expect(res.body.errors.map((e: any) => e.row)).toEqual([2, 3]);
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
    expect(opening.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it('preview shows per row what the opening balance would do and writes nothing', async () => {
    opening.previewAccountOpening.mockResolvedValue(preview({ action: 'replace', recorded: '400000.00' }));

    const res = await post('/api/import/coa?preview=true');

    expect(res.body.data[0]).toMatchObject({
      accountNumber: '1.1.1', openingBalance: '500000',
      opening: { allowed: true, cutoverDate: '2026-01-01', recorded: '400000.00', action: 'replace', needsConfirm: true },
    });
    expect(db._tx.account.upsert).not.toHaveBeenCalled();
    expect(opening.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });
});

describe('POST /api/import/parties re-import', () => {
  beforeEach(() => {
    db.rows = [{ name: 'Budi', partyType: 'Customer', openingBalance: '5000000' }];
  });

  it('existing party: profile updated, balances and journals untouched, row reported', async () => {
    db.party.findFirst.mockResolvedValue({ id: 'p-budi' });
    db.party.update.mockResolvedValue({ id: 'p-budi' });

    const res = await post('/api/import/parties');

    expect(res.status).toBe(200);
    const data = db.party.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('outstandingAmount');
    expect(data).not.toHaveProperty('depositBalance');
    expect(data).not.toHaveProperty('customerDepositBalance');
    expect(res.body.errors[0].message).toContain('saldo awal tidak diubah');
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
    expect(db.journalEntry.findMany).not.toHaveBeenCalled();
    noDeletes();
  });

  it('new party: opening balance journal is posted and nothing is deleted', async () => {
    db.party.findFirst.mockResolvedValue(null);
    db._tx.party.create.mockResolvedValue({ id: 'p-new' });

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(1);
    expect(db._tx.party.create.mock.calls[0][0].data.outstandingAmount).toBe(5000000);
    expect(db._tx.journalEntry.create).toHaveBeenCalledTimes(1);
    noDeletes();
  });

  it('new party: the period guard runs in the transaction that writes the party and its journals', async () => {
    db.rows = [{ name: 'Sari', partyType: 'Both', openingBalance: '5000000', depositBalance: '100000', customerDepositBalance: '200000' }];
    db.party.findFirst.mockResolvedValue(null);
    db._tx.party.create.mockResolvedValue({ id: 'p-sari' });
    const { getOpenFiscalYear } = await import('../../utils/fiscalYear');

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(1);
    // One transaction per row: the year lookup is share-locked until the three journals commit.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getOpenFiscalYear)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getOpenFiscalYear).mock.calls[0][0]).toBe(db._tx);
    expect(db._tx.journalEntry.create).toHaveBeenCalledTimes(3);
    expect(db._tx.payment.create).toHaveBeenCalledTimes(2);
    expect(db.party.create).not.toHaveBeenCalled();
  });

  it('new party: a year closed before the row is posted fails the row, and party and journals roll back together', async () => {
    db.party.findFirst.mockResolvedValue(null);
    const { getOpenFiscalYear } = await import('../../utils/fiscalYear');
    const { BusinessError } = await import('../../utils/errors');
    vi.mocked(getOpenFiscalYear).mockRejectedValueOnce(
      new BusinessError('Tahun buku 2026 sudah ditutup; dokumen di periode ini tidak bisa diposting, diubah, atau dibatalkan. Buat koreksi di periode berjalan.', 'PERIOD_CLOSED'),
    );

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(0);
    expect(res.body.errors[0].message).toMatch(/Gagal insert "Budi": Tahun buku 2026 sudah ditutup/);
    expect(vi.mocked(getOpenFiscalYear).mock.calls[0][0]).toBe(db._tx);
    expect(db._tx.party.create).not.toHaveBeenCalled();
    expect(db.party.create).not.toHaveBeenCalled();
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('new party without opening balances is created outside any transaction', async () => {
    db.rows = [{ name: 'Tono', partyType: 'Supplier' }];
    db.party.findFirst.mockResolvedValue(null);
    db.party.create.mockResolvedValue({ id: 'p-tono' });

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(1);
    expect(db.party.create).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('new party: a missing system account fails the row before the party is created', async () => {
    db.party.findFirst.mockResolvedValue(null);
    const { systemAccounts } = await import('../../services/systemAccounts');
    vi.mocked(systemAccounts.getAccount).mockRejectedValueOnce(new Error('Akun sistem AR belum dikonfigurasi'));

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(0);
    expect(db.party.create).not.toHaveBeenCalled();
    expect(db._tx.party.create).not.toHaveBeenCalled();
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
  });
});
