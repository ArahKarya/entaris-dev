// Resubmit of an approval request in NeedsRevision (PUT /approvals/requests/:id/resubmit).
// One function per concern so later fixes each change their own function: the PI total,
// the production-run gate and the conditional status update.

import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { prisma } from '../lib/prisma';
import { CreateProductionRunSchema, CreatePurchaseInvoiceSchema } from '../utils/schemas';
import { computePurchaseInvoiceTotals } from './purchaseInvoiceCalc';

type Db = Prisma.TransactionClient | typeof prisma;

export type PurchaseInvoiceResubmitPayload = z.infer<typeof CreatePurchaseInvoiceSchema>;
export type ProductionRunResubmitPayload = z.infer<typeof CreateProductionRunSchema>;

export type ResubmitAmountResult = { ok: true; amount: number } | { ok: false; error: string };

// Approval amount of a resubmitted purchase invoice: the invoice grand total, the same figure
// POST /purchase/invoices queues and the approval posts.
export function purchaseInvoiceResubmitAmount(payload: PurchaseInvoiceResubmitPayload): number {
  return computePurchaseInvoiceTotals(payload).grandTotal.toNumber();
}

// Approval amount of a resubmitted production run: Σ input quantity.
export function productionRunResubmitAmount(payload: ProductionRunResubmitPayload): number {
  const inputs: ReadonlyArray<{ quantity?: unknown }> = payload.inputs ?? [];
  return inputs.reduce((s, it) => s + Number(it.quantity ?? 0), 0);
}

// Validates the raw payload for the request's document type and returns its approval amount.
// null = the type cannot be resubmitted (the route answers 400 'Tipe dokumen tidak didukung.').
export function resubmitAmount(documentType: string, rawPayload: unknown): ResubmitAmountResult | null {
  if (documentType === 'PurchaseInvoice') {
    const parsed = CreatePurchaseInvoiceSchema.safeParse(rawPayload);
    if (!parsed.success) return { ok: false, error: 'Data invoice tidak valid: ' + parsed.error.issues[0]?.message };
    return { ok: true, amount: purchaseInvoiceResubmitAmount(parsed.data) };
  }
  if (documentType === 'ProductionRun') {
    const parsed = CreateProductionRunSchema.safeParse(rawPayload);
    if (!parsed.success) return { ok: false, error: 'Data produksi tidak valid: ' + parsed.error.issues[0]?.message };
    return { ok: true, amount: productionRunResubmitAmount(parsed.data) };
  }
  return null;
}

// Stores the corrected payload (as sent, not the parsed copy) and sends the request back to Pending.
// Unconditional update: the route checked the status beforehand.
export function applyResubmit(db: Db, requestId: string, rawPayload: Prisma.InputJsonValue, amount: number) {
  return db.approvalRequest.update({
    where: { id: requestId },
    data: {
      payload: rawPayload,
      amount,
      status: 'Pending',
      rejectedBy: null,
      decidedAt: null,
    },
  });
}
