import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';

/** Error code: the deposit was partly refunded, so a full cancel would over-reverse it. */
export const DEPOSIT_CANCEL_REFUNDED = 'DEPOSIT_REFUNDED';

/**
 * Reject cancelling a customer or supplier deposit that has a refund. The cancel reverses the full
 * amount, so the deposit account, cash and party balance would end short by the refund.
 */
export function assertDepositNotRefunded(deposit: { refundedAmount: Prisma.Decimal | Decimal | number | string }) {
  if (new Decimal(deposit.refundedAmount.toString()).gt(0)) {
    throw new BusinessError(
      'Uang muka ini sudah di-refund sebagian, jadi tidak bisa dibatalkan. Sisa uang muka tetap bisa dipakai di Invoice atau di-refund.',
      DEPOSIT_CANCEL_REFUNDED,
    );
  }
}

/** Error code: the deposit is the credit of a sales return; the return's cancel handles it. */
export const DEPOSIT_CANCEL_SALES_RETURN = 'DEPOSIT_FROM_SALES_RETURN';

/**
 * Reject cancelling a customer deposit created by a sales return. It has no journal of its own
 * (the return journal credits the liability), so a deposit cancel would post a one-sided reversal
 * and the return cancel would later reduce the party balance a second time.
 */
export async function assertDepositNotFromSalesReturn(tx: Prisma.TransactionClient, depositId: string) {
  const salesReturn = await tx.salesReturn.findFirst({
    where: { customerDepositId: depositId },
    select: { returnNumber: true },
  });
  if (salesReturn) {
    throw new BusinessError(
      `Uang muka ini berasal dari Retur Penjualan ${salesReturn.returnNumber}. Batalkan retur tersebut; uang mukanya ikut dibatalkan.`,
      DEPOSIT_CANCEL_SALES_RETURN,
    );
  }
}

/** Ledger narrations the deposit create paths have written, as `<prefix>: <paymentNumber>`. */
const DEPOSIT_NARRATION_PREFIXES: Record<'CustomerDeposit' | 'VendorDeposit', string[]> = {
  CustomerDeposit: ['Uang Muka Pelanggan', 'Saldo Awal Uang Muka Pelanggan'],
  VendorDeposit: ['Uang Muka Vendor', 'Saldo Awal Uang Muka Vendor', 'Uang Muka'],
};

/**
 * The create journal of a deposit whose payment.journalEntryId was never set (deposits posted
 * before the link was added on Apr 9 2026; the one-off backfill reached one database only).
 * Found by its number JV-<paymentNumber>, else through the deposit account ledger row with the
 * exact create narration, so refund, application and offset rows never match. A journal already
 * linked to another payment is skipped. Null when the deposit never had a journal.
 */
export async function findUnlinkedDepositJournal(
  tx: Prisma.TransactionClient,
  deposit: { id: string; paymentNumber: string; partyId: string; paymentType: 'CustomerDeposit' | 'VendorDeposit' },
) {
  const ownJournal = async (journalId: string) => {
    const journal = await tx.journalEntry.findUnique({ where: { id: journalId }, include: { items: true } });
    if (!journal) return null;
    const linked = await tx.payment.findUnique({ where: { journalEntryId: journal.id }, select: { id: true } });
    return linked && linked.id !== deposit.id ? null : journal;
  };

  const byNumber = await tx.journalEntry.findUnique({
    where: { entryNumber: `JV-${deposit.paymentNumber}` },
    select: { id: true },
  });
  if (byNumber) {
    const journal = await ownJournal(byNumber.id);
    if (journal) return journal;
  }

  const row = await tx.accountingLedgerEntry.findFirst({
    where: {
      referenceType: 'JournalEntry',
      partyId: deposit.partyId,
      description: { in: DEPOSIT_NARRATION_PREFIXES[deposit.paymentType].map((p) => `${p}: ${deposit.paymentNumber}`) },
    },
    select: { referenceId: true },
  });
  return row ? ownJournal(row.referenceId) : null;
}
