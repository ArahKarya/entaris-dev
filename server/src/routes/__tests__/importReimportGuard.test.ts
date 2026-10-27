// Re-importing COA or parties must never delete posted opening-balance journals (audit G-25):
// an account/party that already has an opening balance keeps it and the row is reported.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const db = vi.hoisted(() => {
  const tx: any = {
    journalEntry: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    journalItem: { deleteMany: vi.fn() },
    accountingLedgerEntry: { createMany: vi.fn(), deleteMany: vi.fn() },
    account: { findUnique: vi.fn(), update: vi.fn() },
    payment: { create: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
  };
  return {
    ...tx,
    account: { ...tx.account, upsert: vi.fn() },
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
  sanitizeCellValue: (v: unknown) => String(v ?? ''),
}));
vi.mock('../../utils/fiscalYear', () => ({ getOpenFiscalYear: vi.fn(async () => ({ id: 'fy-1' })) }));
vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async () => 'JV-202610-0099') }));
vi.mock('../../utils/accountBalance', () => ({ updateBalancesForItems: vi.fn(async () => undefined) }));
vi.mock('../../services/systemAccounts', () => ({
  systemAccounts: { getAccount: vi.fn(async (role: string) => ({ id: `acc-${role}` })) },
}));

import coaRouter from '../import/coa';
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
  db.account.upsert.mockResolvedValue({ id: 'acc-cash' });
  db._tx.journalEntry.create.mockResolvedValue({ id: 'je-new', items: [] });
});

describe('POST /api/import/coa re-import', () => {
  beforeEach(() => {
    db.rows = [{ accountNumber: '1.1.1', name: 'Kas Kecil', rootType: 'ASSET', openingBalance: '500000' }];
  });

  it('keeps the existing opening journal and reports the row', async () => {
    db._tx.journalEntry.findFirst.mockResolvedValue({ entryNumber: 'JV-202601-0001' });

    const res = await post('/api/import/coa');

    expect(res.status).toBe(200);
    expect(res.body.errors[0].message).toContain('JV-202601-0001');
    // The account row itself was saved, so it counts as imported.
    expect(res.body).toMatchObject({ success: 1, failed: 0 });
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
    noDeletes();
  });

  it('matches only this account, not accounts sharing the prefix (1.1.1 vs 1.1.10)', async () => {
    db._tx.journalEntry.findFirst.mockResolvedValue(null);

    await post('/api/import/coa');

    const where = db._tx.journalEntry.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { narration: { startsWith: 'Saldo awal akun: 1.1.1 - ' } },
      { narration: { startsWith: 'Saldo Awal: 1.1.1 - ' } },
    ]);
    expect(db._tx.journalEntry.create).toHaveBeenCalledTimes(1);
    noDeletes();
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
    db.party.create.mockResolvedValue({ id: 'p-new' });

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(1);
    expect(db.party.create.mock.calls[0][0].data.outstandingAmount).toBe(5000000);
    expect(db._tx.journalEntry.create).toHaveBeenCalledTimes(1);
    noDeletes();
  });

  it('new party: a missing system account fails the row before the party is created', async () => {
    db.party.findFirst.mockResolvedValue(null);
    const { systemAccounts } = await import('../../services/systemAccounts');
    vi.mocked(systemAccounts.getAccount).mockRejectedValueOnce(new Error('Akun sistem AR belum dikonfigurasi'));

    const res = await post('/api/import/parties');

    expect(res.body.success).toBe(0);
    expect(db.party.create).not.toHaveBeenCalled();
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
  });
});
