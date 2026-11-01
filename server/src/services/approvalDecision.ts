// Approval decisions shared by routes/approvals.ts and the Telegram buttons, so both paths
// stay consistent and idempotent.

import type { ApprovalRequest, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { BusinessError } from '../utils/errors';
import { submitPurchaseInvoiceInTx } from './purchaseInvoiceSubmit';
import { submitProductionRunInTx } from './productionRunSubmit';
import { submitSalesReturnInTx } from './salesReturnSubmit';
import { submitDeliveryOrderInTx } from './deliveryOrderSubmit';
import { applyPurchaseOrderApprovalDecisionInTx } from './purchaseOrderSubmit';
import { CreatePurchaseInvoiceSchema, CreateProductionRunSchema, CreateSalesReturnSchema, CreateDeliveryOrderSchema, UpdateProductionRunSchema, RevisePurchaseInvoiceSchema } from '../utils/schemas';
import { notifyUsers } from './notificationService';
import { editProductionRunInTx } from './productionRunEdit';
import { revisePurchaseInvoiceInTx } from './purchaseInvoiceRevise';
import { NOT_POSTABLE, NOT_POSTABLE_CODE, markDraftPostedByApproval, returnDraftToEditable } from './productionRunDraft';
import { isEditDocumentType, splitStoredPayload } from './approvalEditRequests';
import { isAiToolDocumentType } from '../mcp/constants';
import { STALE_STATUS } from '../utils/cancelClaim';
import {
  APPROVAL_ALREADY_DECIDED, APPROVAL_BUSY, APPROVAL_BUSY_MESSAGE, claimApprovalDecision, isTransactionBusyError,
} from './approvalClaim';

export type ApprovalAction = 'approve' | 'reject' | 'revise';

export interface DecideApprovalInput {
  requestId: string;
  action: ApprovalAction;
  actorUserId: string;
  note?: string;
}

export interface DecideApprovalResult {
  ok: boolean;
  status?: 'Approved' | 'Rejected' | 'NeedsRevision';
  docNumber?: string;
  documentType?: string;
  error?: string;
  /** BusinessError code of a failed execution (e.g. PERIOD_CLOSED); the request stays Pending. */
  code?: string;
}

type Tx = Prisma.TransactionClient;
type CreatedDoc = { id: string; number: string };

// One transaction per decision: claim, document effects and the final request row commit together.
const DECISION_TX_TIMEOUT_MS = 30_000;

/**
 * Never throws. Idempotent: only Pending requests are processed, and the Pending → decided move is
 * an atomic claim inside the decision's transaction, so two decisions on one request (double click,
 * web + Telegram) never both take effect: the loser gets STALE_STATUS and nothing moves. Approve runs
 * the stored submit payload (effects happen only now); revise requires `note`. The requester is
 * notified after commit; a failure there no longer turns a committed decision into ok:false.
 */
export async function decideApproval(input: DecideApprovalInput): Promise<DecideApprovalResult> {
  const { requestId, action, actorUserId } = input;
  const note = (input.note ?? '').trim();
  try {
    const request = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) return { ok: false, error: 'Pengajuan tidak ditemukan.' };
    if (request.status !== 'Pending') return { ok: false, error: APPROVAL_ALREADY_DECIDED, code: STALE_STATUS };
    if (action === 'revise' && !note) return { ok: false, error: 'Alasan revisi wajib diisi.' };

    if (action === 'approve' && isAiToolDocumentType(request.documentType)) {
      // Permintaan agen (MCP): jalankan panggilan tersimpan sebagai aktor asli lewat handler internal.
      const { approveQueuedToolCall } = await import('../mcp/approve');
      return approveQueuedToolCall(request, actorUserId, note);
    }

    if (action === 'approve') {
      const createdDoc = await approveInTx(request, actorUserId, note);
      await afterDecision(() => afterApprove(request, createdDoc, actorUserId));
      return { ok: true, status: 'Approved', docNumber: createdDoc?.number, documentType: request.documentType };
    }

    const decided = await rejectInTx(request, action, actorUserId, note);
    await afterDecision(() => afterReject(request, action, decided, actorUserId, note));
    return { ok: true, status: decided.status, documentType: request.documentType };
  } catch (error: any) {
    logger.error({ err: error, requestId, action }, 'decideApproval error');
    if (isTransactionBusyError(error)) return { ok: false, error: APPROVAL_BUSY_MESSAGE, code: APPROVAL_BUSY };
    const code = error instanceof BusinessError ? error.code : undefined;
    return { ok: false, error: error?.message || 'Gagal memproses keputusan approval.', ...(code ? { code } : {}) };
  }
}

