// Owner decision #6 (E2-R4): the expense form never sends the party on the expense line; a party is
// only allowed on receivable/payable lines. Its name goes into the narration and line description.
// On a debit account with a party role (partyRole from /coa/flat) the party stays on the line.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api', () => ({ default: { get, post } }));

// Native selects instead of the Radix/cmdk picker, labelled by their placeholder.
vi.mock('./purchase-cash/OptionPicker', () => ({
  OptionPicker: ({ value, onChange, options, placeholder, emptyLabel }: any) => (
    <select aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel ?? ''}</option>
      {options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

const supplier = { id: 's1', name: 'PT Sumber Makmur', partyType: 'Supplier' };
vi.mock('@/hooks/usePartyPicker', () => ({
  usePartyPicker: ({ selectedId }: { selectedId?: string | null }) => ({
    pickerProps: { options: [{ value: supplier.id, label: supplier.name }], onSearchChange: () => {}, loading: false },
    options: [],
    parties: [supplier],
    selectedParty: selectedId === supplier.id ? supplier : null,
    total: 1,
    isLoading: false,
  }),
}));

import ExpenseModal from './ExpenseModal';

// Typed keys are not needed here; the test only reads back what the component renders.
const tf = i18n.getFixedT(null, 'finance') as unknown as (key: string, opts?: Record<string, unknown>) => string;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: { data: [
    { id: 'exp', accountNumber: '6.16', name: 'Beban Perbaikan', accountType: 'EXPENSE', isGroup: false },
    { id: 'cash', accountNumber: '1.1.1', name: 'Kas Kecil', accountType: 'ASSET', isGroup: false },
    { id: 'ap', accountNumber: '2.1.1', name: 'Hutang Usaha', accountType: 'LIABILITY', isGroup: false, partyRole: 'AP' },
  ] } });
  post.mockResolvedValue({ data: { id: 'je-1' } });
});

describe('ExpenseModal', () => {
  it('sends no partyId and puts the party name in the narration and descriptions', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ExpenseModal isOpen onClose={vi.fn()} /></QueryClientProvider>);

    const debit = await screen.findByLabelText(tf('expenseModal.debitPlaceholder'));
    await waitFor(() => expect(debit.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(debit, { target: { value: 'exp' } });
    fireEvent.change(screen.getByLabelText(tf('expenseModal.creditPlaceholder')), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText(tf('expenseModal.noParty')), { target: { value: 's1' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '250000' } });
    fireEvent.click(screen.getByRole('button', { name: tf('expenseModal.submit') }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/journals');
    expect(body.items).toHaveLength(2);
    for (const item of body.items) expect(item).not.toHaveProperty('partyId');
    const partyText = tf('expenseModal.partyValue', { name: supplier.name });
    expect(body.narration).toContain(partyText);
    expect(body.items[0].description).toContain(partyText);
    expect(body.items[0]).toMatchObject({ accountId: 'exp', debit: 250000, credit: 0 });
    expect(body.items[1]).toMatchObject({ accountId: 'cash', debit: 0, credit: 250000 });
  });

  it('without a party the text carries no party part', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ExpenseModal isOpen onClose={vi.fn()} /></QueryClientProvider>);

    const debit = await screen.findByLabelText(tf('expenseModal.debitPlaceholder'));
    await waitFor(() => expect(debit.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(debit, { target: { value: 'exp' } });
    fireEvent.change(screen.getByLabelText(tf('expenseModal.creditPlaceholder')), { target: { value: 'cash' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: tf('expenseModal.submit') }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][1];
    for (const item of body.items) expect(item).not.toHaveProperty('partyId');
    expect(body.narration).not.toContain(supplier.name);
  });

  it('keeps partyId on a payable debit line (party role) and leaves the party out of the text', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ExpenseModal isOpen onClose={vi.fn()} /></QueryClientProvider>);

    const debit = await screen.findByLabelText(tf('expenseModal.debitPlaceholder'));
    await waitFor(() => expect(debit.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(debit, { target: { value: 'ap' } });
    fireEvent.change(screen.getByLabelText(tf('expenseModal.creditPlaceholder')), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText(tf('expenseModal.noParty')), { target: { value: 's1' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '5000000' } });
    fireEvent.click(screen.getByRole('button', { name: tf('expenseModal.submit') }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][1];
    expect(body.items[0]).toMatchObject({ accountId: 'ap', partyId: 's1', debit: 5000000, credit: 0 });
    expect(body.items[1]).not.toHaveProperty('partyId');
    expect(body.narration).not.toContain(tf('expenseModal.partyValue', { name: supplier.name }));
  });
});
