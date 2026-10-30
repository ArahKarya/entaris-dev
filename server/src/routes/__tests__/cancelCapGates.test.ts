/**
 * E1-R3: stock transfer cancel, customer/supplier deposit cancel and the full delivery note edit
 * need the doc.cancel capability. Without it the route answers 403 before touching the database.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { $transaction, roleCaps } = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret-value-0123456789';
  return { $transaction: vi.fn(), roleCaps: {} as Record<string, string[]> };
});
vi.mock('../../lib/prisma', () => ({ prisma: { $transaction } }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../services/permissionService', () => ({
  hasCap: async (role: string, cap: string) => (roleCaps[role] ?? []).includes(cap),
  can: async () => true,
}));

import { BusinessError } from '../../utils/errors';
import stockTransfersRouter from '../stockTransfers';
import customerDepositsRouter from '../customerDeposits';
import vendorDepositsRouter from '../vendorDeposits';
import deliveryOrdersRouter from '../deliveryOrders';

roleCaps.StaffProduksi = [];
roleCaps.Accountant = ['doc.cancel'];
roleCaps.Admin = ['doc.cancel', 'inventory.negative_stock'];

let server: Server;
let base = '';
let role = 'StaffProduksi';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u1', role };
    next();
  });
  app.use('/stock-transfers', stockTransfersRouter);
  app.use('/customer-deposits', customerDepositsRouter);
  app.use('/vendor-deposits', vendorDepositsRouter);
  app.use('/delivery-orders', deliveryOrdersRouter);
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
});

const ID = '3f2b8c1e-1234-4abc-9def-0123456789ab';
const doBody = {
  date: '2026-10-01',
  partyId: ID,
  items: [{ inventoryItemId: ID, warehouseId: ID, itemName: 'Beras', quantity: 8_000, unit: 'kg' }],
};

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const gated: Array<[string, string, unknown?]> = [
  ['PATCH', `/stock-transfers/${ID}/cancel`],
  ['PATCH', `/customer-deposits/${ID}/cancel`],
  ['PATCH', `/vendor-deposits/${ID}/cancel`],
  ['PUT', `/delivery-orders/${ID}`, doBody],
];

describe('doc.cancel gate on the remaining cancel and edit routes', () => {
  it.each(gated)('%s %s answers 403 without doc.cancel', async (method, path, body) => {
    role = 'StaffProduksi';
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect($transaction).not.toHaveBeenCalled();
  });

  it.each(gated)('%s %s passes the gate with doc.cancel', async (method, path, body) => {
    role = 'Accountant';
    const res = await call(method, path, body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REACHED');
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

describe('stock transfer cancel negative-stock bypass', () => {
  const bypass = { allowNegativeStock: true, negativeStockReason: 'Stok fisik sudah dihitung ulang' };

  it('needs inventory.negative_stock on top of doc.cancel', async () => {
    role = 'Accountant';
    const res = await call('PATCH', `/stock-transfers/${ID}/cancel`, bypass);
    expect(res.status).toBe(403);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('needs a reason of at least 10 characters', async () => {
    role = 'Admin';
    const res = await call('PATCH', `/stock-transfers/${ID}/cancel`, { allowNegativeStock: true, negativeStockReason: 'pendek' });
    expect(res.status).toBe(400);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('lets a role with inventory.negative_stock through', async () => {
    role = 'Admin';
    const res = await call('PATCH', `/stock-transfers/${ID}/cancel`, bypass);
    expect((await res.json()).code).toBe('REACHED');
  });
});
