import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalDetailDialog } from './ApprovalDetailDialog';
import type { ApprovalRequest } from '../ApprovalPanel';

// The approver only needs approval.decide, and approving runs the payload as is: a production run
// that asks for the negative-stock bypass must say so in the dialog.

const run = (payload: Record<string, unknown>): ApprovalRequest => ({
  id: 'r1',
  documentType: 'ProductionRun',
  documentId: null,
  documentNumber: null,
  status: 'Pending',
  amount: 100,
  payload: { date: '2026-05-04', inputs: [], outputs: [], ...payload },
  notes: null,
  requestedBy: 'u1',
  requester: { fullName: 'Staf Produksi', role: 'StaffProduksi' },
  decidedAt: null,
  createdAt: '2026-05-04T01:00:00.000Z',
});

function renderDialog(request: ApprovalRequest) {
  return render(
    <ApprovalDetailDialog
      request={request}
      onClose={vi.fn()}
      isAdmin
      currentUserId="u2"
      detailCtx={null}
      detailCtxLoading={false}
      partyName={() => '—'}
      warehouseMap={{}}
      machineMap={{}}
      itemName={() => 'Item'}
      itemUnit={() => 'kg'}
      onReject={vi.fn()}
      onRevision={vi.fn()}
      onApprove={vi.fn()}
    />,
  );
}

describe('ApprovalDetailDialog: production run negative-stock bypass', () => {
  it('shows the bypass and its reason', () => {
    renderDialog(run({ allowNegativeStock: true, negativeStockReason: 'Stok fisik sudah dihitung ulang' }));
    expect(screen.getByText(/Bypass stok minus/)).toBeInTheDocument();
    expect(screen.getByText('Stok fisik sudah dihitung ulang')).toBeInTheDocument();
  });

  it('shows nothing when the run does not ask for it', () => {
    renderDialog(run({ allowNegativeStock: false, negativeStockReason: 'tidak dipakai' }));
    expect(screen.queryByText(/Bypass stok minus/)).not.toBeInTheDocument();
    expect(screen.queryByText('tidak dipakai')).not.toBeInTheDocument();
  });
});