// Approve: claim → execute the document → store its id/number, all in one transaction.
// A failed execution rolls the claim back too, so the request stays Pending and can be approved again.
async function approveInTx(request: ApprovalRequest, actorUserId: string, note: string): Promise<CreatedDoc | null> {
  return prisma.$transaction(async (tx) => {
    await claimApprovalDecision(tx, request.id, {
      status: 'Approved',
      approvedBy: actorUserId,
      ...(note ? { notes: note } : {}),
      decidedAt: new Date(),
    });
    const createdDoc = await executeApprovedDocument(tx, request, actorUserId, note);
    if (createdDoc) {
      await tx.approvalRequest.update({
        where: { id: request.id },
        data: { documentId: createdDoc.id, documentNumber: createdDoc.number },
      });
    }
    return createdDoc;
  }, { timeout: DECISION_TX_TIMEOUT_MS });
}

// Document effects of an approval. null = status-only request (no payload, no PO).
async function executeApprovedDocument(
  tx: Tx, request: ApprovalRequest, actorUserId: string, note: string,
): Promise<CreatedDoc | null> {
  // PO: status-based pending (documentId set, no payload) → Draft → Submitted.
  if (request.documentType === 'PurchaseOrder' && request.documentId) {
    const po = await applyPurchaseOrderApprovalDecisionInTx(tx, request.documentId, 'approve', note);
    return { id: po.id, number: po.poNumber };
  }
  if (request.payload == null) return null;

  const creator = request.requestedBy;
  if (request.documentType === 'PurchaseInvoice') {
    const parsed = CreatePurchaseInvoiceSchema.safeParse(request.payload);
    if (!parsed.success) throw new Error('Payload invoice tidak valid: ' + parsed.error.issues[0]?.message);
    const inv = await submitPurchaseInvoiceInTx(tx, parsed.data as any, creator);
    return { id: inv.id, number: inv.invoiceNumber };
  }
  if (request.documentType === 'ProductionRun') {
    const parsed = CreateProductionRunSchema.safeParse(request.payload);
    if (!parsed.success) throw new Error('Payload produksi tidak valid: ' + parsed.error.issues[0]?.message);
    const run = await submitProductionRunInTx(tx, parsed.data as any, creator);
    if (!run) throw new Error('Gagal membuat data produksi.');
    // Draft tertaut (bila ada) → Posted; antrian lama tanpa draft = no-op.
    await markDraftPostedByApproval(tx, request.id, { id: run.id, number: run.runNumber }, actorUserId);
    return { id: run.id, number: run.runNumber };
  }
  if (request.documentType === 'SalesReturn') {
    const parsed = CreateSalesReturnSchema.safeParse(request.payload);
    if (!parsed.success) throw new Error('Payload retur tidak valid: ' + parsed.error.issues[0]?.message);
    const ret = await submitSalesReturnInTx(tx, parsed.data as any, creator);
    if (!ret) throw new Error('Gagal membuat retur penjualan.');
    return { id: ret.id, number: ret.returnNumber };
  }
  if (request.documentType === 'DeliveryOrder') {
    const parsed = CreateDeliveryOrderSchema.safeParse(request.payload);
    if (!parsed.success) throw new Error('Payload surat jalan tidak valid: ' + parsed.error.issues[0]?.message);
    // Disetujui = eksekusi dgn bypass stok minus (itu alasan masuk antrian).
    const doDoc = await submitDeliveryOrderInTx(tx, { ...parsed.data, allowNegativeStock: true } as any, creator);
    if (!doDoc) throw new Error('Gagal membuat surat jalan.');
    return { id: doDoc.id, number: doDoc.doNumber };
  }
  if (request.documentType === 'ProductionRunEdit' || request.documentType === 'PurchaseInvoiceRevisePrice') {
    // Mutasi dokumen existing: payload = body asli + snapshot `_before` (dibuang).
    const targetId = request.documentId;
    if (!targetId) throw new Error('Pengajuan tidak memiliki dokumen target.');
    const { body } = splitStoredPayload(request.payload);
    if (request.documentType === 'ProductionRunEdit') {
      const parsed = UpdateProductionRunSchema.safeParse(body);
      if (!parsed.success) throw new Error('Payload edit produksi tidak valid: ' + parsed.error.issues[0]?.message);
      const run = await editProductionRunInTx(tx, targetId, parsed.data, creator);
      if (!run) throw new Error('Gagal mengedit data produksi.');
      return { id: run.id, number: run.runNumber };
    }
    const parsed = RevisePurchaseInvoiceSchema.safeParse(body);
    if (!parsed.success) throw new Error('Payload revisi harga tidak valid: ' + parsed.error.issues[0]?.message);
    const inv = await revisePurchaseInvoiceInTx(tx, { invoiceId: targetId, lines: parsed.data.lines, reason: parsed.data.reason }, creator);
    if (!inv) throw new Error('Gagal merevisi harga invoice.');
    return { id: inv.id, number: inv.invoiceNumber };
  }
  throw new Error('Tipe dokumen tidak didukung untuk eksekusi: ' + request.documentType);
}

