import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CTRL = '33333333-3333-4333-8333-333333333333';
const TMPL = 'tmpl-1';

const db = vi.hoisted(() => {
  const tx: any = {
    recurringTemplate: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    account: { findMany: vi.fn() },
    systemAccountMapping: { findMany: vi.fn() },
    inventoryItem: { findMany: vi.fn() },
    journalEntry: { findMany: vi.fn() },
  };
  return { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)), _tx: tx };
});
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../../middleware/auth', () => ({ requireCap: () => (_q: any, _r: any, n: any) => n() }));

import router from '../recurring';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: 'u-1' }; next(); });
  app.use('/api/recurring', router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

const acc = (id: string) => ({ id, accountNumber: '6.1', name: 'Beban', rootType: 'EXPENSE', isGroup: false, isActive: true });
const journal = (debit: number, credit: number, extra: Record<string, unknown> = {}) => ({
  narration: 'Sewa bulanan',
  items: [{ accountId: A, debit, credit: 0, ...extra }, { accountId: B, debit: 0, credit }],
});
const createBody = (templateData: unknown, extra: Record<string, unknown> = {}) => ({
  name: 'Sewa', templateType: 'journal', frequency: 'monthly', nextRunDate: '2099-01-31', templateData, ...extra,
});

const stored = (over: Record<string, unknown> = {}) => ({
  id: TMPL, templateType: 'journal', isActive: true, lastRunDate: null,
  nextRunDate: new Date('2020-01-31T00:00:00.000Z'), templateData: journal(100, 100), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db._tx.systemAccountMapping.findMany.mockResolvedValue([{ role: 'AR', accountId: CTRL }]);
  db._tx.inventoryItem.findMany.mockResolvedValue([]);
  db._tx.journalEntry.findMany.mockResolvedValue([]);
  db._tx.account.findMany.mockImplementation(async ({ where }: any) => where.id.in.map(acc));
  db._tx.recurringTemplate.create.mockImplementation(async ({ data }: any) => ({ id: TMPL, ...data }));
  db._tx.recurringTemplate.update.mockImplementation(async ({ data }: any) => ({ id: TMPL, ...data }));
  db._tx.recurringTemplate.findUnique.mockResolvedValue(stored());
});

describe('POST /api/recurring', () => {
  it('stores a balanced template with normalized amounts', async () => {
    const r = await call('POST', '/api/recurring', createBody(journal(10000000, 10000000)));
    expect(r.status).toBe(201);
    expect(db._tx.recurringTemplate.create.mock.calls[0][0].data.templateData.items[0]).toEqual({ accountId: A, debit: '10000000.00', credit: '0.00' });
  });

  it('refuses Dr 10 jt / Cr 9 jt with JOURNAL_UNBALANCED', async () => {
    const r = await call('POST', '/api/recurring', createBody(journal(10000000, 9000000)));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('JOURNAL_UNBALANCED');
    expect(db._tx.recurringTemplate.create).not.toHaveBeenCalled();
  });

  it('refuses a control account with ACCOUNT_CONTROL', async () => {
    const data = { narration: 'x', items: [{ accountId: CTRL, debit: 5, credit: 0 }, { accountId: B, debit: 0, credit: 5 }] };
    const r = await call('POST', '/api/recurring', createBody(data));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ACCOUNT_CONTROL');
  });

  it('refuses a partyId', async () => {
    const r = await call('POST', '/api/recurring', createBody(journal(5, 5, { partyId: '44444444-4444-4444-8444-444444444444' })));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PARTY_NOT_ALLOWED');
  });

  it('refuses a past next run date', async () => {
    const r = await call('POST', '/api/recurring', createBody(journal(5, 5), { nextRunDate: '2020-01-01' }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('RECURRING_DATE_PAST');
  });

  it('refuses a journal type with invoice data', async () => {
    const r = await call('POST', '/api/recurring', createBody({ items: [{ itemName: 'Beras', quantity: 1, rate: 10 }] }));
    expect(r.status).toBe(400);
    expect(db._tx.recurringTemplate.create).not.toHaveBeenCalled();
  });

  it('refuses fewer than two lines', async () => {
    const r = await call('POST', '/api/recurring', createBody({ narration: 'x', items: [{ accountId: A, debit: 5, credit: 0 }] }));
    expect(r.status).toBe(400);
  });
});

describe('PUT /api/recurring/:id', () => {
  it('lets a due template change its amounts without touching the date', async () => {
    const r = await call('PUT', `/api/recurring/${TMPL}`, { nextRunDate: '2020-01-31', templateData: journal(200, 200) });
    expect(r.status).toBe(200);
    expect(db._tx.recurringTemplate.update.mock.calls[0][0].data.templateData.items[0].debit).toBe('200.00');
  });

  it('refuses yesterday as a new date', async () => {
    const r = await call('PUT', `/api/recurring/${TMPL}`, { nextRunDate: '2020-01-30' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('RECURRING_DATE_PAST');
  });

  it('refuses a date before the last run', async () => {
    db._tx.recurringTemplate.findUnique.mockResolvedValue(stored({ lastRunDate: new Date('2099-03-10T00:00:00.000Z') }));
    const r = await call('PUT', `/api/recurring/${TMPL}`, { nextRunDate: '2099-03-01' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('RECURRING_DATE_BEFORE_LAST_RUN');
  });

  it('refuses switching to an invoice type while the stored data is a journal', async () => {
    const r = await call('PUT', `/api/recurring/${TMPL}`, { templateType: 'sales_invoice' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('RECURRING_TYPE_MISMATCH');
  });

  it('refuses journal-type update with unbalanced data', async () => {
    const r = await call('PUT', `/api/recurring/${TMPL}`, { templateData: journal(10, 9) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('JOURNAL_UNBALANCED');
  });

  it('re-validates stored data before switching a template back on', async () => {
    db._tx.recurringTemplate.findUnique.mockResolvedValue(stored({ isActive: false, templateData: journal(10, 9) }));
    const r = await call('PUT', `/api/recurring/${TMPL}`, { isActive: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('JOURNAL_UNBALANCED');
    expect(db._tx.recurringTemplate.update).not.toHaveBeenCalled();
  });

  it('deactivating does not re-validate', async () => {
    db._tx.recurringTemplate.findUnique.mockResolvedValue(stored({ templateData: journal(10, 9) }));
    const r = await call('PUT', `/api/recurring/${TMPL}`, { isActive: false });
    expect(r.status).toBe(200);
  });

  it('returns 404 for an unknown template', async () => {
    db._tx.recurringTemplate.findUnique.mockResolvedValue(null);
    const r = await call('PUT', '/api/recurring/nope', { name: 'x' });
    expect(r.status).toBe(404);
  });
});
