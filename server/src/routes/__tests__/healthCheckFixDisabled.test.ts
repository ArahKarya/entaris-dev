// The ale-sync and orphan-ale auto-fixes rewrite or cancel ledger entries in every fiscal
// year, closed ones included (audit G-26). They stay disabled until fixes are period-aware.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const fixes = vi.hoisted(() => ({
  previewAleSync: vi.fn(),
  previewAccountBalanceDrift: vi.fn(),
  previewOrphanAle: vi.fn(),
  fixAleSync: vi.fn(),
  fixAccountBalanceDrift: vi.fn(async () => ({ fixed: 1, message: 'ok' })),
  fixOrphanAle: vi.fn(),
}));
vi.mock('../health/fixes', () => fixes);
vi.mock('../health/checks', () => ({}));
vi.mock('../../lib/prisma', () => ({ prisma: { auditLog: { create: vi.fn(async () => ({})) } } }));

import router from '../healthCheck';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use((req: any, _res, next) => { req.user = { userId: 'u-1' }; next(); });
  app.use('/api/health-check', router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => vi.clearAllMocks());

const fix = (check: string) => fetch(`${base}/api/health-check/fix/${check}`, { method: 'POST' });

describe('POST /api/health-check/fix/:check', () => {
  it.each(['ale-sync', 'orphan-ale'])('rejects %s without touching the ledger', async (check) => {
    const res = await fix(check);
    expect(res.status).toBe(400);
    expect(fixes.fixAleSync).not.toHaveBeenCalled();
    expect(fixes.fixOrphanAle).not.toHaveBeenCalled();
  });

  it('still runs the account-balance-drift fix', async () => {
    const res = await fix('account-balance-drift');
    expect(res.status).toBe(200);
    expect(fixes.fixAccountBalanceDrift).toHaveBeenCalledTimes(1);
  });
});
