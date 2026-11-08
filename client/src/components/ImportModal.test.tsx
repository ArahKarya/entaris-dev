import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post } }));
vi.mock('../lib/api', () => ({ default: { get: vi.fn(), post } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ImportModal from './ImportModal';

const row = (opening: Record<string, unknown>, accountNumber = '1.1.1') => ({
  accountNumber, name: 'Kas', rootType: 'ASSET', accountType: 'ASSET', parentNumber: '1.1', isGroup: false,
  openingBalance: '700000', opening: { allowed: true, reason: null, cutoverDate: '2026-01-01', runningBalance: false, ...opening },
});

function renderModal(importType: 'coa' | 'parties' = 'coa') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ImportModal isOpen onClose={() => undefined} importType={importType} /></QueryClientProvider>);
}

async function choose() {
  const input = screen.getByLabelText('Pilih file import');
  fireEvent.change(input, { target: { files: [new File(['x'], 'coa.csv')] } });
}

const sentConfirm = () => (post.mock.calls[1][1] as FormData).getAll('confirmReplace');

beforeEach(async () => {
  await i18n.changeLanguage('id');
  post.mockReset();
});

describe('ImportModal COA opening balance preview', () => {
  it('asks to confirm a replacement and sends that account number only when ticked', async () => {
    post.mockResolvedValueOnce({ data: { data: [row({ action: 'replace', recorded: '500000.00', needsConfirm: true })], errors: [], total: 1 } });
    post.mockResolvedValueOnce({ data: { success: 1, failed: 0, errors: [] } });
    renderModal();
    await choose();

    expect(await screen.findByText('Mengganti saldo awal tercatat 500000.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Data/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(sentConfirm()).toEqual(['1.1.1']);
  });

  it('confirms per account: every flagged row is listed (also beyond the table), ticking one sends only that one', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ action: 'unchanged', recorded: '700000.00', needsConfirm: false }, `1.1.${i + 1}`));
    rows[0] = row({ action: 'replace', recorded: '500000.00', needsConfirm: true }, '1.1.1');
    rows[23] = row({ action: 'post', recorded: null, runningBalance: true, needsConfirm: true }, '1.1.24');
    post.mockResolvedValueOnce({ data: { data: rows, errors: [], total: 25 } });
    post.mockResolvedValueOnce({ data: { success: 25, failed: 0, errors: [] } });
    renderModal();
    await choose();

    const replace = await screen.findByRole('checkbox', { name: /1\.1\.1 Kas: ganti saldo awal tercatat 500000\.00/ });
    expect(screen.getByRole('checkbox', { name: /1\.1\.24 Kas: 700000 sama dengan saldo berjalan/ })).not.toBeChecked();
    fireEvent.click(replace);
    fireEvent.click(screen.getByRole('button', { name: /Import 25 Data/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(sentConfirm()).toEqual(['1.1.1']);
  });

  it('shows no confirmation for unchanged rows and does not send confirmReplace', async () => {
    post.mockResolvedValueOnce({ data: { data: [row({ action: 'unchanged', recorded: '700000.00', needsConfirm: false })], errors: [], total: 1 } });
    post.mockResolvedValueOnce({ data: { success: 1, failed: 0, errors: [] } });
    renderModal();
    await choose();

    expect(await screen.findByText('Saldo awal tidak berubah')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Data/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(sentConfirm()).toEqual([]);
  });
});

describe('ImportModal party opening balance preview', () => {
  const partyRow = (rowNum: number, name: string, opening: Record<string, unknown> | null) => ({
    rowNum, name, partyType: 'Customer', openingBalance: '700000', arahSaldo: 'Piutang', depositBalance: '', customerDepositBalance: '',
    opening: opening && { allowed: true, reason: null, cutoverDate: '2026-01-01', runningBalance: false, ...opening },
  });

  it('confirms a replacement by sheet row and sends the row number only for the ticked row', async () => {
    post.mockResolvedValueOnce({ data: { data: [
      partyRow(2, 'Budi', { action: 'replace', recorded: '500000.00', needsConfirm: true, kinds: [{ kind: 'AR', action: 'replace', recorded: '500000.00', amount: '700000.00' }] }),
      partyRow(3, 'Sari', { action: 'replace', recorded: '100000.00', needsConfirm: true, kinds: [{ kind: 'AR', action: 'unchanged', recorded: '700000.00', amount: '700000.00' }, { kind: 'CDEP', action: 'replace', recorded: '100000.00', amount: '300000.00' }] }),
    ], errors: [], total: 2 } });
    post.mockResolvedValueOnce({ data: { success: 2, failed: 0, errors: [] } });
    renderModal('parties');
    await choose();

    const second = await screen.findByRole('checkbox', { name: /Baris 3 Sari: ganti saldo awal tercatat \(Uang muka Customer 100000\.00 → 300000\.00\)/ });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(second);
    fireEvent.click(screen.getByRole('button', { name: /Import 2 Data/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(sentConfirm()).toEqual(['3']);
  });

  it('a party with transactions shows its balance stays, with no confirmation', async () => {
    post.mockResolvedValueOnce({ data: { data: [partyRow(2, 'Budi', { action: 'kept', recorded: '500000.00', needsConfirm: false })], errors: [], total: 1 } });
    renderModal('parties');
    await choose();

    expect(await screen.findByText('Sudah bertransaksi: saldo awal tidak diubah')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
