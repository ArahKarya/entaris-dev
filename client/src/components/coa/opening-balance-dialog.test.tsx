import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, patch, perms } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), perms: { caps: [] as string[] } }));
vi.mock('@/lib/api', () => ({ default: { get, patch } }));
vi.mock('@/lib/permissions', () => ({ cap: (name: string) => perms.caps.includes(name), can: () => true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OpeningBalanceDialog, type AccountOpening } from './opening-balance-dialog';
import { openingFieldValue, openingPayload, type CoaNode } from './coa-tree';

// The running balance (999) differs from the recorded opening (500) on purpose.
const node = {
  id: 'acc-1', accountNumber: '1.1.1', name: 'Kas', rootType: 'ASSET', isGroup: false, isActive: true,
  balance: 999, subtotal: 999, shown: 999, shownSubtotal: 999, periodYearName: null, depth: 0, parentId: null, account: {}, children: [],
} as unknown as CoaNode;

const opening = (over: Partial<AccountOpening> = {}): AccountOpening => ({
  cutoverDate: '2096-01-01', cutoverStored: true, amount: '500.00', journals: [], legacyJournals: [], sameDayOpeningEquity: [], editable: true, reason: null, ...over,
});

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OpeningBalanceDialog node={node} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  perms.caps = [];
  patch.mockResolvedValue({ data: {} });
});

describe('payload helpers', () => {
  it('starts from the recorded amount and sends a two-decimal string', () => {
    expect(openingFieldValue('500.00')).toBe('500');
    expect(openingFieldValue(null)).toBe('0');
    expect(openingPayload(1500000.5, null)).toEqual({ balance: '1500000.50' });
    expect(openingPayload(10, 'koreksi saldo awal')).toEqual({ balance: '10.00', throughLock: { reason: 'koreksi saldo awal' } });
  });
});

describe('OpeningBalanceDialog', () => {
  it('fills the field from GET /coa/:id/opening, not from node.balance', async () => {
    get.mockResolvedValue({ data: opening() });
    renderDialog();
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    expect(get).toHaveBeenCalledWith('/coa/acc-1/opening');
    expect(input.value).toBe('500');
    expect(input.value).not.toContain('999');
    fireEvent.click(screen.getByRole('button', { name: /simpan|save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/coa/acc-1/balance', { balance: '500.00' }));
  });

  it('lists legacy journals and blocks saving', async () => {
    get.mockResolvedValue({
      data: opening({
        amount: null, editable: false, reason: 'OPENING_LEGACY_REVIEW',
        legacyJournals: [{ id: 'j1', entryNumber: 'OB-0001', date: '2096-03-01', amount: '300.00' }],
      }),
    });
    renderDialog();
    expect(await screen.findByText(/OB-0001/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /simpan|save/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the period lock option only to period.lock holders and sends the reason', async () => {
    get.mockResolvedValue({ data: opening() });
    const view = renderDialog();
    await screen.findByRole('textbox');
    expect(screen.queryByRole('checkbox')).toBeNull();
    view.unmount();

    perms.caps = ['period.lock'];
    renderDialog();
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('checkbox'));
    const reason = screen.getAllByRole('textbox')[1];
    fireEvent.change(reason, { target: { value: 'koreksi saldo awal Maret' } });
    fireEvent.click(screen.getByRole('button', { name: /simpan|save/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/coa/acc-1/balance', { balance: '500.00', throughLock: { reason: 'koreksi saldo awal Maret' } }),
    );
  });
});
