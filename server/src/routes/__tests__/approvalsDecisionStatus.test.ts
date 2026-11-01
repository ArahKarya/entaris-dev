/**
 * E7-R1: approve, reject and request-revision answer 409 when another decision got there first
 * (STALE_STATUS) or still holds the request (APPROVAL_BUSY); every other failure stays 400.
 * Resubmit of a request that moved on since the status check answers 409 STALE_STATUS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decide, findUnique, applyResubmit } = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret-value-0123456789';
  return { decide: vi.fn(), findUnique: vi.fn(), applyResubmit: vi.fn() };
});
vi.mock('../../lib/prisma', () => ({ prisma: { approvalRequest: { findUnique } } }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../services/permissionService', () => ({
  hasCap: async (_role: string, cap: string) => cap === 'approval.decide',
  can: async () => true,
}));
vi.mock('../../services/approvalDecision', () => ({ decideApproval: (...a: unknown[]) => decide(...a) }));
vi.mock('../../services/approvalResubmit', async (orig) => ({
  ...(await orig<typeof import('../../services/approvalResubmit')>()),
  applyResubmit: (...a: unknown[]) => applyResubmit(...a),
}));

import approvalsRouter from '../approvals';
import { callRoute } from '../../__tests__/helpers/routeHarness';
import { BusinessError } from '../../utils/errors';

const actor = { userId: 'approver', role: 'Approver' };
const DECISIONS = [
  ['/requests/:id/approve', 'approve'],
  ['/requests/:id/reject', 'reject'],
  ['/requests/:id/request-revision', 'revise'],
] as const;

beforeEach(() => vi.clearAllMocks());

describe.each(DECISIONS)('POST %s', (path, action) => {
  it.each([
    ['STALE_STATUS', 'Pengajuan sudah diproses.'],
    ['APPROVAL_BUSY', 'Pengajuan sedang diproses, coba lagi.'],
  ])('%s → 409 with the code', async (code, error) => {
    decide.mockResolvedValue({ ok: false, error, code });
    const res = await callRoute(approvalsRouter, 'post', path, { params: { id: 'req-1' }, body: { notes: 'n' }, ...actor });
    expect(res).toEqual({ status: 409, body: { error, code } });
    expect(decide).toHaveBeenCalledWith({ requestId: 'req-1', action, actorUserId: 'approver', note: 'n' });
  });

  it.each([
    ['PERIOD_LOCKED', 'Periode terkunci.'],
    ['PERIOD_CLOSED', 'Tahun buku sudah ditutup.'],
  ])('%s stays 400', async (code, error) => {
    decide.mockResolvedValue({ ok: false, error, code });
    const res = await callRoute(approvalsRouter, 'post', path, { params: { id: 'req-1' }, ...actor });
    expect(res).toEqual({ status: 400, body: { error, code } });
  });

  it('a failure without a code stays 400', async () => {
    decide.mockResolvedValue({ ok: false, error: 'Alasan revisi wajib diisi.' });
    const res = await callRoute(approvalsRouter, 'post', path, { params: { id: 'req-1' }, ...actor });
    expect(res).toEqual({ status: 400, body: { error: 'Alasan revisi wajib diisi.' } });
  });
});

describe('PUT /requests/:id/resubmit', () => {
  const request = { id: 'req-1', requestedBy: 'staff', status: 'NeedsRevision', documentType: 'ProductionRun' };
  const payload = { date: '2026-05-04', inputs: [{ itemId: 'in-1', quantity: 10 }], outputs: [{ itemId: 'out-1', quantity: 6 }] };

  it('answers 409 STALE_STATUS when the request moved on after the status check', async () => {
    findUnique.mockResolvedValue(request);
    applyResubmit.mockRejectedValue(new BusinessError('Pengajuan sudah diproses.', 'STALE_STATUS'));
    const res = await callRoute(approvalsRouter, 'put', '/requests/:id/resubmit', {
      params: { id: 'req-1' }, body: { payload }, userId: 'staff', role: 'Staff',
    });
    expect(res).toEqual({ status: 409, body: { error: 'Pengajuan sudah diproses.', code: 'STALE_STATUS' } });
  });

  it('answers with the re-read row on success', async () => {
    findUnique.mockResolvedValue(request);
    const row = { id: 'req-1', status: 'Pending', amount: 10 };
    applyResubmit.mockResolvedValue(row);
    const res = await callRoute(approvalsRouter, 'put', '/requests/:id/resubmit', {
      params: { id: 'req-1' }, body: { payload }, userId: 'staff', role: 'Staff',
    });
    expect(res).toEqual({ status: 200, body: row });
    expect(applyResubmit).toHaveBeenCalledWith(expect.anything(), 'req-1', payload, 10);
  });

  it('any other failure stays 500', async () => {
    findUnique.mockResolvedValue(request);
    applyResubmit.mockRejectedValue(new Error('db down'));
    const res = await callRoute(approvalsRouter, 'put', '/requests/:id/resubmit', {
      params: { id: 'req-1' }, body: { payload }, userId: 'staff', role: 'Staff',
    });
    expect(res).toEqual({ status: 500, body: { error: 'Gagal mengajukan ulang.' } });
  });
});
