import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

const { get, post, toastError, toastSuccess } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ default: { get, post } }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { FiscalYearCloseDialog, type CloseChecklist, type CloseCheckResult } from './FiscalYearCloseDialog';

const YEAR = { id: 'fy-1', name: '2096' };

const ok = (id: string, severity: 'block' | 'warn' = 'block', baselinedCount = 0): CloseCheckResult => ({
  id, severity, status: 'ok', count: 0, baselinedCount, items: [],
});

function list(overrides: Partial<CloseChecklist> & { checks: CloseCheckResult[] }): CloseChecklist {
  return {
    fiscalYear: { id: YEAR.id, name: YEAR.name, startDay: '2096-01-01', endDay: '2096-12-31', isClosed: false },
    canClose: true,
    blocking: 0,
    warnings: 0,
    ...overrides,
  };
}

const blocked = list({
  canClose: false,
  blocking: 1,
  warnings: 1,
  checks: [
    ok('prev-year-open'),
    {
      id: 'depreciation-unposted', severity: 'block', status: 'fail', count: 1, baselinedCount: 0,
      items: [{ key: 'd1', kind: 'DepreciationEntry', label: 'FA-0001 Mesin giling', date: '2096-12-01', amount: '10000000.00' }],
    },
    ok('ale-vs-journal', 'block', 2),
    {
      id: 'do-uninvoiced', severity: 'warn', status: 'fail', count: 7, baselinedCount: 0,
      items: Array.from({ length: 7 }, (_, n) => ({ key: `do${n}`, kind: 'DeliveryOrder', label: `DO-2096-${n}` })),
    },
  ],
});

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FiscalYearCloseDialog year={YEAR} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const closeButton = () => screen.getByRole('button', { name: /tutup buku|close year/i });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe('FiscalYearCloseDialog', () => {
  it('lists blocking checks and warnings and keeps the close disabled', async () => {
    get.mockResolvedValue({ data: blocked });
    renderDialog();

    const block = await screen.findByTestId('close-check-depreciation-unposted');
    expect(get).toHaveBeenCalledWith('/fiscal-years/fy-1/close-checklist');
    expect(within(block).getByText('FA-0001 Mesin giling')).toBeInTheDocument();
    expect(block.className).toMatch(/danger/);

    const warn = screen.getByTestId('close-check-do-uninvoiced');
    expect(warn.className).toMatch(/warning/);
    // Five delivery notes are listed, the other two are summed up.
    expect(within(warn).getAllByText(/^DO-2096-/)).toHaveLength(5);
    expect(within(warn).getByText(/\+2/)).toBeInTheDocument();

    // A passed check with baselined items says so.
    expect(screen.getByText(/2 (selisih lama|old differences)/)).toBeInTheDocument();
    expect(closeButton()).toBeDisabled();
  });

  it('closes when nothing blocks, even with warnings', async () => {
    get.mockResolvedValue({
      data: list({ warnings: 1, checks: [ok('prev-year-open'), { ...blocked.checks[3]! }] }),
    });
    post.mockResolvedValue({ data: { id: YEAR.id, isClosed: true } });
    const { onOpenChange } = renderDialog();

    await screen.findByTestId('close-check-do-uninvoiced');
    await waitFor(() => expect(closeButton()).toBeEnabled());
    fireEvent.click(closeButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/fiscal-years/fy-1/close'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('a refusal from the server replaces the checklist with the one it returns', async () => {
    get.mockResolvedValue({ data: list({ checks: [ok('prev-year-open'), ok('depreciation-unposted')] }) });
    post.mockRejectedValue({
      response: { data: { error: 'Tahun buku 2096 belum bisa ditutup', code: 'CLOSE_CHECKLIST_FAILED', checklist: blocked } },
    });
    renderDialog();

    await waitFor(() => expect(closeButton()).toBeEnabled());
    fireEvent.click(closeButton());
    expect(await screen.findByTestId('close-check-depreciation-unposted')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith('Tahun buku 2096 belum bisa ditutup');
    expect(closeButton()).toBeDisabled();
  });

  it('labels a check it does not know by its id', async () => {
    get.mockResolvedValue({
      data: list({
        canClose: false,
        blocking: 1,
        checks: [{ id: 'inventory-vs-gl', severity: 'block', status: 'fail', count: 1, baselinedCount: 0, items: [{ key: 'x', kind: 'Item', label: 'Beras' }] }],
      }),
    });
    renderDialog();
    const row = await screen.findByTestId('close-check-inventory-vs-gl');
    expect(within(row).getByText(/inventory-vs-gl/)).toBeInTheDocument();
  });

  it('shows a missing system-account role in the user language, not the server label', async () => {
    get.mockResolvedValue({
      data: list({
        canClose: false,
        blocking: 1,
        checks: [{
          id: 'system-accounts', severity: 'block', status: 'fail', count: 1, baselinedCount: 0,
          items: [{ key: 'CURRENT_PROFIT', kind: 'SystemAccountRole', label: 'Laba Tahun Berjalan' }],
        }],
      }),
    });
    await i18n.changeLanguage('en');
    try {
      renderDialog();
      const row = await screen.findByTestId('close-check-system-accounts');
      expect(within(row).getByText('Current Year Profit')).toBeInTheDocument();
      expect(within(row).queryByText('Laba Tahun Berjalan')).not.toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('id');
    }
  });
});
