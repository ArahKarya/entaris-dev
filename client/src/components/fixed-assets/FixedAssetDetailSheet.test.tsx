import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get } }));

import { FixedAssetDetailSheet } from './FixedAssetDetailSheet';
import type { DepreciationPostTarget, FixedAssetRow } from './types';

const entry = (id: string, month: string, isPosted: boolean) => ({
  id,
  periodDate: `2097-${month}-01T00:00:00.000Z`,
  amount: '1000000.00',
  isPosted,
  journalEntryId: isPosted ? `je-${id}` : null,
});

function asset(status = 'Active'): FixedAssetRow {
  return {
    id: 'fa-1',
    assetNumber: 'FA-0001',
    name: 'Mesin Uji',
    category: 'Mesin',
    description: null,
    acquisitionDate: '2097-01-01T00:00:00.000Z',
    acquisitionCost: '12000000.00',
    usefulLifeMonths: 12,
    salvageValue: '0',
    depreciationMethod: 'straight_line',
    accumulatedDepreciation: '2000000.00',
    bookValue: '10000000.00',
    status,
    assetAccount: { accountNumber: '1.6.1', name: 'Mesin' },
    depreciationAccount: { accountNumber: '6.9.1', name: 'Beban Penyusutan' },
    accumulatedDepAccount: { accountNumber: '1.6.9', name: 'Akumulasi Penyusutan' },
    depreciationEntries: [entry('e1', '01', true), entry('e2', '02', true), entry('e3', '03', false)],
  };
}

function renderSheet(props: { status?: string; onCancelEntry?: (t: DepreciationPostTarget) => void; cancellingEntryId?: string | null }) {
  get.mockResolvedValue({ data: asset(props.status) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FixedAssetDetailSheet
        assetId="fa-1"
        onClose={vi.fn()}
        onPostEntry={vi.fn()}
        onCancelEntry={props.onCancelEntry}
        cancellingEntryId={props.cancellingEntryId}
      />
    </QueryClientProvider>,
  );
}

const cancelButtons = () => screen.queryAllByRole('button', { name: /batalkan posting|cancel the depreciation posting/i });
const postButtons = () => screen.queryAllByRole('button', { name: /^(posting penyusutan|post depreciation)/i });

beforeEach(() => get.mockReset());

describe('FixedAssetDetailSheet: batal posting penyusutan', () => {
  it('offers "Batalkan posting" only on the latest posted period and passes its target', async () => {
    const onCancelEntry = vi.fn();
    renderSheet({ onCancelEntry });
    expect(await screen.findByText(/2 dari 3|2 of 3/)).toBeTruthy();
    expect(cancelButtons()).toHaveLength(1);
    expect(postButtons()).toHaveLength(1);

    fireEvent.click(cancelButtons()[0]);
    expect(onCancelEntry).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'fa-1', entryId: 'e2', periodDate: '2097-02-01T00:00:00.000Z', amount: 1_000_000 }),
    );
  });

  it('hides the action without the callback (no doc.cancel) and on a disposed asset', async () => {
    const { unmount } = renderSheet({});
    expect(await screen.findByText(/2 dari 3|2 of 3/)).toBeTruthy();
    expect(cancelButtons()).toHaveLength(0);
    unmount();

    renderSheet({ status: 'Disposed', onCancelEntry: vi.fn() });
    expect(await screen.findByText(/2 dari 3|2 of 3/)).toBeTruthy();
    expect(cancelButtons()).toHaveLength(0);
  });

  it('disables posting while a cancel is running', async () => {
    renderSheet({ onCancelEntry: vi.fn(), cancellingEntryId: 'e2' });
    expect(await screen.findByText(/2 dari 3|2 of 3/)).toBeTruthy();
    expect(postButtons()[0].hasAttribute('disabled')).toBe(true);
  });
});
