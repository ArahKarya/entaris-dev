import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { recalcPartyOutstanding } from '../utils/accountBalance';
import { voidJournalInTx } from '../utils/journalCancel';
import { assertPeriodOpen } from '../utils/periodGuard';
import { claimCancel, type CancelTrail } from '../utils/cancelClaim';
import { setSalesInvoiceOutstandingInTx } from './salesInvoiceStatus';
import { assertStockAvailable, lockInventoryRows } from './inventory/stockLocks';
import type { NegativeStockBypass } from '../utils/negativeStockGate';

type Tx = Prisma.TransactionClient;

/**
 * Cancel a sales return + reverse every side-effect it created (mirror of
 * invoiceCancellation):
 *   - flip JV-RN (and JV-COGS-RN) to Cancelled, mark ALE rows cancelled,
 *     reverse account balances
 *   - cancel the StockMovement(s) it created and decrement stock back; rejected with
 *     STOCK_INSUFFICIENT when the return's warehouse no longer holds it (opts bypass)
 *   - restore the original invoice's outstanding by arReducedAmount
 *   - cancel the linked CustomerDeposit Payment (blocked if already applied)
 *   - recompute party outstanding
 * Rejected with PERIOD_CLOSED when the return's fiscal year, or a journal's, is closed.
 * `trail` (who and why) is stored on the voided journals and the cancelled deposit.
 */
export async function cancelSalesReturnInTx(
  tx: Tx,
  returnId: string,
  trail?: CancelTrail,
  opts: NegativeStockBypass = {},
): Promise<{ id: string; status: 'Cancelled' }> {
  // Row lock: a second concurrent cancel waits here, then sees status Cancelled.
  await tx.$queryRaw`SELECT id FROM sales_returns WHERE id = ${returnId} FOR UPDATE`;
  const ret = await tx.salesReturn.findUnique({
    where: { id: returnId },
    include: { salesInvoice: true },
  });
  if (!ret) throw new BusinessError('Retur tidak ditemukan.');
  if (ret.status === 'Cancelled') throw new BusinessError('Retur sudah dibatalkan.');
  // First write; any rejection below rolls it back.
  await claimCancel(tx.salesReturn, ret.id, { status: 'Cancelled', cancelledAt: new Date() });
  await assertPeriodOpen(tx, { fiscalYearId: ret.fiscalYearId, date: ret.date }, 'retur');

  // Block if the credit (customer deposit) it created has been applied.
  if (ret.customerDepositId) {
    const appliedCount = await tx.customerDepositApplication.count({
      where: { depositPaymentId: ret.customerDepositId, isCancelled: false },
    });
    if (appliedCount > 0) {
      throw new BusinessError(
        'Kredit customer dari retur ini sudah dipakai di invoice lain. Batalkan penggunaan kredit terlebih dahulu.',
      );
    }
  }

  // Lock the restocked items before the journals lock their accounts (lock order in
  // services/inventory/stockLocks.ts), then check that the return's warehouse still holds what it
  // received: goods already sold or used again cannot be taken back out. allowNegativeStock (the
  // route checked inventory.negative_stock) logs the shortage instead.
  const movements = await tx.stockMovement.findMany({
    where: { referenceType: 'SalesReturn', referenceId: ret.id, isCancelled: false },
  });
  await lockInventoryRows(tx, {
    itemIds: movements.map((sm) => sm.itemId),
    pairs: movements.flatMap((sm) => (sm.warehouseId ? [{ itemId: sm.itemId, warehouseId: sm.warehouseId }] : [])),
  });
  await assertStockAvailable(
    tx,
    movements.map((sm) => ({ itemId: sm.itemId, warehouseId: sm.warehouseId, quantity: sm.quantity.toString() })),
    {
      context: 'salesReturn.cancel',
      userId: trail?.cancelledById,
      allowNegative: opts.allowNegativeStock,
      reason: opts.negativeStockReason,
      reversal: true,
    },
  );

  // Reverse main + COGS journals.
  for (const jvNumber of [`JV-${ret.returnNumber}`, `JV-COGS-${ret.returnNumber}`]) {
    const journal = await tx.journalEntry.findUnique({ where: { entryNumber: jvNumber }, include: { items: true } });
    if (!journal || journal.status === 'Cancelled') continue;
    await voidJournalInTx(tx, journal, 'retur', trail);
  }

  // Cancel the stock movements created by this return and take the stock back out.
  for (const sm of movements) {
    await tx.inventoryItem.update({
      where: { id: sm.itemId },
      data: { currentStock: { decrement: Number(sm.quantity) } },
    });
    if (sm.warehouseId) {
      await tx.inventoryStock.update({
        where: { itemId_warehouseId: { itemId: sm.itemId, warehouseId: sm.warehouseId } },
        data: { currentStock: { decrement: Number(sm.quantity) } },
      });
    }
    await tx.stockMovement.update({ where: { id: sm.id }, data: { isCancelled: true } });
  }

  // Restore invoice outstanding by the AR portion that was reduced. A Cancelled invoice keeps 0:
  // cancelling the return is how legacy data (invoice cancelled while a return was active) is fixed.
  const arReduced = Number(ret.arReducedAmount);
  if (arReduced > 0 && ret.salesInvoice.status !== 'Cancelled') {
    await setSalesInvoiceOutstandingInTx(tx, ret.salesInvoiceId, { delta: ret.arReducedAmount.toString() });
  }

  // Cancel the customer-deposit Payment (liability already reversed via main JE).
  if (ret.customerDepositId) {
    const dep = await tx.payment.update({
      where: { id: ret.customerDepositId },
      data: { status: 'Cancelled', cancelledAt: new Date(), ...trail },
    });
    // Mirror of submitSalesReturnInTx: roll back the cached deposit balance.
    await tx.party.update({
      where: { id: ret.partyId },
      data: { customerDepositBalance: { decrement: Number(dep.amount) } },
    });
  }

  await recalcPartyOutstanding(tx, ret.partyId);

  return { id: ret.id, status: 'Cancelled' };
}
