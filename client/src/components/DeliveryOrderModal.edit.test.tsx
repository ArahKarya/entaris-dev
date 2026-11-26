import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, put, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get, post, put, patch } }));
vi.mock('@/lib/permissions', () => ({ cap: () => false }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import DeliveryOrderModal from './DeliveryOrderModal';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

const CUSTOMER = { id: 'p-1', name: 'PT Contoh Demo', partyType: 'Customer' };
const INV = [{ id: 'inv-1', code: 'BRS', name: 'Beras Uji', unit: 'Kg', isActive: true, currentStock: 30 }];
const EDIT_DO = {
  id: 'do-1',
  doNumber: 'DO-211504-0001',
  date: '2115-04-07T00:00:00.000Z',
  partyId: CUSTOMER.id,
  nomorMobil: 'B 1 AB',
  driverName: 'Andreas',
  recipientName: null,
  notes: null,
  items: [{ id: 'l-1', inventoryItemId: 'inv-1', warehouseId: 'w-1', itemName: 'Beras Uji', quantity: 100, unit: 'Kg', description: null }],
};

function serve() {
  get.mockImplementation(async (url: string) => {
    if (url === '/parties') return { data: { data: [CUSTOMER], total: 1 } };
    if (url.startsWith('/parties/')) return { data: CUSTOMER };
    // Only 30 kg left in the warehouse: the note's own 100 kg already went out of it.
    if (url === '/inventory/items') return { data: { data: INV } };
    if (url.startsWith('/warehouses')) return { data: { data: [{ id: 'w-1', name: 'Gudang 1' }] } };
    return { data: [] };
  });
}

function renderEdit() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeliveryOrderModal onClose={() => undefined} editDO={EDIT_DO} />
    </QueryClientProvider>,
  );
}

const submit = async () => {
  const button = await screen.findByRole('button', { name: /simpan surat jalan/i });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
};

beforeEach(() => {
  for (const f of [get, post, put, patch]) f.mockReset();
  put.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
  serve();
});

describe('DeliveryOrderModal — edit', () => {
  it('sends a header-only change as PATCH, so stock and cost stay as they are', async () => {
    renderEdit();
    fireEvent.change(await screen.findByDisplayValue('Andreas'), { target: { value: 'Budi' } });
    await submit();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('/delivery-orders/do-1', { nomorMobil: 'B 1 AB', driverName: 'Budi', recipientName: null, notes: null });
    expect(put).not.toHaveBeenCalled();
  });

  it('sends a quantity change as PUT with the lines', async () => {
    renderEdit();
    fireEvent.change(await screen.findByDisplayValue('100'), { target: { value: '120' } });
    await submit();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [endpoint, body] = put.mock.calls[0]!;
    expect(endpoint).toBe('/delivery-orders/do-1');
    expect(body.items).toEqual([expect.objectContaining({ inventoryItemId: 'inv-1', warehouseId: 'w-1', quantity: 120 })]);
    expect(patch).not.toHaveBeenCalled();
  });
});
