import { describe, it, expect, vi, beforeEach } from 'vitest';

const { submitRun, markPosted, returnDraft, notify, db, tx, txLog } = vi.hoisted(() => {
  // Writes inside the decision's transaction go to `tx`; `txLog` records whether each transaction
  // committed or rolled back. Nothing may write through `db` outside a transaction.
  const tx: any = {
    approvalRequest: { updateMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    productionRunDraft: { count: vi.fn() },
  };
  const txLog: Array<'commit' | 'rollback'> = [];
  const db: any = {
    approvalRequest: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    transactionAttachment: { updateMany: vi.fn() },
    $transaction: async (fn: (t: any) => Promise<unknown>) => {
      try {
        const r = await fn(tx);
        txLog.push('commit');
        return r;
      } catch (e) {
        txLog.push('rollback');
        throw e;
      }
    },
  };
  return { submitRun: vi.fn(), markPosted: vi.fn(), returnDraft: vi.fn(), notify: vi.fn(), db, tx, txLog };
});
vi.mock('../notificationService', () => ({ notifyAdmins: vi.fn(), notifyUsers: (...a: unknown[]) => notify(...a) }));
vi.mock('../productionRunSubmit', () => ({ submitProductionRunInTx: (...a: unknown[]) => submitRun(...a) }));
vi.mock('../productionRunDraft', () => ({
  NOT_POSTABLE: 'Draft sudah diproses atau tidak lagi berstatus Draft.',
  NOT_POSTABLE_CODE: 'NOT_POSTABLE',
  markDraftPostedByApproval: (...a: unknown[]) => markPosted(...a),
  returnDraftToEditable: (...a: unknown[]) => returnDraft(...a),
}));
vi.mock('../productionRunEdit', () => ({ editProductionRunInTx: vi.fn() }));
vi.mock('../purchaseInvoiceRevise', () => ({ revisePurchaseInvoiceInTx: vi.fn() }));
vi.mock('../purchaseInvoiceSubmit', () => ({ submitPurchaseInvoiceInTx: vi.fn() }));
vi.mock('../salesReturnSubmit', () => ({ submitSalesReturnInTx: vi.fn() }));
vi.mock('../deliveryOrderSubmit', () => ({ submitDeliveryOrderInTx: vi.fn() }));
vi.mock('../purchaseOrderSubmit', () => ({ applyPurchaseOrderApprovalDecisionInTx: vi.fn() }));
vi.mock('../../lib/prisma', () => ({ prisma: db }));

import { decideApproval } from '../approvalDecision';
import { revisePurchaseInvoiceInTx } from '../purchaseInvoiceRevise';
import { applyPurchaseOrderApprovalDecisionInTx } from '../purchaseOrderSubmit';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../lib/logger';

const PAYLOAD = {
  date: '2026-10-01',
  inputs: [{ itemId: 'gkp', quantity: 1000 }],
  outputs: [{ itemId: 'brs', quantity: 600 }],
};
const REQ = { id: 'req-1', status: 'Pending', documentType: 'ProductionRun', requestedBy: 'u1', payload: PAYLOAD };

beforeEach(() => {
  vi.clearAllMocks();
  txLog.length = 0;
  db.approvalRequest.findUnique.mockResolvedValue(REQ);
  tx.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
  tx.approvalRequest.update.mockResolvedValue({});
  tx.productionRunDraft.count.mockResolvedValue(1);
  submitRun.mockResolvedValue({ id: 'run-1', runNumber: 'PR-1' });
  notify.mockResolvedValue(1);
});

/** The request row may only change inside a transaction. */
const expectNoWriteOutsideTx = () => {
  expect(db.approvalRequest.update).not.toHaveBeenCalled();
  expect(db.approvalRequest.updateMany).not.toHaveBeenCalled();
};

describe('decideApproval x production draft', () => {
  it('approve creates the run and marks the linked draft Posted in the same tx', async () => {
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r).toMatchObject({ ok: true, status: 'Approved', docNumber: 'PR-1' });
    expect(markPosted).toHaveBeenCalledWith(tx, 'req-1', { id: 'run-1', number: 'PR-1' }, 'admin');
  });

  it('claims Pending → Approved first and stores the document in the same committed tx', async () => {
    const order: string[] = [];
    tx.approvalRequest.updateMany.mockImplementation(async () => { order.push('claim'); return { count: 1 }; });
    submitRun.mockImplementation(async () => { order.push('submit'); return { id: 'run-1', runNumber: 'PR-1' }; });
    tx.approvalRequest.update.mockImplementation(async () => { order.push('document'); return {}; });
    await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin', note: ' ok ' });
    expect(order).toEqual(['claim', 'submit', 'document']);
    expect(tx.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'Pending' },
      data: { status: 'Approved', approvedBy: 'admin', notes: 'ok', decidedAt: expect.any(Date) },
    });
    expect(tx.approvalRequest.update).toHaveBeenCalledWith({ where: { id: 'req-1' }, data: { documentId: 'run-1', documentNumber: 'PR-1' } });
    expect(txLog).toEqual(['commit']);
    expectNoWriteOutsideTx();
  });

  it('a lost claim (count 0) answers STALE_STATUS and never runs the executor or notifies', async () => {
    tx.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r).toEqual({ ok: false, error: 'Pengajuan sudah diproses.', code: 'STALE_STATUS' });
    expect(submitRun).not.toHaveBeenCalled();
    expect(markPosted).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(txLog).toEqual(['rollback']);
  });

  it('a request that is no longer Pending answers STALE_STATUS without opening a transaction', async () => {
    db.approvalRequest.findUnique.mockResolvedValue({ ...REQ, status: 'Approved' });
    const r = await decideApproval({ requestId: 'req-1', action: 'reject', actorUserId: 'admin', note: 'x' });
    expect(r).toEqual({ ok: false, error: 'Pengajuan sudah diproses.', code: 'STALE_STATUS' });
    expect(txLog).toEqual([]);
  });

  it('a lost reject claim does not return the draft', async () => {
    tx.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    const r = await decideApproval({ requestId: 'req-1', action: 'reject', actorUserId: 'admin', note: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'STALE_STATUS' });
    expect(returnDraft).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('a failure after commit still answers ok:true (the decision is committed)', async () => {
    notify.mockRejectedValue(new Error('notification table locked'));
    const err = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r).toMatchObject({ ok: true, status: 'Approved', docNumber: 'PR-1' });
    expect(txLog).toEqual(['commit']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a transaction timeout while another decision holds the row answers APPROVAL_BUSY', async () => {
    tx.approvalRequest.updateMany.mockRejectedValue(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }));
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r).toEqual({ ok: false, error: 'Pengajuan sedang diproses, coba lagi.', code: 'APPROVAL_BUSY' });
  });

  it('legacy approval (no draft linked) still approves and creates the run', async () => {
    markPosted.mockResolvedValue(0);
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r.ok).toBe(true);
    expect(submitRun).toHaveBeenCalledTimes(1);
  });

  it('reject returns the draft to Draft with the note', async () => {
    returnDraft.mockResolvedValue(true);
    const r = await decideApproval({ requestId: 'req-1', action: 'reject', actorUserId: 'admin', note: 'Data keliru' });
    expect(r).toMatchObject({ ok: true, status: 'Rejected' });
    expect(returnDraft).toHaveBeenCalledWith(tx, 'req-1', 'Data keliru', 'Ditolak');
    expect(submitRun).not.toHaveBeenCalled();
    expect(tx.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'Pending' },
      data: { status: 'Rejected', rejectedBy: 'admin', notes: 'Data keliru', decidedAt: expect.any(Date) },
    });
    expect(txLog).toEqual(['commit']);
    expectNoWriteOutsideTx();
  });

  it('a linked draft that cannot be returned rolls the reject back', async () => {
    returnDraft.mockResolvedValue(false);
    const r = await decideApproval({ requestId: 'req-1', action: 'reject', actorUserId: 'admin', note: 'Data keliru' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_POSTABLE' });
    expect(txLog).toEqual(['rollback']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('revise without a note is refused before any transaction', async () => {
    const r = await decideApproval({ requestId: 'req-1', action: 'revise', actorUserId: 'admin', note: '  ' });
    expect(r).toEqual({ ok: false, error: 'Alasan revisi wajib diisi.' });
    expect(txLog).toEqual([]);
  });

  it('revise on a draft-linked request is finalised as Rejected (draft is the edit surface)', async () => {
    returnDraft.mockResolvedValue(true);
    const r = await decideApproval({ requestId: 'req-1', action: 'revise', actorUserId: 'admin', note: 'Cek bahan' });
    expect(r).toMatchObject({ ok: true, status: 'Rejected' });
    expect(tx.approvalRequest.updateMany.mock.calls[0][0].data.status).toBe('Rejected');
  });

  it('revise on a legacy request (no draft) keeps NeedsRevision', async () => {
    tx.productionRunDraft.count.mockResolvedValue(0);
    const r = await decideApproval({ requestId: 'req-1', action: 'revise', actorUserId: 'admin', note: 'Cek bahan' });
    expect(r).toMatchObject({ ok: true, status: 'NeedsRevision' });
    expect(tx.approvalRequest.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'NeedsRevision', rejectedBy: 'admin', notes: 'Cek bahan' });
    expect(returnDraft).not.toHaveBeenCalled();
  });

  it('approve failure leaves the request Pending and the draft untouched', async () => {
    submitRun.mockRejectedValue(new Error('Stok tidak cukup'));
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r.ok).toBe(false);
    // The claim ran inside the transaction that rolled back: the request stays Pending.
    expect(txLog).toEqual(['rollback']);
    expect(tx.approvalRequest.update).not.toHaveBeenCalled();
    expectNoWriteOutsideTx();
    expect(markPosted).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('passes the error code of a failed execution through and keeps the request Pending', async () => {
    db.approvalRequest.findUnique.mockResolvedValue({
      id: 'req-2',
      status: 'Pending',
      documentType: 'PurchaseInvoiceRevisePrice',
      documentId: 'pi-1',
      requestedBy: 'u1',
      payload: { lines: [{ itemId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', newRate: 5000 }], reason: 'Harga final supplier' },
    });
    vi.mocked(revisePurchaseInvoiceInTx).mockRejectedValue(
      new BusinessError('Tahun buku 2026 sudah ditutup; jurnal di periode ini tidak bisa diposting.', 'PERIOD_CLOSED'),
    );
    const r = await decideApproval({ requestId: 'req-2', action: 'approve', actorUserId: 'admin' });
    expect(r).toMatchObject({ ok: false, code: 'PERIOD_CLOSED', error: expect.stringMatching(/sudah ditutup/) });
    expect(txLog).toEqual(['rollback']);
    expect(tx.approvalRequest.update).not.toHaveBeenCalled();
    expectNoWriteOutsideTx();
  });

  it('omits the code for a plain error', async () => {
    submitRun.mockRejectedValue(new Error('Stok tidak cukup'));
    const r = await decideApproval({ requestId: 'req-1', action: 'approve', actorUserId: 'admin' });
    expect(r).not.toHaveProperty('code');
  });
});

describe('decideApproval x purchase order', () => {
  const PO_REQ = { id: 'req-po', status: 'Pending', documentType: 'PurchaseOrder', documentId: 'po-1', requestedBy: 'u1', payload: null };

  it('reject claims and sends the PO back to Draft in the same transaction', async () => {
    db.approvalRequest.findUnique.mockResolvedValue(PO_REQ);
    const r = await decideApproval({ requestId: 'req-po', action: 'reject', actorUserId: 'admin', note: 'Harga salah' });
    expect(r).toMatchObject({ ok: true, status: 'Rejected' });
    expect(applyPurchaseOrderApprovalDecisionInTx).toHaveBeenCalledWith(tx, 'po-1', 'reject', 'Harga salah');
    expect(tx.productionRunDraft.count).not.toHaveBeenCalled();
    expect(txLog).toEqual(['commit']);
  });

  it('approve submits the PO inside the claimed transaction', async () => {
    db.approvalRequest.findUnique.mockResolvedValue(PO_REQ);
    vi.mocked(applyPurchaseOrderApprovalDecisionInTx).mockResolvedValue({ id: 'po-1', poNumber: 'PO-1' } as never);
    const r = await decideApproval({ requestId: 'req-po', action: 'approve', actorUserId: 'admin' });
    expect(r).toMatchObject({ ok: true, status: 'Approved', docNumber: 'PO-1' });
    expect(applyPurchaseOrderApprovalDecisionInTx).toHaveBeenCalledWith(tx, 'po-1', 'approve', '');
    expect(tx.approvalRequest.updateMany).toHaveBeenCalledTimes(1);
  });
});
