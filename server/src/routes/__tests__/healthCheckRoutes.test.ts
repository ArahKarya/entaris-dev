// Health checks only detect (E2-R14, PR-5.0): the one fix left is the stored-balance
// recalculation, behind doc.cancel; the ale-sync and orphan-ale fixes are gone.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const fixes = vi.hoisted(() => ({
  previewAccountBalanceDrift: vi.fn(async () => ({ description: 'd', count: 0, details: [] })),
  fixAccountBalanceDrift: vi.fn(async () => ({ fixed: 1, message: 'ok' })),
}));
vi.mock('../health/fixes', () => fixes);
vi.mock('../health/checks', () => ({}));
vi.mock('../health/aleChecks', () => ({}));
vi.mock('../health/partyChecks', () => ({}));
vi.mock('../health/fiscalYearChecks', () => ({}));
vi.mock('../health/formerRoleAccountChecks', () => ({}));
vi.mock('../../lib/prisma', () => ({ prisma: { auditLog: { create: vi.fn(async () => ({})) } } }));
// Real requireCap needs the roles table; here it only has to be recognisable on the route.
vi.mock('../../middleware/auth', () => ({
  requireCap: (cap: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { cap }),
}));

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
const preview = (check: string) => fetch(`${base}/api/health-check/preview/${check}`);

describe('health check routes', () => {
  it.each(['ale-sync', 'orphan-ale', 'whatever'])('rejects the %s fix and preview as detect-only', async (check) => {
    const f = await fix(check);
    expect(f.status).toBe(400);
    expect((await f.json()).error).toMatch(/hanya mendeteksi/);
    expect((await preview(check)).status).toBe(400);
    expect(fixes.fixAccountBalanceDrift).not.toHaveBeenCalled();
    expect(fixes.previewAccountBalanceDrift).not.toHaveBeenCalled();
  });

  it('still runs the account-balance-drift fix and preview', async () => {
    expect((await fix('account-balance-drift')).status).toBe(200);
    expect(fixes.fixAccountBalanceDrift).toHaveBeenCalledTimes(1);
    expect((await preview('account-balance-drift')).status).toBe(200);
  });

  it('has one fix route, and doc.cancel guards only that route', () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { cap?: string } }> } };
    const routes = (router.stack as Layer[]).filter((l) => l.route).map((l) => l.route!);
    const guarded = routes.filter((r) => r.stack.some((s) => s.handle.cap === 'doc.cancel'));
    expect(guarded.map((r) => `${Object.keys(r.methods)[0]} ${r.path}`)).toEqual(['post /fix/:check']);
    expect(routes.filter((r) => r.path.startsWith('/fix')).length).toBe(1);
  });

  it('routes/health no longer rewrites or deletes ledger rows', () => {
    const dir = path.resolve(__dirname, '../health');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/deleteMany|accountingLedgerEntry\s*\.\s*(create|update)|UPDATE\s+accounting_ledger_entries/i);
    }
    const fixesText = fs.readFileSync(path.join(dir, 'fixes.ts'), 'utf8');
    expect(fixesText).not.toMatch(/fixAleSync|fixOrphanAle|previewAleSync|previewOrphanAle/);
  });
});
