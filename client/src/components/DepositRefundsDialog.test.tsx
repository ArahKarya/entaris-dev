import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, perms } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  perms: { editModules: [] as string[], caps: [] as string[] },
}));
vi.mock('@/lib/api', () => ({ default: { get, post } }));
vi.mock('@/lib/permissions', () => ({
  can: (module: string, action = 'view') => action === 'view' || perms.editModules.includes(module),
  cap: (name: string) => perms.caps.includes(name),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DepositRefundsDialog, type DepositSide } from './DepositRefundsDialog';

const refunds = [
  {
    journalEntryId: 'je-active', entryNumber: 'JV-209504-0002', date: '2095-04-05T00:00:00.000Z', amount: 4_000_000,
    status: 'Submitted', cashAccount: { id: 'c1', accountNumber: '1.1.2', name: 'Bank BRI' }, cancelReason: null,
  },
  {
    journalEntryId: 'je-cancelled', entryNumber: 'JV-209504-0001', date: '2095-04-02T00:00:00.000Z', amount: 1_000_000,
    status: 'Cancelled', cashAccount: { id: 'c1', accountNumber: '1.1.2', name: 'Bank BRI' }, cancelReason: 'Salah akun',
  },
];

function signIn(user: { module: string; edit: boolean; caps: string[] }) {
  perms.editModules = user.edit ? [user.module] : [];
  perms.caps = user.caps;
}

function renderDialog(side: DepositSide = 'customer') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DepositRefundsDialog side={side} deposit={{ id: 'dep-1', paymentNumber: 'PAY-0001', partyName: 'PT Uji' }} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

const cancelButtons = () => screen.queryAllByRole('button', { name: /batalkan refund|cancel refund/i });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: { data: refunds } });
  post.mockResolvedValue({ data: {} });
});

describe('DepositRefundsDialog: batal refund', () => {
  it('shows "Batalkan refund" only on the active refund for a user with edit and doc.cancel', async () => {
    signIn({ module: 'customer_deposit', edit: true, caps: ['doc.cancel'] });
    renderDialog();
    expect(await screen.findByText('JV-209504-0002')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/customer-deposits/dep-1/refunds');
    expect(screen.getByText('JV-209504-0001')).toBeTruthy();
    expect(cancelButtons()).toHaveLength(1);
    expect(cancelButtons()[0].getAttribute('aria-label')).toMatch(/JV-209504-0002/);
  });

  it('hides the action without doc.cancel', async () => {
    signIn({ module: 'customer_deposit', edit: true, caps: [] });
    renderDialog();
    expect(await screen.findByText('JV-209504-0002')).toBeTruthy();
    expect(cancelButtons()).toHaveLength(0);
  });

  it('hides the action without edit on the deposit module', async () => {
    signIn({ module: 'vendor_deposit', edit: false, caps: ['doc.cancel'] });
    renderDialog('vendor');
    expect(await screen.findByText('JV-209504-0002')).toBeTruthy();
    expect(cancelButtons()).toHaveLength(0);
  });

  it('confirms, posts the optional reason and refreshes the list', async () => {
    signIn({ module: 'vendor_deposit', edit: true, caps: ['doc.cancel'] });
    renderDialog('vendor');
    fireEvent.click((await screen.findAllByRole('button', { name: /JV-209504-0002/ }))[0]);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: '  Salah input  ' } });
    const confirm = [...dialog.querySelectorAll('button')].find((b) => /batalkan refund|cancel refund/i.test(b.textContent ?? ''))!;
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/vendor-deposits/dep-1/refunds/je-active/cancel', { reason: 'Salah input' }),
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
