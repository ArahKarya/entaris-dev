import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { recalcPartyOutstanding } from '../utils/accountBalance';
import { voidJournalInTx } from '../utils/journalCancel';
import { assertPeriodOpen } from '../utils/periodGuard';

type Tx = Prisma.TransactionClient;

/**
 * Cancel a sales return + reverse every side-effect it created (mirror of
 * invoiceCancellation):
 *   - flip JV-RN (and JV-COGS-RN) to Cancelled, mark ALE rows cancelled,
 *     reverse account balances
 *   - cancel the StockMovement(s) it created and decrement stock back
 *   - restore the original invoice's outstanding by arReducedAmount
 *   - cancel the linked CustomerDeposit Payment (blocked if already applied)
 *   - recompute party outstanding
 * Rejected with PERIOD_CLOSED when the return's fiscal year, or a journal's, is closed.
 */
export async function cancelSalesReturnInTx(
  tx: Tx,
  returnId: string,
): Promise<{ id: string; status: 'Cancelled' }> {
  const ret = await tx.salesReturn.findUnique({
    where: { id: returnId },
    include: { salesInvoice: true },
  });
  if (!ret) throw new BusinessError('Retur tidak ditemukan.');
  if (ret.status === 'Cancelled') throw new BusinessError('Retur sudah dibatalkan.');
  await assertPeriodOpen(tx, { fiscalYearId: ret.fiscalYearId }, 'retur');

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

  // Reverse main + COGS journals.
  for (const jvNumber of [`JV-${ret.returnNumber}`, `JV-COGS-${ret.returnNumber}`]) {
    const journal = await tx.journalEntry.findUnique({ where: { entryNumber: jvNumber }, include: { items: true } });
    if (!journal || journal.status === 'Cancelled') continue;
    await voidJournalInTx(tx, journal, 'retur');
  }

  // Cancel stock movements created by this return + decrement stock back.
  const movements = await tx.stockMovement.findMany({
    where: { referenceType: 'SalesReturn', referenceId: ret.id, isCancelled: false },
  });
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

  // Restore invoice outstanding by the AR portion that was reduced.
  const arReduced = Number(ret.arReducedAmount);
  if (arReduced > 0 && ret.salesInvoice.status !== 'Cancelled') {
    await tx.salesInvoice.update({
      where: { id: ret.salesInvoiceId },
      data: { outstanding: { increment: arReduced } },
    });
  }

  // Cancel the customer-deposit Payment (liability already reversed via main JE).
  if (ret.customerDepositId) {
    const dep = await tx.payment.update({
      where: { id: ret.customerDepositId },
      data: { status: 'Cancelled', cancelledAt: new Date() },
    });
    // Mirror of submitSalesReturnInTx: roll back the cached deposit balance.
    await tx.party.update({
      where: { id: ret.partyId },
      data: { customerDepositBalance: { decrement: Number(dep.amount) } },
    });
  }

  await tx.salesReturn.update({
    where: { id: ret.id },
    data: { status: 'Cancelled', cancelledAt: new Date() },
  });
  await recalcPartyOutstanding(tx, ret.partyId);

  return { id: ret.id, status: 'Cancelled' };
}
