import { describe, expect, it, vi } from 'vitest';
import {
  applyResubmit,
  productionRunResubmitAmount,
  purchaseInvoiceResubmitAmount,
  resubmitAmount,
} from '../approvalResubmit';

// Characterization tests: they pin the resubmit behaviour as it was in routes/approvals.ts
// before the extraction. PR-3.4, PR-3.5 and PR-3.7 change these functions on purpose
// (the purchase invoice amount is now the invoice grand total).

const piItem = (over: Record<string, unknown> = {}) => ({ itemName: 'Gabah Kering Panen', quantity: 1000, rate: 6500, ...over });
const piPayload = (over: Record<string, unknown> = {}) => ({ date: '2026-05-04', partyId: 'p-1', items: [piItem()], ...over });

const prodPayload = (inputs: Array<Record<string, unknown>>) => ({
  date: '2026-05-04',
  inputs,
  outputs: [{ itemId: 'out-1', quantity: 600 }],
});

describe('purchaseInvoiceResubmitAmount', () => {
  it('is the invoice grand total: Σ line totals (potongan per line deducted) + biayaLain', () => {
    const payload = {
      biayaLain: 250_000,
      items: [piItem({ timbanganDiterima: 1000, potonganItem: 100_000 }), piItem({ quantity: 1, rate: 3_600_000 })],
    };
    expect(purchaseInvoiceResubmitAmount(payload as never)).toBe(10_250_000);
  });

  it('treats a missing biayaLain as zero and ignores a stray item.amount', () => {
    expect(purchaseInvoiceResubmitAmount({ items: [piItem({ amount: 40 })] } as never)).toBe(6_500_000);
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
  it('PurchaseInvoice: the amount is the invoice grand total, not the stripped item.amount', () => {
    const raw = piPayload({ items: [piItem({ amount: 1 }), piItem({ quantity: 10, rate: 350_000 })], biayaLain: -15000 });
    expect(resubmitAmount('PurchaseInvoice', raw)).toEqual({ ok: true, amount: 9_985_000 });
  });

  it('PurchaseInvoice: a header potongan the lines do not carry is refused', () => {
    expect(resubmitAmount('PurchaseInvoice', piPayload({ potongan: 500_000 }))).toEqual({
      ok: false,
      error: 'Data invoice tidak valid: Potongan header harus sama dengan jumlah potongan per baris. Isi potongan di baris item.',
    });
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
  it('stores the raw payload and amount and moves the request back to Pending', async () => {
    const updated = { id: 'req-1', status: 'Pending' };
    const update = vi.fn(async () => updated);
    const db = { approvalRequest: { update } } as unknown as Parameters<typeof applyResubmit>[0];
    const rawPayload = { date: '2026-05-04', items: [{ amount: 9 }], extra: 'kept' };

    await expect(applyResubmit(db, 'req-1', rawPayload, 1200)).resolves.toBe(updated);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { payload: rawPayload, amount: 1200, status: 'Pending', rejectedBy: null, decidedAt: null },
    });
  });
});
