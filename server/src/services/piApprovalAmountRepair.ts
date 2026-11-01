// Core of scripts/repair/e5-pi-approval-amount.ts: purchase invoice approval requests still in the
// queue (Pending / NeedsRevision) whose stored amount is not the invoice grand total. Before E5-R1
// the queue amount subtracted the header potongan a second time, and a resubmit stored biayaLain
// alone. Only `amount` is ever written (a display value: approve recomputes the invoice from the
// payload), never the payload, the status or a journal.

import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import type { prisma } from '../lib/prisma';
import { CreatePurchaseInvoiceBaseSchema } from '../utils/schemas';
import { computePurchaseInvoiceTotals, headerPotonganMismatch } from './purchaseInvoiceCalc';

type Db = Prisma.TransactionClient | typeof prisma;

export const PI_APPROVAL_OPEN_STATUSES = ['Pending', 'NeedsRevision'] as const;

/**
 * fix              amount differs from the grand total; --apply corrects it
 * potonganMismatch header potongan differs from Σ potonganItem: approve will refuse the payload,
 *                  so the approver asks for a revision; reported only
 * invalidPayload   the payload no longer parses; reported only
 */
export type PiApprovalAmountAction = 'fix' | 'potonganMismatch' | 'invalidPayload';

export interface PiApprovalAmountRow {
  requestId: string;
  status: string;
  createdAt: Date;
  requester: string;
  storedAmount: number | null;
  /** null when the payload does not parse. */
  computedAmount: number | null;
  headerPotongan: number | null;
  potonganItemTotal: number | null;
  action: PiApprovalAmountAction;
  /** First validation issue, for invalidPayload rows. */
  error: string | null;
}

const sameAmount = (stored: Prisma.Decimal | null, computed: Decimal) =>
  stored !== null && new Decimal(stored.toString()).eq(computed);

/** Read-only: one row per open purchase invoice request that needs a fix or a manual look. */
export async function planPiApprovalAmountFixes(db: Db): Promise<PiApprovalAmountRow[]> {
  const requests = await db.approvalRequest.findMany({
    where: { documentType: 'PurchaseInvoice', status: { in: [...PI_APPROVAL_OPEN_STATUSES] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, createdAt: true, amount: true, payload: true, requester: { select: { fullName: true } } },
  });

  const rows: PiApprovalAmountRow[] = [];
  for (const r of requests) {
    const base = {
      requestId: r.id,
      status: r.status,
      createdAt: r.createdAt,
      requester: r.requester.fullName,
      storedAmount: r.amount === null ? null : Number(r.amount),
    };
    const parsed = CreatePurchaseInvoiceBaseSchema.safeParse(r.payload);
    if (!parsed.success) {
      rows.push({
        ...base, computedAmount: null, headerPotongan: null, potonganItemTotal: null,
        action: 'invalidPayload', error: parsed.error.issues[0]?.message ?? 'invalid',
      });
      continue;
    }
    const totals = computePurchaseInvoiceTotals(parsed.data);
    const figures = {
      computedAmount: totals.grandTotal.toNumber(),
      headerPotongan: parsed.data.potongan ?? 0,
      potonganItemTotal: totals.potonganItemTotal.toNumber(),
      error: null,
    };
    if (headerPotonganMismatch(parsed.data)) rows.push({ ...base, ...figures, action: 'potonganMismatch' });
    else if (!sameAmount(r.amount, totals.grandTotal)) rows.push({ ...base, ...figures, action: 'fix' });
  }
  return rows;
}

export interface PiApprovalAmountApplyResult {
  approvedBy: string;
  /** Requests whose amount was corrected. */
  applied: string[];
  /** Planned fixes skipped because the request changed since the plan (decided, resubmitted). */
  skipped: string[];
}

/**
 * Writes the `fix` rows of `plan`: only `amount`, and only while the request still has the status
 * and amount the plan saw. `approvedBy` (the accountant who approved the run) is required.
 */
export async function applyPiApprovalAmountFixes(
  db: Db,
  plan: readonly PiApprovalAmountRow[],
  approvedBy: string,
): Promise<PiApprovalAmountApplyResult> {
  const name = approvedBy.trim();
  if (!name) throw new Error('--apply needs --approved-by "<accountant name>"');
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const row of plan) {
    if (row.action !== 'fix' || row.computedAmount === null) continue;
    const { count } = await db.approvalRequest.updateMany({
      where: { id: row.requestId, status: row.status, amount: row.storedAmount },
      data: { amount: row.computedAmount },
    });
    (count === 1 ? applied : skipped).push(row.requestId);
  }
  return { approvedBy: name, applied, skipped };
}
