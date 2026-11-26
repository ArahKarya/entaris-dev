import { reverseCogsSettlementsByTrigger, closeCogsBackfillForSalesInvoice } from './cogsBackfillReverse';
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { updateAccountBalance, recalcPartyOutstanding } from '../utils/accountBalance';
import { systemAccounts } from './systemAccounts';
import { cancelDocumentJournals, voidJournalInTx } from '../utils/journalCancel';
import { assertPeriodOpen } from '../utils/periodGuard';
import { claimCancel, type CancelTrail } from '../utils/cancelClaim';
import { lockArThenSalesInvoiceInTx } from './salesInvoiceStatus';
import { assertStockAvailable, lockInventoryRows } from './inventory/stockLocks';
import { reverseDocumentMovements } from './inventory/inventoryLedger';
import { purchaseRevisionPrefix } from './ledger/journalSource';
import type { NegativeStockBypass } from '../utils/negativeStockGate';

type Tx = Prisma.TransactionClient;

/**
 * reference_type of the rows a purchase invoice owns: its legacy receipts and the Revaluation rows of
 * its landed-cost delta ('PurchaseInvoice') and of its price revisions ('PurchaseRevision', PR-6.4c3).
 */
const PURCHASE_INVOICE_ROW_TYPES = ['PurchaseInvoice', 'PurchaseRevision'] as const;

/** Error code: a sales invoice with a return that is not cancelled cannot be cancelled. */
export const INVOICE_HAS_ACTIVE_RETURNS = 'INVOICE_HAS_ACTIVE_RETURNS';

/**
 * Cancel a sales invoice: cancel its JE, COGS JE and their -suffixed satellites (balances reversed per JE item account, so
 * per-item COGS sub-accounts are restored), reverse its own stock movements through the value
 * ledger (quantity and value exactly; delivery-order movements stay with the note), recompute party
 * outstanding. Rejected with PERIOD_CLOSED when the invoice's fiscal year, or that of any journal
 * it voids, is closed, and then with INVOICE_HAS_ACTIVE_RETURNS while a return is not cancelled.
 * `trail` (who and why) is stored on the voided journals. Caller owns the transaction.
 */
