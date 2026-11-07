import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

const { get, post, put, toastError, toastSuccess } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ default: { get, post, put } }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { SystemAccountsTab } from './SystemAccountsTab';
import { SystemAccountReclassDialog, type ReclassBalance } from './settings/SystemAccountReclassDialog';

const residue: ReclassBalance = {
  role: 'AR', roleLabel: 'Piutang Usaha', fromAccountId: 'old', fromAccount: '1.2.1 Piutang lama',
  toAccountId: 'cur', toAccount: '1.2.2 Piutang', amount: '-3000000.00', partyCount: 1,
};

const data = {
  roles: [
    { key: 'AR', label: 'Piutang Usaha', description: 'Piutang', multiAccount: false, required: true, expectedRootType: 'ASSET', balanceMoves: true },
  ],
  mappings: { AR: [{ id: 'm1', accountId: 'cur', accountNumber: '1.2.2', accountName: 'Piutang', accountType: 'ASSET', sortOrder: 0 }] },
  formerResidues: [{ ...residue, sweepable: true }],
};

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SystemAccountsTab /></QueryClientProvider>);
}

beforeEach(async () => {
  await i18n.changeLanguage('id');
  get.mockReset();
  post.mockReset();
  put.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  get.mockImplementation(async (url: string) => ({
    data: url === '/system-accounts' ? data : [{ id: 'cur', accountNumber: '1.2.2', name: 'Piutang', rootType: 'ASSET', isGroup: false, isActive: true }],
  }));
});

describe('SystemAccountsTab former account residues', () => {
  it('sweeps a role\'s former account balance with a reason', async () => {
    post.mockResolvedValue({ data: { transfers: [] } });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Pindahkan sisa' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1.2.1 Piutang lama')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Pindahkan sisa' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Alasan'), { target: { value: '  Sisa batal invoice  ' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/system-accounts/AR/sweep', { reason: 'Sisa batal invoice' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });
});

describe('SystemAccountReclassDialog', () => {
  it('needs a reason of at least 5 characters before confirming a transfer', () => {
    const onConfirm = vi.fn();
    render(<SystemAccountReclassDialog mode="transfer" balances={[{ ...residue, amount: '500000000.00', partyCount: 2 }]} pending={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 pihak/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Pindahkan saldo dan simpan' });
    fireEvent.change(within(dialog).getByLabelText('Alasan'), { target: { value: 'abc' } });
    expect(within(dialog).getByText('Alasan minimal 5 karakter.')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Alasan'), { target: { value: 'Pindah akun' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Pindah akun');
  });

  it('is closed without balances', () => {
    render(<SystemAccountReclassDialog mode="sweep" balances={null} pending={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SystemAccountsTab role usage', () => {
  const usageData = {
    roles: [
      { key: 'AR', label: 'Piutang Usaha', description: 'Piutang', multiAccount: false, required: true, usage: 'posting', expectedRootType: 'ASSET' },
      { key: 'SALES_DISCOUNT', label: 'Diskon Penjualan', description: 'Diskon', multiAccount: false, required: false, usage: 'belum', expectedRootType: 'REVENUE' },
      { key: 'BANK_CHARGE', label: 'Biaya Bank', description: 'Biaya', multiAccount: false, required: false, usage: 'belum', expectedRootType: 'EXPENSE' },
    ],
    mappings: { AR: [{ id: 'm1', accountId: 'cur', accountNumber: '1.2.2', accountName: 'Piutang', accountType: 'ASSET', sortOrder: 0 }] },
    formerResidues: [],
  };

  beforeEach(() => {
    get.mockImplementation(async (url: string) => ({
      data: url === '/system-accounts' ? usageData : [{ id: 'cur', accountNumber: '1.2.2', name: 'Piutang', rootType: 'ASSET', isGroup: false, isActive: true }],
    }));
  });

  it('badges a posting role and hides roles not used yet behind a toggle', async () => {
    renderTab();
    expect(await screen.findByTestId('role-usage-AR')).toHaveTextContent('Dipakai posting otomatis');
    expect(screen.queryByText('Diskon Penjualan')).not.toBeInTheDocument();
    expect(screen.queryByText('Biaya Bank')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('show-unused-roles'));
    expect(await screen.findByText('Diskon Penjualan')).toBeInTheDocument();
    expect(screen.getByTestId('role-usage-SALES_DISCOUNT')).toHaveTextContent('Belum dipakai otomatis');
    expect(screen.getByTestId('role-usage-BANK_CHARGE')).toHaveTextContent('Belum dipakai otomatis');
  });

  it('leaves roles not used yet out of the totals', async () => {
    renderTab();
    await screen.findByTestId('role-usage-AR');
    const totalCard = screen.getByText('Total Role').closest('div')!;
    expect(within(totalCard).getByText('1')).toBeInTheDocument();
  });
});
