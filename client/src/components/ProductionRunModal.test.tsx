import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { get, post, put, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../lib/api', () => ({ default: { get, post, put } }));
vi.mock('sonner', () => ({ toast }));
const perms = vi.hoisted(() => ({ caps: [] as string[] }));
vi.mock('../lib/permissions', async (orig) => ({
  ...(await orig<typeof import('../lib/permissions')>()),
  cap: (name: string) => perms.caps.includes(name),
}));

import { ProductionRunModal } from './ProductionRunModal';

const items = [
  { id: 'i1', name: 'GKP', sku: 'GKP', unit: 'Kg', currentStock: 1000, averageCost: 100, type: 'RAW' },
  { id: 'i2', name: 'Beras', sku: 'BRS', unit: 'Kg', currentStock: 0, averageCost: 0, type: 'FINISHED' },
];
const payload = {
  date: '2026-10-14',
  warehouseId: 'w1',
  inputs: [{ itemId: 'i1', quantity: 100 }],
  outputs: [{ itemId: 'i2', quantity: 60, unitPrice: 0, isByProduct: false }],
  costs: [],
};

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
beforeEach(() => {
  for (const m of [get, post, put, toast.success, toast.error, toast.warning]) m.mockReset();
  perms.caps = [];
  get.mockResolvedValue({ data: [] });
});

function renderModal(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProductionRunModal
          isOpen
          onClose={onClose}
          items={items as never}
          prefillPayload={payload}
          draft={{ id: 'd1', draftNumber: 'DPR-1' }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('ProductionRunModal: Simpan & Posting', () => {
  it('menyimpan draft lalu memposting, dan menutup dialog', async () => {
    put.mockResolvedValue({ data: { draft: { id: 'd1', draftNumber: 'DPR-1' } } });
    post.mockResolvedValue({ data: { runNumber: 'PR-202610-0009' } });
    const onClose = renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /simpan & posting|save & post/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inventory/production-runs/drafts/d1/post'));
    expect(put).toHaveBeenCalledTimes(1); // simpan dulu, baru posting
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
    expect(onClose).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('jika posting gagal, draft tetap tersimpan dan user diberi tahu (bukan sukses palsu)', async () => {
    put.mockResolvedValue({ data: { draft: { id: 'd1', draftNumber: 'DPR-1' } } });
    post.mockRejectedValue({ response: { data: { error: 'Stok tidak cukup.' } } });
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /simpan & posting|save & post/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0][0])).toContain('Stok tidak cukup.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('"Simpan Draft" biasa tetap tidak memposting', async () => {
    put.mockResolvedValue({ data: { draft: { id: 'd1', draftNumber: 'DPR-1' } } });
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /^simpan draft$|^save draft$/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });
});

describe('ProductionRunModal: resubmit dengan bypass stok minus tersimpan', () => {
  const bypassPayload = { ...payload, allowNegativeStock: true, negativeStockReason: 'Stok fisik sudah ada, belum diinput' };

  function renderResubmit() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ProductionRunModal isOpen onClose={vi.fn()} items={items as never} prefillPayload={bypassPayload} resubmitRequestId="r1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('tanpa capability, bypass dari payload lama dibuang agar resubmit tidak 403 terus', async () => {
    put.mockResolvedValue({ data: {} });
    renderResubmit();
    fireEvent.click(await screen.findByRole('button', { name: /^kirim ulang$|^resubmit$/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0];
    expect(url).toBe('/approvals/requests/r1/resubmit');
    expect(body.payload.allowNegativeStock).toBe(false);
    expect(body.payload.negativeStockReason).toBeNull();
  });

  it('pemegang inventory.negative_stock tetap mengirim bypass beserta alasannya', async () => {
    perms.caps = ['inventory.negative_stock'];
    put.mockResolvedValue({ data: {} });
    renderResubmit();
    fireEvent.click(await screen.findByRole('button', { name: /^kirim ulang$|^resubmit$/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][1];
    expect(body.payload.allowNegativeStock).toBe(true);
    expect(body.payload.negativeStockReason).toBe('Stok fisik sudah ada, belum diinput');
  });
});
