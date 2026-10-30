import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InvoicePaymentTimeline, type PaymentTimelineEntry } from './InvoicePaymentTimeline';

const entries: PaymentTimelineEntry[] = [
  { kind: 'deposit', id: 'app-1', label: 'PAY-202610-0001', date: '2026-10-01', amount: 4_000_000 },
];

describe('InvoicePaymentTimeline: batal alokasi uang muka', () => {
  it('menampilkan tombol batal bila pengguna boleh membatalkan', () => {
    const onCancel = vi.fn();
    render(<InvoicePaymentTimeline entries={entries} isSales invoiceCancelled={false} onCancelDepositApp={onCancel} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onCancel).toHaveBeenCalledWith('app-1');
  });

  it('menyembunyikan tombol batal tanpa capability doc.cancel', () => {
    render(<InvoicePaymentTimeline entries={entries} isSales invoiceCancelled={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