type RejectOutcome = { status: 'Rejected' | 'NeedsRevision'; draftReturned: boolean };

// Reject / minta-revisi in one transaction: claim, then a PO goes back to Draft and a linked
// production draft back to Draft (with the note) so it can be fixed and posted again.
// Revise on a draft-linked request is final (Rejected): the draft is the edit surface.
async function rejectInTx(
  request: ApprovalRequest, action: 'reject' | 'revise', actorUserId: string, note: string,
): Promise<RejectOutcome> {
  return prisma.$transaction(async (tx) => {
    // Read before the claim: the only other writer of a linked draft is a decision on this same
    // request, and that one loses the claim.
    const hasDraft = request.documentType === 'ProductionRun'
      && (await tx.productionRunDraft.count({ where: { approvalRequestId: request.id, status: 'PendingApproval' } })) > 0;
    const status = action === 'reject' || hasDraft ? 'Rejected' : 'NeedsRevision';
    await claimApprovalDecision(tx, request.id, {
      status,
      rejectedBy: actorUserId, // NeedsRevision: reuse kolom utk catat siapa minta revisi
      ...(note ? { notes: note } : {}),
      decidedAt: new Date(),
    });
    if (request.documentType === 'PurchaseOrder' && request.documentId) {
      await applyPurchaseOrderApprovalDecisionInTx(tx, request.documentId, action, note);
    }
    if (hasDraft) {
      const returned = await returnDraftToEditable(tx, request.id, note, action === 'reject' ? 'Ditolak' : 'Perlu revisi');
      if (!returned) throw new BusinessError(NOT_POSTABLE, NOT_POSTABLE_CODE);
    }
    return { status, draftReturned: hasDraft };
  }, { timeout: DECISION_TX_TIMEOUT_MS });
}

// Post-commit work only logs on failure: the decision is already committed and must answer ok:true,
// otherwise the user retries and gets 'Pengajuan sudah diproses.'.
async function afterDecision(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    logger.error(e, 'decideApproval: post-commit work failed (decision already committed)');
  }
}

async function afterApprove(request: ApprovalRequest, createdDoc: CreatedDoc | null, actorUserId: string): Promise<void> {
  // Lampiran yang diunggah saat pengajuan → pindah ke dokumen yang baru dibuat.
  if (createdDoc && request.documentType === 'PurchaseInvoice') {
    try {
      const moved = await prisma.transactionAttachment.updateMany({
        where: { referenceType: 'approval_request', referenceId: request.id },
        data: { referenceType: 'purchase_invoice', referenceId: createdDoc.id },
      });
      if (moved.count > 0) logger.info({ requestId: request.id, docId: createdDoc.id, n: moved.count }, 'Approval attachments moved to document');
    } catch (e) {
      logger.error(e, 'Gagal memindahkan lampiran pengajuan ke dokumen');
    }
  }

  await notifyUsers(prisma, {
    userIds: [request.requestedBy],
    type: 'approval_approved',
    title: 'Pengajuan Anda disetujui',
    message: createdDoc && isEditDocumentType(request.documentType)
      ? `Pengajuan disetujui. Perubahan pada ${createdDoc.number} telah diterapkan.`
      : createdDoc
      ? `Pengajuan disetujui. Dokumen ${createdDoc.number} telah dibuat.`
      : 'Pengajuan Anda telah disetujui.',
    metadata: { kind: 'approval', requestId: request.id, documentType: request.documentType, documentId: createdDoc?.id },
  });
  logger.info({ requestId: request.id, documentType: request.documentType, createdDoc, approvedBy: actorUserId }, 'Approval approved + document executed');
}

async function afterReject(
  request: ApprovalRequest, action: 'reject' | 'revise', decided: RejectOutcome, actorUserId: string, note: string,
): Promise<void> {
  if (decided.status === 'Rejected') {
    await notifyUsers(prisma, {
      userIds: [request.requestedBy],
      type: 'approval_rejected',
      title: 'Pengajuan ditolak',
      message: decided.draftReturned
        ? `Pengajuan ${action === 'revise' ? 'perlu revisi' : 'ditolak'}: ${note || '-'}. Draft dikembalikan. Perbaiki lalu posting ulang.`
        : `Pengajuan ditolak: ${note || '-'}`,
      metadata: { kind: 'approval', requestId: request.id, documentType: request.documentType },
    });
    logger.info({ requestId: request.id, by: actorUserId }, 'Approval rejected');
    return;
  }
  await notifyUsers(prisma, {
    userIds: [request.requestedBy],
    type: 'approval_revision',
    title: 'Pengajuan perlu revisi',
    message: `Pengajuan perlu revisi: ${note}`,
    metadata: { kind: 'approval', requestId: request.id, documentType: request.documentType },
  });
  logger.info({ requestId: request.id, by: actorUserId }, 'Approval request-revision');
}
