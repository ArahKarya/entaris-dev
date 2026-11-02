import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BusinessError } from '../../../utils/errors';

const mocks = vi.hoisted(() => ({ findArSubledgerDiffs: vi.fn(), findCustomerDepositDiffs: vi.fn() }));
vi.mock('../../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../../services/ledger/arSubledgerCheck', () => mocks);

import { checkArSubledgerVsGl, checkCustomerDepositVsGl } from '../arChecks';

const AMBIGUOUS = 'Akun 1.2.1 Piutang Usaha dipetakan ke dua peran pihak (Piutang Usaha dan Uang Muka Customer). Perbaiki pemetaan di Pengaturan > Akun Sistem.';

beforeEach(() => vi.clearAllMocks());

describe('AR subledger health checks and an ambiguous party role mapping', () => {
  it('report the mapping as an error result instead of failing the whole health check', async () => {
    mocks.findArSubledgerDiffs.mockRejectedValue(new BusinessError(AMBIGUOUS, 'PARTY_ROLE_AMBIGUOUS'));
    mocks.findCustomerDepositDiffs.mockRejectedValue(new BusinessError(AMBIGUOUS, 'PARTY_ROLE_AMBIGUOUS'));
    expect(await checkArSubledgerVsGl()).toEqual({
      name: 'AR vs Subledger', status: 'error', message: AMBIGUOUS, count: 1, details: [], fixable: false,
    });
    expect(await checkCustomerDepositVsGl()).toMatchObject({ name: 'Customer Deposit vs Subledger', status: 'error', message: AMBIGUOUS });
  });

  it('let any other error through', async () => {
    mocks.findArSubledgerDiffs.mockRejectedValue(new Error('db down'));
    await expect(checkArSubledgerVsGl()).rejects.toThrow('db down');
  });
});
