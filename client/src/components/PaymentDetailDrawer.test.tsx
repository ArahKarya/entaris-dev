import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get, post: vi.fn(), delete: vi.fn() } }));

import PaymentDetailDrawer from './PaymentDetailDrawer';

const payment = {
  id: 'pay-1',
  paymentNumber: 'PAY-209701-0001',
  paymentType: 'Receive',
  date: '2097-02-01T05:00:00.000Z',
  amount: '15000000.00',
  status: 'Submitted',
  party: { id: 'c-1', name: 'PT Uji' },
  account: { id: 'a-1', accountNumber: '1.1.1', name: 'Kas' },
  splits: [],
  allocations: [
    { id: 'al-1', invoiceType: 'SalesInvoice', invoiceId: 'si-1', invoiceNumber: 'SI-209701-0001', allocatedAmount: '5000000.00' },
    { id: 'al-2', invoiceType: 'OpeningReceivable', invoiceId: 'c-1', invoiceNumber: null, allocatedAmount: '10000000.00' },
  ],
  journalEntry: null,
};

describe('PaymentDetailDrawer allocations', () => {
  it('labels what the payment took from the opening and shows no invoice number for it', async () => {
    get.mockImplementation(async (url: string) => ({ data: url.startsWith('/attachments') ? [] : payment }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/^(Saldo awal piutang|Opening receivable)$/)).toBeTruthy();
    expect(screen.getByText('SI-209701-0001')).toBeTruthy();
    expect(screen.queryByText('c-1...')).toBeNull();
  });
});