export async function cancelSalesInvoiceInTx(
  tx: Tx,
  invoiceId: string,
  trail?: CancelTrail,
): Promise<{ id: string; status: 'Cancelled' }> {
  // AR row, then the invoice row: the order a return submit and payment submit take, so a cancel
  // racing either waits for it instead of deadlocking when its journals reverse AR.
  await lockArThenSalesInvoiceInTx(tx, invoiceId);
  const invoice = await tx.salesInvoice.findUnique({
    where: { id: invoiceId },
    include: { customer: true },
  });
  if (!invoice) throw new BusinessError('Invoice tidak ditemukan.');
  if (invoice.status === 'Cancelled') throw new BusinessError('Invoice sudah dibatalkan.');
  // First write; any rejection below rolls it back.
  await claimCancel(tx.salesInvoice, invoice.id, { status: 'Cancelled', outstanding: 0, cancelledAt: new Date() });
  // Counted under the row locks: a return being submitted holds them (submitSalesReturnInTx takes
  // the same ones), so this cancel waits for it and the count sees it.
  const activeReturns = await tx.salesReturn.count({
    where: { salesInvoiceId: invoice.id, status: { not: 'Cancelled' } },
  });
  // Invoice Rp 0 (sumbangan) otomatis Paid tanpa pembayaran → tetap boleh dibatalkan. A fully
  // returned invoice is Paid too; it gets the "cancel the returns first" answer below instead.
  if (invoice.status === 'Paid' && Number(invoice.grandTotal) !== 0 && activeReturns === 0) {
    throw new BusinessError('Invoice sudah lunas, tidak bisa dibatalkan.');
  }
  // A closed year stays as reported; the correction is a manual journal in the open period.
  await assertPeriodOpen(tx, { fiscalYearId: invoice.fiscalYearId, date: invoice.date }, 'invoice');
  // Cancelling under an active return would leave its AR credit, stock-in and customer credit
  // standing for an invoice that no longer exists. Returns are never cancelled automatically.
  if (activeReturns > 0) {
    throw new BusinessError(
      `Invoice memiliki retur aktif (${activeReturns}). Batalkan retur terlebih dahulu.`,
      INVOICE_HAS_ACTIVE_RETURNS,
    );
  }

  const allocations = await tx.paymentAllocation.findMany({
    where: { invoiceType: 'SalesInvoice', invoiceId: invoice.id },
  });
  if (allocations.length > 0) {
    throw new BusinessError('Invoice memiliki pembayaran teralokasi. Batalkan pembayaran terlebih dahulu.');
  }

  const activeDepositApps = await tx.customerDepositApplication.count({
    where: { salesInvoiceId: invoice.id, isCancelled: false },
  });
  if (activeDepositApps > 0) {
    throw new BusinessError('Invoice memiliki alokasi uang muka customer aktif. Batalkan alokasi terlebih dahulu.');
  }

  // The delivery notes this invoice bills are documents too: lock them (id order) before the
  // items, as their own edit and cancel do; they are released below.
  await tx.$queryRaw`SELECT id FROM delivery_orders WHERE invoice_id = ${invoice.id} ORDER BY id FOR UPDATE`;

  // Only direct-sale movements are reversed; from-DO movements belong to the DO and stay valid.
  // Their items are locked before the journals lock accounts other than AR (lock order in
  // services/inventory/stockLocks.ts; the AR row above is the document lock of this cancel). An
  // Out reversal puts stock back and needs no check.
  const stockMovements = await tx.stockMovement.findMany({
    where: { referenceType: 'SalesInvoice', referenceId: invoice.id, isCancelled: false },
  });
  // The items of its COGS backfill queue too (a from-DO invoice owns no rows of them): closing the
  // queue reverses their settlement rows after the journals below have locked accounts.
  const queueItems = await tx.cogsBackfillQueue.findMany({
    where: { salesInvoiceId: invoice.id, status: { not: 'Cancelled' } },
    select: { inventoryItemId: true },
  });
  await lockInventoryRows(tx, {
    itemIds: [...stockMovements.map((sm) => sm.itemId), ...queueItems.map((q) => q.inventoryItemId)],
    pairs: stockMovements.flatMap((sm) => (sm.warehouseId ? [{ itemId: sm.itemId, warehouseId: sm.warehouseId }] : [])),
  });

  // Revenue/AR journal, COGS journal and every satellite of either (JV-<no>-CORR, -CORR-PPN,
  // -CORR-QTY-n, -WAPU, -RATE-FIX, …). Satellites left active would keep moving AR, revenue, PPh
  // and PPN for an invoice that no longer exists.
  await cancelDocumentJournals(tx, [`JV-${invoice.invoiceNumber}`, `JV-COGS-${invoice.invoiceNumber}`], trail);

  // Deferred COGS of this invoice is void with it: close its backfill queue and reverse its
  // auto-settle JVs, otherwise later stock-ins keep moving inventory value into HPP.
  await closeCogsBackfillForSalesInvoice(tx, invoice.id, trail);

  // The voided COGS journal credited inventory with the value these rows took out of the book.
  await reverseDocumentMovements(tx, { referenceType: 'SalesInvoice', referenceId: invoice.id }, { userId: trail?.cancelledById ?? invoice.createdBy });

  // Release linked Delivery Orders back to Submitted state so they can be
  // billed by another invoice. Their stock movements remain valid.
  await tx.deliveryOrder.updateMany({
    where: { invoiceId: invoice.id },
    data: { invoiceId: null, invoicedAt: null },
  });

  // delivery_order_item_id is @unique: null it so a new invoice can bind the same DO.
  // Lines are kept for the audit trail.
  await tx.salesInvoiceItem.updateMany({
    where: { salesInvoiceId: invoice.id, deliveryOrderItemId: { not: null } },
    data: { deliveryOrderItemId: null },
  });

  await recalcPartyOutstanding(tx, invoice.partyId);

  return { id: invoice.id, status: 'Cancelled' };
}

/**
 * Mirror of cancelSalesInvoiceInTx for purchase invoices. The invoice's own rows are reversed through
 * the value ledger: a legacy PI-owned receipt (quantity and value back out; a warehouse that no
 * longer holds the goods is rejected with STOCK_INSUFFICIENT unless opts allows negative stock), and
 * a Revaluation row that carries the invoice's landed-cost delta ('PurchaseInvoice', posted at
 * submit or by the value-ledger backfill) or a price revision ('PurchaseRevision') on an STT
 * receipt, taken back by its value_delta while the voided journal (JV-<no>, or the revision journal
 * keyed sourceKeys.purchaseRevision) reverses the same amount in inventory. Either is refused with
 * REVERSAL_NEEDS_TRUE_UP when goods of the item went out since its value entered the book, or when a
 * receipt leaves stock 0 with value left (value true-up, PR-6.5a).
 */
