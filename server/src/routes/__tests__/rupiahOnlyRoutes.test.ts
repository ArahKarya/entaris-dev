import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute } from '../../__tests__/helpers/routeHarness';

// Rupiah only (E2-R7, E8-R12 stage 1): a foreign currency is rejected with 400 before any write,
// where it used to be dropped silently and saved as rupiah.

const db = vi.hoisted(() => ({
  account: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../middleware/auth', () => ({ requireCap: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock('../../services/permissionService', () => ({ can: vi.fn(async () => true), isSuperAdminRole: vi.fn(async () => true) }));

import coaRouter from '../coa';
import paymentRequestsRouter from '../paymentRequests';

const ACCOUNT = { accountNumber: '1.1.99', name: 'Kas Uji', accountType: 'ASSET', rootType: 'ASSET' };
const REQUEST = {
  typeId: 't-1',
  payeeKind: 'EMPLOYEE',
  payeeName: 'Budi',
  purpose: 'Beli ATK kantor',
  lines: [{ description: 'Kertas', amount: 2000 }],
};
const actor = { userId: 'u-1', role: 'Admin' };

beforeEach(() => {
  vi.clearAllMocks();
  db.account.create.mockResolvedValue({ id: 'a-1', ...ACCOUNT });
  db.$transaction.mockRejectedValue(new Error('stop after validation'));
});

describe('COA currency', () => {
  it('POST with USD answers 400 and creates nothing', async () => {
    const r = await callRoute(coaRouter, 'post', '/', { ...actor, body: { ...ACCOUNT, currency: 'USD' } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Pembukuan hanya rupiah: mata uang akun harus IDR.' });
    expect(db.account.create).not.toHaveBeenCalled();
  });

  it('PUT with USD answers 400 and reads nothing', async () => {
    const r = await callRoute(coaRouter, 'put', '/:id', { ...actor, params: { id: 'a-1' }, body: { currency: 'USD' } });
    expect(r.status).toBe(400);
    expect(db.account.findUnique).not.toHaveBeenCalled();
    expect(db.account.update).not.toHaveBeenCalled();
  });

  it('POST with IDR or without currency creates the account', async () => {
    for (const body of [{ ...ACCOUNT, currency: 'idr' }, ACCOUNT]) {
      const r = await callRoute(coaRouter, 'post', '/', { ...actor, body });
      expect(r.status).toBe(201);
    }
    expect(db.account.create).toHaveBeenCalledTimes(2);
  });
});

describe('payment request currency', () => {
  it.each([
    ['post', '/', {}],
    ['put', '/:id', { id: 'pr-1' }],
  ] as const)('%s %s with USD answers 400 "Pengajuan hanya rupiah" before the transaction', async (method, path, params) => {
    const r = await callRoute(paymentRequestsRouter, method, path, { ...actor, params, body: { ...REQUEST, currency: 'USD' } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Pengajuan hanya rupiah' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('POST without currency passes validation and reaches the transaction', async () => {
    const r = await callRoute(paymentRequestsRouter, 'post', '/', { ...actor, body: REQUEST });
    expect(r.status).not.toBe(400);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
