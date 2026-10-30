// Year close and reopen without a database (E1-R8, PR-8a). A missing CURRENT_PROFIT or
// RETAINED_EARNINGS mapping is a 400 with ACCOUNT_MAPPING_MISSING (it was a plain Error, so a
// 500), raised before anything is written. A reopen without a reason is refused before the
// transaction starts. The DB paths are covered by fiscalYearReopen.integration.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';
import { callRoute } from '../../__tests__/helpers/routeHarness';

const db = vi.hoisted(() => ({ transaction: null as any }));
vi.mock('../../lib/prisma', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => db.transaction(...args),
  },
}));
vi.mock('../../middleware/auth', () => ({
  requireCap: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { systemAccounts } from '../../services/systemAccounts';
import router, { ACCOUNT_MAPPING_MISSING } from '../fiscalYears';

const YEAR = { id: 'fy-1', name: '2025', startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31'), isClosed: false };

function setup() {
  const auto = makeAutoTx({ 'fiscalYear.findUnique': () => YEAR });
  db.transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(auto.tx));
  return auto;
}

afterEach(() => vi.restoreAllMocks());

describe('POST /fiscal-years/:id/close with an unmapped system account', () => {
  it.each(['CURRENT_PROFIT', 'RETAINED_EARNINGS'])('%s missing: 400 ACCOUNT_MAPPING_MISSING, nothing written', async (role) => {
    const { fn } = setup();
    vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (r) =>
      r === role ? [] : [{ id: `acc-${r}`, accountNumber: '3.x', name: r }],
    );

    const r = await callRoute(router, 'post', '/:id/close', { params: { id: YEAR.id }, userId: 'u-1' });

    expect(r.status).toBe(400);
    expect(r.body.code).toBe(ACCOUNT_MAPPING_MISSING);
    expect(r.body.error).toMatch(/^Akun sistem untuk "Laba (Ditahan|Tahun Berjalan)" belum dikonfigurasi/);
    for (const write of ['journalEntry.create', 'accountingLedgerEntry.createMany', 'fiscalYearEvent.create', 'fiscalYear.update']) {
      expect(fn(write)).not.toHaveBeenCalled();
    }
  });
});

describe('POST /fiscal-years/:id/reopen body', () => {
  it.each([[{}], [{ reason: '' }], [{ reason: '  abcd ' }]])('%j: 400 before the transaction', async (body) => {
    setup();
    const r = await callRoute(router, 'post', '/:id/reopen', { params: { id: YEAR.id }, body, userId: 'u-1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Alasan membuka kembali tahun buku wajib diisi (minimal 5 karakter).');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
