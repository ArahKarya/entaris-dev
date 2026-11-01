/**
 * E3-R1: every path that lets stock go negative on request needs inventory.negative_stock, not only
 * doc.cancel (goods receipt cancel, production run cancel) or ownership of the request (production
 * run resubmit). The reason check stays first (400); without the capability the route answers 403
 * with NEGATIVE_STOCK_FORBIDDEN before any write.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { $transaction, findUnique, update, roleCaps } = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret-value-0123456789';
  return { $transaction: vi.fn(), findUnique: vi.fn(), update: vi.fn(), roleCaps: {} as Record<string, string[]> };
});
vi.mock('../../lib/prisma', () => ({ prisma: { $transaction, approvalRequest: { findUnique, update } } }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../services/permissionService', () => ({
  hasCap: async (role: string, cap: string) => (roleCaps[role] ?? []).includes(cap),
  can: async () => true,
}));

import { BusinessError } from '../../utils/errors';
import goodsReceiptsRouter from '../goodsReceipts';
import productionRunsRouter from '../inventory/productionRuns';
import approvalsRouter from '../approvals';

roleCaps.StaffProduksi = [];
roleCaps.Accountant = ['doc.cancel'];
roleCaps.Admin = ['doc.cancel', 'inventory.negative_stock'];

let server: Server;
let base = '';
let role = 'Accountant';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u1', role };
    next();
  });
  app.use('/goods-receipts', goodsReceiptsRouter);
  app.use('/production-runs', productionRunsRouter);
  app.use('/approvals', approvalsRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  $transaction.mockReset();
  // Reaching the transaction means the gate let the request through.
  $transaction.mockRejectedValue(new BusinessError('handler reached', 'REACHED'));
  findUnique.mockReset();
  findUnique.mockResolvedValue({ id: 'r1', documentType: 'ProductionRun', status: 'NeedsRevision', requestedBy: 'u1' });
  update.mockReset();
  update.mockResolvedValue({ id: 'r1', status: 'Pending' });
});

const ID = '3f2b8c1e-1234-4abc-9def-0123456789ab';
const reason = 'Stok fisik sudah dihitung ulang';
const bypass = { allowNegativeStock: true, negativeStockReason: reason };

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const forbidden = { error: 'Anda tidak berwenang bypass validasi stok.', code: 'NEGATIVE_STOCK_FORBIDDEN' };

// [label, method, path, body]: the three ways a cancel can ask for the bypass.
const cancels: Array<[string, string, string, unknown]> = [
  ['goods receipt cancel', 'POST', `/goods-receipts/${ID}/cancel`, bypass],
  ['production run cancel (body)', 'PUT', `/production-runs/${ID}/cancel`, bypass],
  ['production run cancel (query)', 'PUT', `/production-runs/${ID}/cancel?allowNegativeStock=true`, { negativeStockReason: reason }],
];

describe('negative-stock bypass on cancel', () => {
  it.each(cancels)('%s: doc.cancel alone answers 403 before the transaction', async (_l, method, path, body) => {
    role = 'Accountant';
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden);
    expect($transaction).not.toHaveBeenCalled();
  });

  it.each(cancels)('%s: inventory.negative_stock passes the gate', async (_l, method, path, body) => {
    role = 'Admin';
    const res = await call(method, path, body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REACHED');
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it.each(cancels)('%s: a short reason is 400 before the capability check', async (_l, method, path) => {
    role = 'Accountant';
    const short = path.includes('?') ? { negativeStockReason: 'pendek' } : { allowNegativeStock: true, negativeStockReason: 'pendek' };
    const res = await call(method, path, short);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Alasan bypass stok minus wajib diisi (minimal 10 karakter).');
    expect($transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['goods receipt cancel', 'POST', `/goods-receipts/${ID}/cancel`],
    ['production run cancel', 'PUT', `/production-runs/${ID}/cancel`],
  ])('%s without the bypass still only needs doc.cancel', async (_l, method, path) => {
    role = 'Accountant';
    const res = await call(method, path, {});
    expect((await res.json()).code).toBe('REACHED');
  });

  it('doc.cancel is still checked first', async () => {
    role = 'StaffProduksi';
    const res = await call('POST', `/goods-receipts/${ID}/cancel`, bypass);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBeUndefined();
  });
});

describe('negative-stock bypass on production run resubmit', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    date: '2026-05-04',
    warehouseId: ID,
    inputs: [{ itemId: ID, quantity: 100 }],
    outputs: [{ itemId: ID, quantity: 60 }],
    ...over,
  });

  it('answers 403 without inventory.negative_stock and leaves the request alone', async () => {
    role = 'StaffProduksi';
    const res = await call('PUT', '/approvals/requests/r1/resubmit', { payload: payload(bypass) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden);
    expect(update).not.toHaveBeenCalled();
  });

  it('resubmits the bypass for a holder of inventory.negative_stock', async () => {
    role = 'Admin';
    const res = await call('PUT', '/approvals/requests/r1/resubmit', { payload: payload(bypass) });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('resubmits a run without the bypass for anyone who owns the request', async () => {
    role = 'StaffProduksi';
    const res = await call('PUT', '/approvals/requests/r1/resubmit', { payload: payload() });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
