import { describe, it, expect, vi } from 'vitest';
import { BusinessError } from '../errors';
import { STALE_STATUS_ERROR } from '../../services/paymentRequestRules';
import { STALE_STATUS, cancelTrail, cancelTrailData, claimCancel, tryClaimCancel } from '../cancelClaim';
import { CancelReasonSchema } from '../schemas';

const delegate = (count: number) => ({ updateMany: vi.fn().mockResolvedValue({ count }) });

describe('claimCancel', () => {
  it('flips a status document only while it is not cancelled yet', async () => {
    const d = delegate(1);
    const at = new Date();
    await claimCancel(d, 'doc-1', { status: 'Cancelled', cancelledAt: at });
    expect(d.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', status: { not: 'Cancelled' } },
      data: { status: 'Cancelled', cancelledAt: at },
    });
  });

  it('guards on the cancelled value the caller writes (guarantees use Dibatalkan)', async () => {
    const d = delegate(1);
    await claimCancel(d, 'g-1', { status: 'Dibatalkan' });
    expect(d.updateMany.mock.calls[0][0].where).toEqual({ id: 'g-1', status: { not: 'Dibatalkan' } });
  });

  it('guards a flag document on isCancelled false', async () => {
    const d = delegate(1);
    await claimCancel(d, 'app-1', { isCancelled: true });
    expect(d.updateMany.mock.calls[0][0].where).toEqual({ id: 'app-1', isCancelled: false });
  });

  it('throws STALE_STATUS when another request already claimed the row', async () => {
    const err = await claimCancel(delegate(0), 'doc-1', { status: 'Cancelled' }).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe(STALE_STATUS);
    expect(err.message).toBe(STALE_STATUS_ERROR);
  });

  it('tryClaimCancel reports a lost claim as false instead of throwing', async () => {
    expect(await tryClaimCancel(delegate(0), 'j-1', { status: 'Cancelled' })).toBe(false);
    expect(await tryClaimCancel(delegate(1), 'j-1', { status: 'Cancelled' })).toBe(true);
  });
});

describe('cancel trail', () => {
  it('keeps the user and a trimmed reason; a blank reason is stored as null', () => {
    expect(cancelTrail('u-1', '  salah input  ')).toEqual({ cancelledById: 'u-1', cancelReason: 'salah input' });
    expect(cancelTrail('u-1', '   ')).toEqual({ cancelledById: 'u-1', cancelReason: null });
    expect(cancelTrail('u-1')).toEqual({ cancelledById: 'u-1', cancelReason: null });
  });

  it('adds no columns without a trail, so system voids keep their old update', () => {
    expect(cancelTrailData(undefined)).toEqual({});
    expect(cancelTrailData(cancelTrail('u-1', 'x'))).toEqual({ cancelledById: 'u-1', cancelReason: 'x' });
  });

  it('accepts no body, a null reason and 500 characters; rejects 501', () => {
    expect(CancelReasonSchema.safeParse({}).success).toBe(true);
    expect(CancelReasonSchema.safeParse({ reason: null }).success).toBe(true);
    expect(CancelReasonSchema.safeParse({ reason: 'a'.repeat(500) }).success).toBe(true);
    const tooLong = CancelReasonSchema.safeParse({ reason: 'a'.repeat(501) });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0].message).toBe('Alasan pembatalan maksimal 500 karakter.');
  });
});