export async function cancelPurchaseInvoiceInTx(
  tx: Tx,
  invoiceId: string,
  trail?: CancelTrail,
  opts: NegativeStockBypass = {},
): Promise<{ id: string; status: 'Cancelled' }> {
  const invoice = await tx.purchaseInvoice.findUnique({
    where: { id: invoiceId },
    include: { supplier: true },
  });
  if (!invoice) throw new BusinessError('Invoice tidak ditemukan.');
  if (invoice.status === 'Cancelled') throw new BusinessError('Invoice sudah dibatalkan.');
  // First write; any rejection below rolls it back.
  await claimCancel(tx.purchaseInvoice, invoice.id, { status: 'Cancelled', outstanding: 0, cancelledAt: new Date() });
  if (invoice.status === 'Paid') throw new BusinessError('Invoice sudah lunas, tidak bisa dibatalkan.');
  // Also covers the legacy branch below that reverses balances without a journal.
  await assertPeriodOpen(tx, { fiscalYearId: invoice.fiscalYearId, date: invoice.date }, 'invoice');

  const allocations = await tx.paymentAllocation.findMany({
    where: { invoiceType: 'PurchaseInvoice', invoiceId: invoice.id },
  });
  if (allocations.length > 0) {
    throw new BusinessError('Invoice memiliki pembayaran teralokasi. Batalkan pembayaran terlebih dahulu.');
  }

  const activeDepositApps = await tx.vendorDepositApplication.count({
    where: { purchaseInvoiceId: invoice.id, isCancelled: false },
  });
  if (activeDepositApps > 0) {
    throw new BusinessError('Invoice memiliki alokasi uang muka aktif. Batalkan alokasi terlebih dahulu.');
  }

  // Only PI-owned rows (standalone/legacy lines, price-delta Revaluations) are reversed; STT-linked
  // stock belongs to the STT.
  // Lock their items before the journals lock accounts, then check that each warehouse still holds
  // what the invoice brought in. allowNegativeStock (the route checked inventory.negative_stock)
  // logs the shortage instead.
  const stockMovements = await tx.stockMovement.findMany({
    where: { referenceType: { in: [...PURCHASE_INVOICE_ROW_TYPES] }, referenceId: invoice.id, isCancelled: false },
  });
  await lockInventoryRows(tx, {
    itemIds: stockMovements.map((sm) => sm.itemId),
    pairs: stockMovements.flatMap((sm) => (sm.warehouseId ? [{ itemId: sm.itemId, warehouseId: sm.warehouseId }] : [])),
  });
  // A Revaluation row moves no quantity.
  const receipts = stockMovements.filter((sm) => sm.movementType !== 'Revaluation');
  await assertStockAvailable(
    tx,
    receipts.map((sm) => ({ itemId: sm.itemId, warehouseId: sm.warehouseId, quantity: sm.quantity.toString() })),
    {
      context: 'purchaseInvoice.cancel',
      userId: trail?.cancelledById,
      allowNegative: opts.allowNegativeStock,
      reason: opts.negativeStockReason,
      reversal: true,
    },
  );

  // Main AP journal plus satellites (JV-<no>-CORR, -CORR-2, …).
  const jvNumber = `JV-${invoice.invoiceNumber}`;
  const mainExisted = await tx.journalEntry.count({ where: { entryNumber: jvNumber } });
  await cancelDocumentJournals(tx, [jvNumber], trail);
  // Price revisions on the value ledger carry a key (their 'PurchaseRevision' rows are reversed
  // below). An older revision journal has none and stays: its delta sits in the valuation baseline.
  const revisionJournals = await tx.journalEntry.findMany({
    where: { status: { not: 'Cancelled' }, sourceKey: { startsWith: purchaseRevisionPrefix(invoice.id) } },
    include: { items: true },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });
  for (const journal of revisionJournals) await voidJournalInTx(tx, journal, 'jurnal', trail);
  if (mainExisted === 0) {
    // Legacy fallback for invoices created before per-item JE rows existed.
    const apAccount = await systemAccounts.getAccount('AP');
    const inventoryAccount = await systemAccounts.getAccount('INVENTORY');
    await updateAccountBalance(tx, inventoryAccount.id, 0, invoice.grandTotal);
    await updateAccountBalance(tx, apAccount.id, invoice.grandTotal, 0);
  }

  await recalcPartyOutstanding(tx, invoice.partyId);

  // Both types in one pass, newest first: a revision was posted on the book the landed cost left.
  await reverseDocumentMovements(
    tx,
    { referenceType: PURCHASE_INVOICE_ROW_TYPES, referenceId: invoice.id },
    { userId: trail?.cancelledById ?? invoice.createdBy },
  );

  await reverseCogsSettlementsByTrigger(tx, 'PurchaseInvoice', invoice.id, trail);

  // Release linked STTs for invoicing; their items and stock movements stay untouched.
  await tx.goodsReceipt.updateMany({
    where: { invoiceId: invoice.id },
    data: { invoiceId: null, invoicedAt: null },
  });

  // goods_receipt_item_id is @unique: null it so a new invoice can bind the same STT.
  await tx.purchaseInvoiceItem.updateMany({
    where: { purchaseInvoiceId: invoice.id, goodsReceiptItemId: { not: null } },
    data: { goodsReceiptItemId: null },
  });

  return { id: invoice.id, status: 'Cancelled' };
}
