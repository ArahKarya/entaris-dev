import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get, post } }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError, info: vi.fn() } }));

import { StockOpnameCountForm } from './StockOpnameCountForm';

const GKP = { itemId: 'item-gkp', code: 'GKP', name: 'Gabah Kering Panen', unit: 'Kg', systemStock: 10000 };
const BRS = { itemId: 'item-brs', code: 'BRS', name: 'Beras', unit: 'Kg', systemStock: 500 };

/** System stock answers, one per GET /stock-opname/system-stock call (the last one repeats). */
let stockAnswers: (typeof GKP)[][] = [];
const systemStockCalls = () => get.mock.calls.filter(([url]) => url === '/stock-opname/system-stock');

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toastError.mockReset();
  stockAnswers = [[GKP, BRS]];
  post.mockResolvedValue({ data: {} });
  get.mockImplementation(async (url: string, config?: { params?: { date?: string } }) => {
    if (url.startsWith('/warehouses')) return { data: { data: [{ id: 'wh-1', code: 'GU', name: 'Gudang Utama', isDefault: true }] } };
    if (url === '/stock-opname/system-stock') {
      const items = stockAnswers.length > 1 ? stockAnswers.shift()! : stockAnswers[0];
      return { data: { warehouseId: 'wh-1', date: config?.params?.date, items } };
    }
    return { data: {} };
  });
});

function renderForm(onSuccess = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StockOpnameCountForm breadcrumb={null} onBack={vi.fn()} onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

const countInput = (name: string) => screen.findByLabelText(`Stok aktual ${name}`);
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Simpan & Proses' }));
const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

describe('StockOpnameCountForm: stock as of the count date (E3-R11)', () => {
  it('loads the system stock of the warehouse for the count date, without a unit cost column', async () => {
    renderForm();
    await countInput(GKP.name);
    const [, config] = systemStockCalls()[0];
    expect(config.params).toMatchObject({ warehouseId: 'wh-1', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(screen.getByText('Stok Sistem per Tanggal')).toBeInTheDocument();
    expect(screen.queryByText(/Nilai\/Satuan/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Nilai per satuan/)).not.toBeInTheDocument();
  });

  it('reloads the system stock when the date changes', async () => {
    renderForm();
    await countInput(GKP.name);
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2117-06-30' } });
    await waitFor(() => expect(systemStockCalls().some(([, c]) => c.params.date === '2117-06-30')).toBe(true));
  });

  it('sends only the lines the user filled in, each with the system stock the form showed', async () => {
    const { onSuccess } = renderForm();
    fireEvent.change(await countInput(GKP.name), { target: { value: '9990' } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/stock-opname');
    expect(body).toMatchObject({ warehouseId: 'wh-1' });
    expect(body.items).toEqual([{ itemId: GKP.itemId, actualStock: 9990, expectedSystemStock: 10000 }]);
    expect(body.items[0]).not.toHaveProperty('unitCost');
    // The stock as of the date was loaded again right before the post.
    expect(systemStockCalls().length).toBe(2);
    expect(onSuccess).toHaveBeenCalled();
  });

  it('untouched lines are not a difference: with nothing filled in nothing is sent', async () => {
    renderForm();
    await countInput(GKP.name);
    submit();
    expect(toastError).toHaveBeenCalledWith('Isi stok aktual minimal satu item.');
    expect(post).not.toHaveBeenCalled();
  });

  it('a stock that moved before submit marks the line in place and does not send', async () => {
    stockAnswers = [[GKP, BRS], [{ ...GKP, systemStock: 8000 }, BRS]];
    renderForm();
    fireEvent.change(await countInput(GKP.name), { target: { value: '9990' } });
    submit();
    expect(await screen.findByText('Stok sistem berubah dari 10.000 ke 8.000. Periksa lagi hitungannya.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    // The row now shows the reloaded system stock; the next submit sends it as the expected stock.
    expect(within(rowOf(GKP.name)).getByText('8.000')).toBeInTheDocument();
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].items).toEqual([{ itemId: GKP.itemId, actualStock: 9990, expectedSystemStock: 8000 }]);
  });

  it('409 OPNAME_STOCK_CHANGED marks the listed lines in place and reloads the system stock', async () => {
    post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: 'Stok sistem 1 item berubah sejak form dibuka (Gabah Kering Panen).',
          code: 'OPNAME_STOCK_CHANGED',
          items: [{ itemId: GKP.itemId, itemName: GKP.name, expectedSystemStock: '10000', systemStock: '8000' }],
        },
      },
    });
    // Before submit: unchanged (10.000); after the 409: the reload sees 8.000.
    stockAnswers = [[GKP, BRS], [GKP, BRS], [{ ...GKP, systemStock: 8000 }, BRS]];
    const { onSuccess } = renderForm();
    fireEvent.change(await countInput(GKP.name), { target: { value: '9990' } });
    submit();
    expect(await screen.findByText('Stok sistem berubah dari 10.000 ke 8.000. Periksa lagi hitungannya.')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('1 item berubah'));
    await waitFor(() => expect(within(rowOf(GKP.name)).getByText('8.000')).toBeInTheDocument());
    expect(systemStockCalls().length).toBe(3);
    expect(onSuccess).not.toHaveBeenCalled();
    // Editing the marked line clears the mark.
    fireEvent.change(await countInput(GKP.name), { target: { value: '7990' } });
    expect(screen.queryByText(/Stok sistem berubah dari/)).not.toBeInTheDocument();
  });

  it('other errors show the server message', async () => {
    post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Ada opname lebih baru.', code: 'OPNAME_LATER_COUNT_EXISTS' } } });
    renderForm();
    fireEvent.change(await countInput(BRS.name), { target: { value: '0' } });
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Ada opname lebih baru.'));
    expect(post.mock.calls[0][1].items).toEqual([{ itemId: BRS.itemId, actualStock: 0, expectedSystemStock: 500 }]);
  });
});
