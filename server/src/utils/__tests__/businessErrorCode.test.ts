import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { BusinessError, handleRouteError, isLedgerUnbalanced } from '../errors';

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('handleRouteError with BusinessError codes', () => {
  it('passes a stable code next to the message', () => {
    const res = mockRes();
    handleRouteError(res, new BusinessError('Stok tidak mencukupi.', 'GR_CANCEL_INSUFFICIENT_STOCK'), 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Stok tidak mencukupi.', code: 'GR_CANCEL_INSUFFICIENT_STOCK' });
  });

  it('keeps the old shape without a code', () => {
    const res = mockRes();
    handleRouteError(res, new BusinessError('Data tidak valid.'), 'ctx', 'fallback');
    expect(res.json).toHaveBeenCalledWith({ error: 'Data tidak valid.' });
  });
});

describe('handleRouteError with ledger balance trigger errors', () => {
  const unbalanced = (shape: 'direct' | 'meta' | 'cause') => {
    const message = 'ALE group CustomerPayment/abc is unbalanced: debit 100 credit 50';
    if (shape === 'direct') return Object.assign(new Error(message), { code: '23514' });
    if (shape === 'meta') return Object.assign(new Error('Invalid `prisma.$transaction()` invocation'), { code: 'P2010', meta: { code: '23514', message } });
    return Object.assign(new Error('Transaction failed'), { cause: { code: '23514', message } });
  };

  it.each(['direct', 'meta', 'cause'] as const)('maps a 23514 "unbalanced" error (%s) to 409 LEDGER_UNBALANCED', (shape) => {
    const res = mockRes();
    handleRouteError(res, unbalanced(shape), 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Jurnal tidak seimbang di buku besar; transaksi dibatalkan.', code: 'LEDGER_UNBALANCED' });
  });

  it('maps the fiscal year split message too', () => {
    const e = Object.assign(new Error('ALE group X has a fiscal year split'), { code: '23514' });
    expect(isLedgerUnbalanced(e)).toBe(true);
  });

  it('leaves an ordinary CHECK violation and other SQLSTATEs alone', () => {
    expect(isLedgerUnbalanced(Object.assign(new Error('violates check constraint "positive_qty"'), { code: '23514' }))).toBe(false);
    expect(isLedgerUnbalanced(Object.assign(new Error('unbalanced'), { code: '23505' }))).toBe(false);
    expect(isLedgerUnbalanced(null)).toBe(false);
    expect(isLedgerUnbalanced('unbalanced')).toBe(false);
    const res = mockRes();
    handleRouteError(res, Object.assign(new Error('boom'), { code: '23514' }), 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
