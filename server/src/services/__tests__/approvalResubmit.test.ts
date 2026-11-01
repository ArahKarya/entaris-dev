import { describe, expect, it, vi } from 'vitest';
import {
  applyResubmit,
  productionRunResubmitAmount,
  purchaseInvoiceResubmitAmount,
  resubmitAmount,
} from '../approvalResubmit';
import { BusinessError } from '../../utils/errors';

// Characterization tests: they pin the resubmit behaviour as it was in routes/approvals.ts
// before the extraction. PR-3.4, PR-3.5 and PR-3.7 change these functions on purpose
// (applyResubmit is conditional since PR-3.4).

const piItem = (over: Record<string, unknown> = {}) => ({ itemName: 'Gabah Kering Panen', quantity: 1000, rate: 6500, ...over });
const piPayload = (over: Record<string, unknown> = {}) => ({ date: '2026-05-04', partyId: 'p-1', items: [piItem()], ...over });

const prodPayload = (inputs: Array<Record<string, unknown>>) => ({
  date: '2026-05-04',
  inputs,
  outputs: [{ itemId: 'out-1', quantity: 600 }],
});

describe('purchaseInvoiceResubmitAmount', () => {
  it('sums the item amount field plus biayaLain', () => {
    const payload = { biayaLain: 250, items: [{ amount: 1000 }, { amount: '500' }, {}] };
    expect(purchaseInvoiceResubmitAmount(payload as never)).toBe(1750);
  });

  it('treats a missing biayaLain as zero', () => {
    expect(purchaseInvoiceResubmitAmount({ items: [{ amount: 40 }] } as never)).toBe(40);
  });
});

describe('productionRunResubmitAmount', () => {
  it('sums the input quantities', () => {
    const payload = { inputs: [{ quantity: 1000 }, { quantity: '250.5' }, {}] };
    expect(productionRunResubmitAmount(payload as never)).toBe(1250.5);
  });

  it('is zero without inputs', () => {
    expect(productionRunResubmitAmount({ inputs: [] } as never)).toBe(0);
  });
});

describe('resubmitAmount', () => {
  it('PurchaseInvoice: the schema strips item.amount, so only biayaLain counts', () => {
    const raw = piPayload({ items: [piItem({ amount: 6_500_000 }), piItem({ amount: 1_000_000 })], biayaLain: -15000 });
    expect(resubmitAmount('PurchaseInvoice', raw)).toEqual({ ok: true, amount: -15000 });
  });

  it('PurchaseInvoice: amount is zero without biayaLain', () => {
    expect(resubmitAmount('PurchaseInvoice', piPayload())).toEqual({ ok: true, amount: 0 });
  });

  it('PurchaseInvoice: an invalid payload returns the first Zod issue', () => {
    expect(resubmitAmount('PurchaseInvoice', piPayload({ items: [] }))).toEqual({
      ok: false,
      error: 'Data invoice tidak valid: Minimal satu item.',
    });
  });

  it('ProductionRun: sums the parsed input quantities', () => {
    const raw = prodPayload([{ itemId: 'in-1', quantity: '1000' }, { itemId: 'in-2', quantity: 200 }]);
    expect(resubmitAmount('ProductionRun', raw)).toEqual({ ok: true, amount: 1200 });
  });

  it('ProductionRun: an invalid payload returns the first Zod issue', () => {
    expect(resubmitAmount('ProductionRun', prodPayload([{ itemId: 'in-1', quantity: 0 }]))).toEqual({
      ok: false,
      error: 'Data produksi tidak valid: Kuantitas harus lebih dari 0.',
    });
  });

  it('returns null for every other document type', () => {
    for (const type of ['SalesInvoice', 'DeliveryOrder', 'ProductionRunEdit', 'PurchaseInvoiceRevisePrice', '']) {
      expect(resubmitAmount(type, piPayload())).toBeNull();
    }
  });
});

describe('applyResubmit', () => {
  const fakeDb = (count: number, row: unknown = { id: 'req-1', status: 'Pending' }) => {
    const updateMany = vi.fn(async () => ({ count }));
    const findUniqueOrThrow = vi.fn(async () => row);
    const db = { approvalRequest: { updateMany, findUniqueOrThrow } } as unknown as Parameters<typeof applyResubmit>[0];
    return { db, updateMany, findUniqueOrThrow };
  };

  it('stores the raw payload and amount, moves NeedsRevision back to Pending and returns the re-read row', async () => {
    const row = { id: 'req-1', status: 'Pending', amount: 1200 };
    const { db, updateMany, findUniqueOrThrow } = fakeDb(1, row);
    const rawPayload = { date: '2026-05-04', items: [{ amount: 9 }], extra: 'kept' };

    await expect(applyResubmit(db, 'req-1', rawPayload, 1200)).resolves.toBe(row);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'NeedsRevision' },
      data: { payload: rawPayload, amount: 1200, status: 'Pending', rejectedBy: null, decidedAt: null },
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'req-1' } });
  });

  it('throws STALE_STATUS when the request is no longer NeedsRevision, without reading it back', async () => {
    const { db, findUniqueOrThrow } = fakeDb(0);
    const err = await applyResubmit(db, 'req-1', { a: 1 }, 5).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(err).toMatchObject({ code: 'STALE_STATUS', message: 'Pengajuan sudah diproses.' });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
