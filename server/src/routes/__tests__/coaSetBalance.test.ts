/**
 * PR-5.7a: PATCH /api/coa/:id/balance goes through the opening balance service (E2-R11). The route
 * validates the body, refuses throughLock without period.lock or through AIRA (403), and returns
 * the account with the opening outcome; service refusals keep their code (400).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret-value-0123456789';
  return {
  setOpeningBalanceInTx: vi.fn(),
  hasCap: vi.fn(),
  account: { findUnique: vi.fn() },
  };
});
vi.mock('../../lib/prisma', () => ({
  prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn({ account: mocks.account }) },
}));
vi.mock('../../services/permissionService', async (orig) => ({
  ...(await orig<typeof import('../../services/permissionService')>()),
  hasCap: mocks.hasCap,
}));
vi.mock('../../services/ledger/openingBalance', async (orig) => ({
  ...(await orig<typeof import('../../services/ledger/openingBalance')>()),
  setOpeningBalanceInTx: mocks.setOpeningBalanceInTx,
}));

import coaRouter from '../coa';
import { BusinessError } from '../../utils/errors';
import { ACCOUNT_CONTROL, ACCOUNT_ROOT_TYPE } from '../../services/ledger/accountGuard';
import { OPENING_DATE_MISMATCH, OPENING_LOCK_RIGHT } from '../../services/ledger/openingBalance';

type Result = { status: number; body: any };

/** Runs the PATCH /:id/balance handlers with a minimal req/res; `via` marks an AIRA (MCP) call. */
async function patch(body: unknown, user: { role?: string; via?: 'mcp' } = {}): Promise<Result> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } };
  const layer = (coaRouter.stack as Layer[]).find((l) => l.route?.path === '/:id/balance' && l.route.methods.patch)!;
  const result: Result = { status: 200, body: undefined };
  const res = {
    status(code: number) { result.status = code; return res; },
    json(b: unknown) { result.body = b; return res; },
  };
  const req = { method: 'PATCH', params: { id: 'acc-1' }, body, query: {}, headers: {}, user: { userId: 'u1', role: user.role ?? 'Accountant', via: user.via } };
  for (const { handle } of layer.route!.stack) await handle(req, res, () => undefined);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasCap.mockResolvedValue(false);
  mocks.account.findUnique.mockResolvedValue({ id: 'acc-1', accountNumber: '1.1.1', balance: '500' });
  mocks.setOpeningBalanceInTx.mockResolvedValue({
    action: 'posted', asOfDate: '2150-01-01', amount: new Prisma.Decimal(500), journal: { entryNumber: 'JV-215001-0001' }, cancelled: [],
  });
});

describe('PATCH /coa/:id/balance', () => {
  it('posts through the service and returns the account with the opening outcome', async () => {
    const r = await patch({ balance: 500000000, asOfDate: '2150-01-01' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      account: { id: 'acc-1', accountNumber: '1.1.1', balance: '500' },
      opening: { asOfDate: '2150-01-01', action: 'posted', journalNumber: 'JV-215001-0001', cancelled: [] },
    });
    expect(mocks.setOpeningBalanceInTx.mock.calls[0][1]).toEqual({
      target: { kind: 'ACCOUNT', accountId: 'acc-1' }, amount: '500000000', asOfDate: '2150-01-01', userId: 'u1', throughLock: undefined,
    });
  });

  it('accepts a string amount with two decimals and a negative contra balance', async () => {
    expect((await patch({ balance: '-1250.75' })).status).toBe(200);
    expect(mocks.setOpeningBalanceInTx.mock.calls[0][1].amount).toBe('-1250.75');
  });

  it.each([
    [{ balance: '10.505' }],
    [{ balance: '1.000.000' }],
    [{ balance: '1e6' }],
    [{ balance: 'abc' }],
    [{ balance: 500, asOfDate: '15/03/2150' }],
    [{ balance: 500, asOfDate: '2150-02-30' }],
    [{ balance: 500, throughLock: { reason: 'pendek' } }],
  ])('400 on an invalid body %j without calling the service', async (body) => {
    const r = await patch(body);
    expect(r.status).toBe(400);
    expect(mocks.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it.each([
    ['4.1 revenue', ACCOUNT_ROOT_TYPE],
    ['1.4.1 item inventory', ACCOUNT_CONTROL],
    ['a date other than the cut-over', OPENING_DATE_MISMATCH],
  ])('400 with the code when the service refuses %s', async (_name, code) => {
    mocks.setOpeningBalanceInTx.mockRejectedValue(new BusinessError('ditolak', code));
    const r = await patch({ balance: 500 });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'ditolak', code });
  });

  it('403 for throughLock without period.lock', async () => {
    const r = await patch({ balance: 500, throughLock: { reason: 'Saldo awal dari auditor eksternal' } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe(OPENING_LOCK_RIGHT);
    expect(mocks.hasCap).toHaveBeenCalledWith('Accountant', 'period.lock');
    expect(mocks.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it('403 for throughLock through AIRA, even with period.lock', async () => {
    mocks.hasCap.mockResolvedValue(true);
    const r = await patch({ balance: 500, throughLock: { reason: 'Saldo awal dari auditor eksternal' } }, { role: 'Admin', via: 'mcp' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe(OPENING_LOCK_RIGHT);
    expect(mocks.setOpeningBalanceInTx).not.toHaveBeenCalled();
  });

  it('passes throughLock with period.lock', async () => {
    mocks.hasCap.mockResolvedValue(true);
    const r = await patch({ balance: 500, throughLock: { reason: 'Saldo awal dari auditor eksternal' } }, { role: 'Admin' });
    expect(r.status).toBe(200);
    expect(mocks.setOpeningBalanceInTx.mock.calls[0][1].throughLock).toEqual({ reason: 'Saldo awal dari auditor eksternal' });
  });
});
