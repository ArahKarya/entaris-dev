import { describe, expect, it, vi } from 'vitest';

const { roleCaps } = vi.hoisted(() => ({ roleCaps: {} as Record<string, string[]> }));
vi.mock('../permissionService', () => ({
  hasCap: async (role: string, cap: string) => (roleCaps[role] ?? []).includes(cap),
}));

import {
  applyResubmit,
  productionRunResubmitAllowed,
  productionRunResubmitAmount,
  purchaseInvoiceResubmitAmount,
  resubmitAmount,
} from '../approvalResubmit';
import { BusinessError } from '../../utils/errors';

// Characterization tests: they pin the resubmit behaviour as it was in routes/approvals.ts
// before the extraction. PR-3.4, PR-3.5 and PR-3.7 change these functions on purpose
// (the purchase invoice amount is now the invoice grand total; applyResubmit is conditional since PR-3.4).

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

describe('productionRunResubmitAllowed', () => {
  roleCaps.Staff = [];
  roleCaps.Admin = ['inventory.negative_stock'];
  const bypass = { ...prodPayload([{ itemId: 'in-1', quantity: 10 }]), allowNegativeStock: true, negativeStockReason: 'Stok fisik sudah dihitung ulang' };

  it('refuses the negative-stock bypass without inventory.negative_stock', async () => {
    await expect(productionRunResubmitAllowed('Staff', 'ProductionRun', bypass)).resolves.toBe(false);
  });

  it('allows the bypass for a holder of inventory.negative_stock', async () => {
    await expect(productionRunResubmitAllowed('Admin', 'ProductionRun', bypass)).resolves.toBe(true);
  });

  it('allows a run without the bypass, and a flag that is not strictly true', async () => {
    await expect(productionRunResubmitAllowed('Staff', 'ProductionRun', prodPayload([]))).resolves.toBe(true);
    await expect(productionRunResubmitAllowed('Staff', 'ProductionRun', { ...bypass, allowNegativeStock: false })).resolves.toBe(true);
  });

  it('does not gate other document types', async () => {
    await expect(productionRunResubmitAllowed('Staff', 'PurchaseInvoice', bypass)).resolves.toBe(true);
  });
});
