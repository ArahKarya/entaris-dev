// Cancelling a customer or supplier deposit payment (PATCH /customer-deposits/:id/cancel and
// PATCH /vendor-deposits/:id/cancel), moved out of the two routes unchanged so the opening balance
// service (services/ledger/openingBalance.ts) replaces an opening deposit through the same steps.
// The full deposit settlement (cancel and refund, E5-R6) builds on this module, not beside it.
import type { Prisma } from '@prisma/client';
import { updateAccountBalance } from '../utils/accountBalance';
import { BusinessError } from '../utils/errors';
import { voidJournalInTx } from '../utils/journalCancel';
import { claimCancel, type CancelTrail } from '../utils/cancelClaim';
import { assertPeriodOpen, type PeriodGuardOptions } from '../utils/periodGuard';
import { systemAccounts } from './systemAccounts';
import { assertDepositNotFromSalesReturn, assertDepositNotRefunded, findUnlinkedDepositJournal } from './depositCancelGuard';

type Tx = Prisma.TransactionClient;

export type DepositSide = 'CUSTOMER' | 'VENDOR';

const SIDE = {
  CUSTOMER: { paymentType: 'CustomerDeposit', role: 'CUSTOMER_DEPOSIT', wrongType: 'Bukan tipe uang muka customer.' },
  VENDOR: { paymentType: 'VendorDeposit', role: 'VENDOR_DEPOSIT', wrongType: 'Bukan tipe uang muka supplier.' },
} as const;

export interface DepositCancelOptions {
  /** Passed to the period guard of the deposit and of its journal (the opening balance through the lock). */
  periodOptions?: PeriodGuardOptions;
}

export interface CancelledDeposit {
  id: string;
  paymentNumber: string;
  amount: Prisma.Decimal;
  /** Entry number of the voided journal; null for a legacy deposit that never had one. */
  journalNumber: string | null;
}

/**
 * Cancels the deposit payment `depositId` in the caller's transaction: row lock, claim, refuse when it
 * is applied to an invoice, refunded or (customer) created by a sales return, period check, void its
 * journal in place (or reverse the balances of a legacy deposit without a journal), and lower the
 * party's deposit balance by its amount.
 */
export async function cancelDepositPaymentInTx(
  tx: Tx,
  depositId: string,
  side: DepositSide,
  trail: CancelTrail,
  opts: DepositCancelOptions = {},
): Promise<CancelledDeposit> {
  const cfg = SIDE[side];
  // Row lock: a second concurrent cancel waits here, then sees status Cancelled.
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${depositId} FOR UPDATE`;
  const deposit = await tx.payment.findUnique({
    where: { id: depositId },
    include: {
      customerDepositApplications: { where: { isCancelled: false } },
      depositApplications: { where: { isCancelled: false } },
      journalEntry: { include: { items: true } },
    },
  });
  if (!deposit) throw new BusinessError('Deposit tidak ditemukan.');
  if (deposit.paymentType !== cfg.paymentType) throw new BusinessError(cfg.wrongType);
  if (deposit.status === 'Cancelled') throw new BusinessError('Deposit sudah dibatalkan.');
  // First write, like every cancel: nothing below runs for a deposit another request cancelled.
  await claimCancel(tx.payment, depositId, { status: 'Cancelled', cancelledAt: new Date(), ...trail });

  const applications = side === 'CUSTOMER' ? deposit.customerDepositApplications : deposit.depositApplications;
  if (applications.length > 0) {
    throw new BusinessError('Deposit sudah digunakan untuk invoice. Batalkan penggunaan terlebih dahulu.');
  }
  assertDepositNotRefunded(deposit);
  if (side === 'CUSTOMER') await assertDepositNotFromSalesReturn(tx, deposit.id);

  // The journal's year when there is one; legacy deposits without a journal use their own.
  await assertPeriodOpen(
    tx,
    deposit.journalEntry
      ? { fiscalYearId: deposit.journalEntry.fiscalYearId, date: deposit.journalEntry.date }
      : { fiscalYearId: deposit.fiscalYearId, date: deposit.date },
    'uang muka',
    opts.periodOptions,
  );

  const depositAmount = Number(deposit.amount);

  // Void the journal in place (JE Cancelled, ALE isCancelled, balances reversed per item).
  // Deposits posted before the payment→journal link still have their journal, found unlinked.
  const journal = deposit.journalEntry ?? (await findUnlinkedDepositJournal(tx, { ...deposit, paymentType: cfg.paymentType }));
  if (journal) {
    await voidJournalInTx(tx, journal, 'uang muka', trail, opts.periodOptions);
  } else {
    // No journal and no ledger rows at all — reverse account balances directly.
    // Never add a [BATAL] reversal JV: there is no original to pair it with.
    const depositAccount = await systemAccounts.getAccount(cfg.role);
    const openingEquityAccount = await systemAccounts.getAccount('OPENING_EQUITY');
    if (side === 'CUSTOMER') {
      // Reverse: DR Customer Deposit / CR Ekuitas Saldo Awal
      await updateAccountBalance(tx, depositAccount.id, depositAmount, 0);
      await updateAccountBalance(tx, openingEquityAccount.id, 0, depositAmount);
    } else {
      // Reverse: CR Vendor Deposit / DR Ekuitas Saldo Awal
      await updateAccountBalance(tx, depositAccount.id, 0, depositAmount);
      await updateAccountBalance(tx, openingEquityAccount.id, depositAmount, 0);
    }
  }

  // Restore party deposit balance
  await tx.party.update({
    where: { id: deposit.partyId },
    data: side === 'CUSTOMER'
      ? { customerDepositBalance: { decrement: depositAmount } }
      : { depositBalance: { decrement: depositAmount } },
  });

  return { id: deposit.id, paymentNumber: deposit.paymentNumber, amount: deposit.amount, journalNumber: journal?.entryNumber ?? null };
}
