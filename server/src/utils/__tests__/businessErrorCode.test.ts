import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { BusinessError, handleRouteError, isDeadlock, isLedgerUnbalanced, STOCK_BUSY, STOCK_BUSY_MESSAGE } from '../errors';

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

describe('handleRouteError with a Postgres deadlock (40P01)', () => {
  const deadlock = (shape: 'adapter' | 'meta' | 'cause') => {
    const message = 'deadlock detected';
    if (shape === 'adapter') {
      return Object.assign(new Error(`Raw query failed. Code: \`40P01\`. Message: \`${message}\``), {
        code: 'P2010',
        meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'postgres', code: '40P01', originalCode: '40P01' } } },
      });
    }
    if (shape === 'meta') return Object.assign(new Error(message), { meta: { code: '40P01' } });
    return Object.assign(new Error('Transaction failed'), { cause: { kind: 'postgres', code: '40P01', message } });
  };

  it.each(['adapter', 'meta', 'cause'] as const)('maps a deadlock (%s) to 409 STOCK_BUSY so the client retries', (shape) => {
    const res = mockRes();
    handleRouteError(res, deadlock(shape), 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: STOCK_BUSY_MESSAGE, code: STOCK_BUSY });
  });

  it('leaves other Postgres errors alone', () => {
    expect(isDeadlock(Object.assign(new Error('lock timeout'), { meta: { code: '55P03' } }))).toBe(false);
    expect(isDeadlock(null)).toBe(false);
    const res = mockRes();
    handleRouteError(res, Object.assign(new Error('boom'), { code: 'XX000' }), 'ctx', 'fallback');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
