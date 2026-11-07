/** PR-5.7b: GET /api/coa/:id/opening reads through describeAccountOpening and never writes. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret-value-0123456789';
  return { describeAccountOpening: vi.fn(), accountFind: vi.fn(), write: vi.fn() };
});
vi.mock('../../lib/prisma', () => ({
  prisma: {
    account: { findUnique: mocks.accountFind },
    companySettings: { upsert: mocks.write, update: mocks.write },
    $transaction: mocks.write,
  },
}));
vi.mock('../../services/ledger/openingBalance', async (orig) => ({
  ...(await orig<typeof import('../../services/ledger/openingBalance')>()),
  describeAccountOpening: mocks.describeAccountOpening,
}));

import coaRouter from '../coa';
import { BusinessError } from '../../utils/errors';

type Result = { status: number; body: any };

async function get(id = 'acc-1'): Promise<Result> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } };
  const layer = (coaRouter.stack as Layer[]).find((l) => l.route?.path === '/:id/opening' && l.route.methods.get)!;
  const result: Result = { status: 200, body: undefined };
  const res = {
    status(code: number) { result.status = code; return res; },
    json(b: unknown) { result.body = b; return res; },
  };
  const req = { method: 'GET', params: { id }, query: {}, headers: {}, user: { userId: 'u1', role: 'Viewer' } };
  for (const { handle } of layer.route!.stack) await handle(req, res, () => undefined);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountFind.mockResolvedValue({ id: 'acc-1' });
  mocks.describeAccountOpening.mockResolvedValue({ cutoverDate: '2150-01-01', cutoverStored: false, amount: null, journals: [], legacyJournals: [], sameDayOpeningEquity: [], editable: true, reason: null });
});

describe('GET /coa/:id/opening', () => {
  it('returns the opening view and writes nothing across two calls', async () => {
    const a = await get();
    const b = await get();
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body).toMatchObject({ cutoverDate: '2150-01-01', cutoverStored: false, amount: null, editable: true });
    expect(mocks.describeAccountOpening).toHaveBeenCalledTimes(2);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown account', async () => {
    mocks.accountFind.mockResolvedValue(null);
    expect((await get('nope')).status).toBe(404);
    expect(mocks.describeAccountOpening).not.toHaveBeenCalled();
  });

  it('keeps the service error code (no open fiscal year)', async () => {
    mocks.describeAccountOpening.mockRejectedValue(new BusinessError('Belum ada tahun buku terbuka.', 'FISCAL_YEAR_MISSING'));
    const r = await get();
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FISCAL_YEAR_MISSING');
  });
});
