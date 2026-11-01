// Sales invoice status follows its outstanding amount (E4-R1). After an invoice is created, every
// change to its outstanding (payment, payment cancel, refund, return, return cancel, deposit apply,
// apply cancel, offset) goes through setSalesInvoiceOutstandingInTx, which derives the status in
// one place. Before this each writer computed the status on its own, and a full return left the
// invoice Submitted with nothing outstanding. salesInvoiceOutstandingWriters.test.ts keeps other
// writers out. Overdue is never written: due dates are read from dueDate.

import Decimal from 'decimal.js';
import type { InvoiceStatus, Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';

type Tx = Prisma.TransactionClient;

/** Error code: the change would take the outstanding below 0 or above the grand total, or the invoice is Draft / Cancelled. */
export const INVOICE_OUTSTANDING_RANGE = 'INVOICE_OUTSTANDING_RANGE';

/** At or below this the invoice counts as paid (rounding left by allocations). */
export const OUTSTANDING_TOLERANCE = new Decimal('0.01');

export type DerivedSalesInvoiceStatus = 'Paid' | 'PartiallyPaid' | 'Submitted';

/**
 * Paid when the outstanding is at most 0.01 (so a Rp 0 invoice is Paid), Submitted when nothing
 * has been settled yet (outstanding at or above the grand total), otherwise PartiallyPaid. Pure,
 * so the purchase side can use the same rule later.
 */
export function deriveSalesInvoiceStatus(outstanding: Decimal.Value, grandTotal: Decimal.Value): DerivedSalesInvoiceStatus {
  const out = new Decimal(outstanding);
  if (out.lte(OUTSTANDING_TOLERANCE)) return 'Paid';
  if (out.gte(new Decimal(grandTotal))) return 'Submitted';
  return 'PartiallyPaid';
}

/**
 * Moves a sales invoice's outstanding by `delta` (negative = settled, positive = reopened) and
 * writes the derived status. The row is locked first and read again, so the new value never
 * comes from a stale read. Rejected with INVOICE_OUTSTANDING_RANGE when the invoice is Draft or
 * Cancelled, or when the result would fall outside [-0.01, grandTotal + 0.01]: that points at
 * broken data (see scripts/repair/e4-sales-invoice-audit.ts), which is reported rather than
 * clamped. A result within the tolerance below 0 is stored as 0.
 */
export async function setSalesInvoiceOutstandingInTx(
  tx: Tx,
  invoiceId: string,
  change: { delta: Decimal.Value },
): Promise<{ outstanding: Decimal; status: DerivedSalesInvoiceStatus }> {
  await tx.$queryRaw`SELECT id FROM sales_invoices WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.salesInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, invoiceNumber: true, status: true, outstanding: true, grandTotal: true },
  });
  if (!inv) throw new BusinessError('Invoice tidak ditemukan.');
  if (inv.status === 'Draft' || inv.status === 'Cancelled') {
    throw new BusinessError(
      `Invoice ${inv.invoiceNumber} berstatus ${inv.status}, sisa tagihannya tidak bisa diubah.`,
      INVOICE_OUTSTANDING_RANGE,
    );
  }
  const grandTotal = new Decimal(inv.grandTotal.toString());
  const next = new Decimal(inv.outstanding.toString()).plus(new Decimal(change.delta));
  if (next.lt(OUTSTANDING_TOLERANCE.neg()) || next.gt(grandTotal.plus(OUTSTANDING_TOLERANCE))) {
    throw new BusinessError(
      `Sisa tagihan Invoice ${inv.invoiceNumber} akan menjadi Rp ${next.toFixed(2)}, di luar rentang Rp 0 sampai Rp ${grandTotal.toFixed(2)}. Periksa data Invoice ini.`,
      INVOICE_OUTSTANDING_RANGE,
    );
  }
  const outstanding = Decimal.max(next, 0);
  const status = deriveSalesInvoiceStatus(outstanding, grandTotal);
  await tx.salesInvoice.update({
    where: { id: inv.id },
    data: { outstanding: outstanding.toNumber(), status },
  });
  return { outstanding, status };
}

/**
 * Repair only (scripts/repair/e4-sales-invoice-audit.ts): writes the status derived from the
 * outstanding the caller saw, and only while the invoice still has that status and outstanding,
 * so an invoice touched since the report is left alone. Never changes the outstanding. Returns
 * whether the row was updated.
 */
export async function resyncSalesInvoiceStatusInTx(
  tx: Tx,
  seen: { id: string; status: InvoiceStatus; outstanding: Decimal.Value; grandTotal: Decimal.Value },
): Promise<boolean> {
  if (seen.status === 'Draft' || seen.status === 'Cancelled') return false;
  const status = deriveSalesInvoiceStatus(seen.outstanding, seen.grandTotal);
  if (status === seen.status) return false;
  const { count } = await tx.salesInvoice.updateMany({
    where: { id: seen.id, status: seen.status, outstanding: new Decimal(seen.outstanding).toNumber() },
    data: { status },
  });
  return count === 1;
}
