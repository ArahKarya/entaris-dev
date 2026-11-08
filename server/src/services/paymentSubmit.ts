import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { updateAccountBalance, recalcPartyOutstanding } from '../utils/accountBalance';
import { assertPartySideLocked } from './ledger/partySides';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { systemAccounts } from './systemAccounts';
import { logger } from '../lib/logger';
import { OUTSTANDING_TOLERANCE, setSalesInvoiceOutstandingInTx } from './salesInvoiceStatus';
import { businessDayOf } from '../utils/businessDate';
import { setOpeningBalanceInTx } from './ledger/openingBalance';
import { consumePartyOpening, isOpeningAllocation, paymentOpeningSide, restorePartyOpening } from './ledger/partyOpeningConsumption';

type Tx = Prisma.TransactionClient;

export type PaymentType =
  | 'Receive'
  | 'Pay'
  | 'VendorDeposit'
  | 'CustomerDeposit'
  | 'VendorRefund'
  | 'CustomerRefund';

export interface PaymentSplit {
  accountId: string;
  amount: number;
  notes?: string | null;
}

export interface SubmitPaymentInput {
  date: string;
  partyId: string;
  paymentType: PaymentType;
  accountId: string;
  amount: number;
  splits?: PaymentSplit[] | null;
  referenceNo?: string | null;
  notes?: string | null;
  isOpeningBalance?: boolean;
  refundSourcePaymentId?: string | null;
  salesOrderId?: string | null;
  proformaInvoiceId?: string | null;
}

/**
 * Submit a payment. Journal by paymentType:
 *   - VendorDeposit:   DR Uang Muka Vendor / CR Kas
 *   - CustomerDeposit: DR Kas / CR Uang Muka Pelanggan
 *   - an opening deposit (isOpeningBalance) goes to the opening balance service instead: dated on
 *     the cut-over date (another date is OPENING_DATE_MISMATCH), keyed per party, and it replaces
 *     the party's earlier opening deposit of that kind instead of adding to it
 *   - VendorRefund:    DR Bank / CR Hutang Usaha — supplier returns money;
 *                      optionally reduces a source Pay payment's allocations (invoices
 *                      first, then what it took from the opening)
 *   - CustomerRefund:  DR Piutang Usaha / CR Bank — we return money to customer
 *   - Receive:         DR Kas (multi-split) / CR Piutang Usaha — auto-allocate
 *                      to oldest open sales invoices
 *   - Pay:             DR Hutang Usaha / CR Kas (multi-split) — auto-allocate
 *                      to oldest open purchase invoices
 * Receive/Pay return the unallocated remainder: it takes the party's opening on the payment's side
 * (an Opening* allocation, services/ledger/partyOpeningConsumption.ts); what is left is logged as
 * an overpayment.
 */
export async function submitPaymentInTx(
  tx: Tx,
  body: SubmitPaymentInput,
  userId: string,
): Promise<{ payment: Awaited<ReturnType<Tx['payment']['create']>>; party: Awaited<ReturnType<Tx['party']['findUnique']>>; unallocatedAmount: number }> {
  const parsedDate = new Date(body.date);
  if (isNaN(parsedDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');

  const isOpeningDeposit =
    body.isOpeningBalance === true &&
    (body.paymentType === 'VendorDeposit' || body.paymentType === 'CustomerDeposit');
  if (isOpeningDeposit) return submitOpeningDepositInTx(tx, body, parsedDate, userId);

  const fiscalYear = await getOpenFiscalYear(tx, parsedDate);
  const bankAccount = await tx.account.findUnique({ where: { id: body.accountId } });
  if (!bankAccount) throw new BusinessError('Akun kas/bank tidak ditemukan.');
  const isCashAccount = await systemAccounts.isCashAccount(bankAccount.accountNumber);
  if (!isCashAccount) throw new BusinessError('Akun yang dipilih bukan akun kas/bank.');

  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Data mitra tidak ditemukan.');
  if (!party.isActive) throw new BusinessError('Mitra sudah tidak aktif.');

  const proformaInvoiceId = await proformaTagOf(tx, body);

  const paymentNumber = await generateDocumentNumber(tx, 'PAY', parsedDate, fiscalYear.id);
  const numAmount = body.amount;

  const resolvedAccountId = body.accountId;

  const payment = await tx.payment.create({
    data: {
      paymentNumber,
      date: parsedDate,
      partyId: body.partyId,
      paymentType: body.paymentType,
      accountId: resolvedAccountId,
      amount: numAmount,
      status: 'Submitted',
      referenceNo: body.referenceNo || null,
      notes: body.notes || null,
      // Tag SO hanya untuk CustomerDeposit (uang muka pesanan).
      salesOrderId: body.paymentType === 'CustomerDeposit' ? (body.salesOrderId ?? null) : null,
      proformaInvoiceId,
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
    },
  });

  // VendorDeposit
  if (body.paymentType === 'VendorDeposit') {
    if (party.partyType !== 'Supplier' && party.partyType !== 'Both') {
      throw new BusinessError('Uang muka hanya dapat dibuat untuk Supplier.');
    }
    const depositAccount = await systemAccounts.getAccount('VENDOR_DEPOSIT');
    const creditAccountId = body.accountId;
    const narrationPrefix = 'Uang Muka Vendor';

    const jvNumber = `JV-${paymentNumber}`;
    const existingJV = await tx.journalEntry.findUnique({ where: { entryNumber: jvNumber } });
    if (existingJV) throw new BusinessError(`Nomor jurnal ${jvNumber} sudah ada. Silakan coba lagi.`);

    const journalEntry = await tx.journalEntry.create({
      data: {
        entryNumber: jvNumber,
        date: parsedDate,
        narration: `${narrationPrefix}: ${paymentNumber} - ${party.name}`,
        status: 'Submitted',
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
        items: {
          create: [
            { accountId: depositAccount.id, partyId: body.partyId, debit: numAmount, credit: 0, description: `${narrationPrefix}: ${paymentNumber}` },
            { accountId: creditAccountId, debit: 0, credit: numAmount, description: `${narrationPrefix}: ${paymentNumber}` },
          ],
        },
      },
    });

    await tx.accountingLedgerEntry.createMany({
      data: [
        { date: parsedDate, accountId: depositAccount.id, partyId: body.partyId, debit: numAmount, credit: 0, referenceType: 'JournalEntry', referenceId: journalEntry.id, description: `${narrationPrefix}: ${paymentNumber}`, fiscalYearId: fiscalYear.id },
        { date: parsedDate, accountId: creditAccountId, debit: 0, credit: numAmount, referenceType: 'JournalEntry', referenceId: journalEntry.id, description: `${narrationPrefix}: ${paymentNumber}`, fiscalYearId: fiscalYear.id },
      ],
    });

    await updateAccountBalance(tx, depositAccount.id, numAmount, 0);
    await updateAccountBalance(tx, creditAccountId, 0, numAmount);

    await assertPartySideLocked(tx, body.partyId, 'PAYABLE');
    await tx.party.update({
      where: { id: body.partyId },
      data: { depositBalance: { increment: numAmount } },
    });

    await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: journalEntry.id } });
    return { payment, party, unallocatedAmount: 0 };
  }

  // CustomerDeposit
  if (body.paymentType === 'CustomerDeposit') {
    if (party.partyType !== 'Customer' && party.partyType !== 'Both') {
      throw new BusinessError('Uang muka customer hanya dapat dibuat untuk Customer.');
    }
    const depositAccount = await systemAccounts.getAccount('CUSTOMER_DEPOSIT');
    const debitAccountId = body.accountId;
    const narrationPrefix = 'Uang Muka Pelanggan';

    const jvNumber = `JV-${paymentNumber}`;
    const existingJV = await tx.journalEntry.findUnique({ where: { entryNumber: jvNumber } });
    if (existingJV) throw new BusinessError(`Nomor jurnal ${jvNumber} sudah ada. Silakan coba lagi.`);

    const journalEntry = await tx.journalEntry.create({
      data: {
        entryNumber: jvNumber,
        date: parsedDate,
        narration: `${narrationPrefix}: ${paymentNumber} - ${party.name}`,
        status: 'Submitted',
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
        items: {
          create: [
            { accountId: debitAccountId, debit: numAmount, credit: 0, description: `${narrationPrefix}: ${paymentNumber}` },
            { accountId: depositAccount.id, partyId: body.partyId, debit: 0, credit: numAmount, description: `${narrationPrefix}: ${paymentNumber}` },
          ],
        },
      },
    });

    await tx.accountingLedgerEntry.createMany({
      data: [
        { date: parsedDate, accountId: debitAccountId, debit: numAmount, credit: 0, referenceType: 'JournalEntry', referenceId: journalEntry.id, description: `${narrationPrefix}: ${paymentNumber}`, fiscalYearId: fiscalYear.id },
        { date: parsedDate, accountId: depositAccount.id, partyId: body.partyId, debit: 0, credit: numAmount, referenceType: 'JournalEntry', referenceId: journalEntry.id, description: `${narrationPrefix}: ${paymentNumber}`, fiscalYearId: fiscalYear.id },
      ],
    });

    await updateAccountBalance(tx, debitAccountId, numAmount, 0);
    await updateAccountBalance(tx, depositAccount.id, 0, numAmount);

    await assertPartySideLocked(tx, body.partyId, 'RECEIVABLE');
    await tx.party.update({
      where: { id: body.partyId },
      data: { customerDepositBalance: { increment: numAmount } },
    });

    await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: journalEntry.id } });
    return { payment, party, unallocatedAmount: 0 };
  }

  // VendorRefund / CustomerRefund
  if (body.paymentType === 'VendorRefund' || body.paymentType === 'CustomerRefund') {
    const isVendorRefund = body.paymentType === 'VendorRefund';
    if (isVendorRefund && party.partyType !== 'Supplier' && party.partyType !== 'Both') {
      throw new BusinessError('Refund supplier hanya berlaku untuk Supplier.');
    }
    if (!isVendorRefund && party.partyType !== 'Customer' && party.partyType !== 'Both') {
      throw new BusinessError('Refund customer hanya berlaku untuk Customer.');
    }

    // Lock the source payment before any account row: a cancel of it claims the same row first, so
    // the two serialize (a cancelled payment cannot also be refunded, nor its opening restored twice)
    // and keep the payment-then-accounts order of the cancel route.
    if (body.refundSourcePaymentId) {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${body.refundSourcePaymentId} FOR UPDATE`;
    }

    const liabAssetAccount = isVendorRefund
      ? await systemAccounts.getAccount('AP')
      : await systemAccounts.getAccount('AR');

    const bankItem = {
      accountId: body.accountId,
      partyId: null as string | null,
      debit: isVendorRefund ? numAmount : 0,
      credit: isVendorRefund ? 0 : numAmount,
      description: `Refund ${isVendorRefund ? 'Vendor' : 'Pelanggan'}: ${paymentNumber}`,
    };
    const liabAssetItem = {
      accountId: liabAssetAccount.id,
      partyId: body.partyId,
      debit: isVendorRefund ? 0 : numAmount,
      credit: isVendorRefund ? numAmount : 0,
      description: `Refund ${isVendorRefund ? 'Vendor' : 'Pelanggan'}: ${paymentNumber} (restore ${isVendorRefund ? 'hutang' : 'piutang'})`,
    };

    const jvNumber = `JV-${paymentNumber}`;
    const existingJV = await tx.journalEntry.findUnique({ where: { entryNumber: jvNumber } });
    if (existingJV) throw new BusinessError(`Nomor jurnal ${jvNumber} sudah ada. Silakan coba lagi.`);

    const journalEntry = await tx.journalEntry.create({
      data: {
        entryNumber: jvNumber,
        date: parsedDate,
        narration: `Refund ${isVendorRefund ? 'Vendor' : 'Pelanggan'}: ${paymentNumber} - ${party.name}`,
        status: 'Submitted',
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
        items: { create: [bankItem, liabAssetItem] },
      },
    });

    await tx.accountingLedgerEntry.createMany({
      data: [bankItem, liabAssetItem].map((it) => ({
        date: parsedDate,
        accountId: it.accountId,
        partyId: it.partyId,
        debit: Number(it.debit),
        credit: Number(it.credit),
        referenceType: 'JournalEntry',
        referenceId: journalEntry.id,
        description: it.description,
        fiscalYearId: fiscalYear.id,
      })),
    });

    await updateAccountBalance(tx, bankItem.accountId, Number(bankItem.debit), Number(bankItem.credit));
    await updateAccountBalance(tx, liabAssetItem.accountId, Number(liabAssetItem.debit), Number(liabAssetItem.credit));

    // Link to source payment: reduce its allocations and restore invoice
    // outstanding starting from newest invoice. Throws if refund exceeds
    // available allocations.
    if (body.refundSourcePaymentId) {
      const expectedType = isVendorRefund ? 'Pay' : 'Receive';
      // Read under the lock taken above: status and allocations as the last cancel or refund left them.
      const source = await tx.payment.findUnique({
        where: { id: body.refundSourcePaymentId },
        include: { allocations: true },
      });
      if (!source) throw new BusinessError('Pembayaran asal tidak ditemukan.');
      if (source.partyId !== body.partyId) throw new BusinessError('Pembayaran asal bukan dari pihak yang sama.');
      if (source.paymentType !== expectedType) {
        throw new BusinessError(`Pembayaran asal harus bertipe ${expectedType}.`);
      }
      if (source.status !== 'Submitted') throw new BusinessError('Pembayaran asal sudah dibatalkan.');

      let remaining = new Decimal(numAmount);
      const expectedInvoiceType = isVendorRefund ? 'PurchaseInvoice' : 'SalesInvoice';
      const sortedAllocs = [...source.allocations]
        .filter((a) => a.invoiceType === expectedInvoiceType)
        .sort((a, b) => Number(b.allocatedAmount) - Number(a.allocatedAmount));

      for (const alloc of sortedAllocs) {
        if (remaining.lte(0)) break;
        const allocAmount = new Decimal(alloc.allocatedAmount.toString());
        const reverseAmt = Decimal.min(remaining, allocAmount);
        remaining = remaining.minus(reverseAmt);
        const newAlloc = allocAmount.minus(reverseAmt);

        if (newAlloc.lte(new Decimal('0.01'))) {
          await tx.paymentAllocation.delete({ where: { id: alloc.id } });
        } else {
          await tx.paymentAllocation.update({
            where: { id: alloc.id },
            data: { allocatedAmount: newAlloc.toNumber() },
          });
        }

        if (isVendorRefund) {
          const inv = await tx.purchaseInvoice.findUnique({ where: { id: alloc.invoiceId } });
          if (inv) {
            const newOutstanding = new Decimal(inv.outstanding.toString()).plus(reverseAmt);
            const newStatus = newOutstanding.gte(new Decimal(inv.grandTotal.toString()))
              ? 'Submitted'
              : 'PartiallyPaid';
            await tx.purchaseInvoice.update({
              where: { id: inv.id },
              data: { outstanding: newOutstanding.toNumber(), status: newStatus },
            });
          }
        } else {
          await setSalesInvoiceOutstandingInTx(tx, alloc.invoiceId, { delta: reverseAmt });
        }
      }

      // Then what the source payment took from the party's opening, back into the same bucket.
      const openingAllocs = source.allocations
        .filter((a) => isOpeningAllocation(a.invoiceType))
        .sort((a, b) => Number(b.allocatedAmount) - Number(a.allocatedAmount));
      for (const alloc of openingAllocs) {
        if (remaining.lte(0)) break;
        const allocAmount = new Decimal(alloc.allocatedAmount.toString());
        const reverseAmt = Decimal.min(remaining, allocAmount);
        remaining = remaining.minus(reverseAmt);
        const newAlloc = allocAmount.minus(reverseAmt);
        if (newAlloc.lte(new Decimal('0.01'))) {
          await tx.paymentAllocation.delete({ where: { id: alloc.id } });
        } else {
          await tx.paymentAllocation.update({ where: { id: alloc.id }, data: { allocatedAmount: newAlloc.toFixed(2) } });
        }
        await restorePartyOpening(tx, body.partyId, alloc.invoiceType, reverseAmt.toFixed(2));
      }

      if (remaining.gt(new Decimal('0.01'))) {
        throw new BusinessError(
          `Nilai refund (${numAmount}) melebihi total alokasi pembayaran asal yang tersedia.`,
        );
      }
    }

    await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: journalEntry.id } });
    await assertPartySideLocked(tx, body.partyId, isVendorRefund ? 'PAYABLE' : 'RECEIVABLE');
    await recalcPartyOutstanding(tx, body.partyId);
    return { payment, party, unallocatedAmount: 0 };
  }

  // Receive / Pay
  const arAccount = await systemAccounts.getAccount('AR');
  const apAccount = await systemAccounts.getAccount('AP');

  // Multi-account splits (e.g. invoice 280jt → BCA 270jt + Petty 7.5jt +
  // Beban Komisi 2.5jt) vs single account fallback.
  const useSplits = Array.isArray(body.splits) && body.splits.length > 0;
  const splits = useSplits
    ? body.splits!
    : [{ accountId: body.accountId, amount: numAmount, notes: null as string | null }];

  const splitsSum = splits.reduce((s, sp) => s.plus(new Decimal(sp.amount)), new Decimal(0));
  if (splitsSum.minus(new Decimal(numAmount)).abs().gt(new Decimal('0.01'))) {
    throw new BusinessError(
      `Total split (${splitsSum.toFixed(2)}) tidak sama dengan jumlah pembayaran (${numAmount.toFixed(2)}).`,
    );
  }

  if (useSplits) {
    await tx.paymentSplit.createMany({
      data: splits.map((sp) => ({
        paymentId: payment.id,
        accountId: sp.accountId,
        amount: sp.amount,
        notes: sp.notes ?? null,
      })),
    });
  }

  const jvNumber = `JV-${paymentNumber}`;
  const existingJV = await tx.journalEntry.findUnique({ where: { entryNumber: jvNumber } });
  if (existingJV) throw new BusinessError(`Nomor jurnal ${jvNumber} sudah ada. Silakan coba lagi.`);

  const splitItems = splits.map((sp) => ({
    accountId: sp.accountId,
    partyId: body.paymentType === 'Pay' ? body.partyId : null,
    debit: body.paymentType === 'Receive' ? sp.amount : 0,
    credit: body.paymentType === 'Receive' ? 0 : sp.amount,
    description: `Pembayaran: ${paymentNumber}${sp.notes ? ` (${sp.notes})` : ''}`,
  }));
  const arApItem = body.paymentType === 'Receive'
    ? {
        accountId: arAccount.id,
        partyId: body.partyId,
        debit: 0,
        credit: numAmount,
        description: `Pembayaran: ${paymentNumber}`,
      }
    : {
        accountId: apAccount.id,
        partyId: body.partyId,
        debit: numAmount,
        credit: 0,
        description: `Pembayaran: ${paymentNumber}`,
      };

  const journalEntry = await tx.journalEntry.create({
    data: {
      entryNumber: jvNumber,
      date: parsedDate,
      narration: `Pembayaran ${body.paymentType}: ${paymentNumber} - ${party.name}`,
      status: 'Submitted',
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
      items: { create: [...splitItems, arApItem] },
    },
  });

  await tx.accountingLedgerEntry.createMany({
    data: [
      ...splitItems.map((it) => ({
        date: parsedDate,
        accountId: it.accountId,
        partyId: it.partyId,
        debit: Number(it.debit),
        credit: Number(it.credit),
        referenceType: 'JournalEntry',
        referenceId: journalEntry.id,
        description: it.description,
        fiscalYearId: fiscalYear.id,
      })),
      {
        date: parsedDate,
        accountId: arApItem.accountId,
        partyId: arApItem.partyId,
        debit: Number(arApItem.debit),
        credit: Number(arApItem.credit),
        referenceType: 'JournalEntry',
        referenceId: journalEntry.id,
        description: arApItem.description,
        fiscalYearId: fiscalYear.id,
      },
    ],
  });

  for (const it of splitItems) {
    await updateAccountBalance(tx, it.accountId, Number(it.debit), Number(it.credit));
  }
  await updateAccountBalance(tx, arApItem.accountId, Number(arApItem.debit), Number(arApItem.credit));

  await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: journalEntry.id } });

  const unallocatedAmount = await autoAllocatePayment(
    tx,
    payment.id,
    body.partyId,
    body.paymentType,
    numAmount,
  );

  // The unallocated remainder takes the party's opening on the payment's side (receivable for a
  // Receive, payable for a Pay), recorded as Opening* allocations so a cancel or a refund puts it
  // back (plan step 5 PR-5.13).
  if (unallocatedAmount > 0.01) {
    const side = paymentOpeningSide(body.paymentType === 'Receive' ? 'Receive' : 'Pay');
    const taken = await consumePartyOpening(tx, payment.id, body.partyId, side, unallocatedAmount.toFixed(2));
    const finalUnallocated = new Decimal(unallocatedAmount).minus(taken.toString());
    if (finalUnallocated.gt(new Decimal('0.01'))) {
      logger.warn({ paymentId: payment.id, unallocatedAmount: finalUnallocated.toNumber() }, 'Overpayment: sisa pembayaran tidak teralokasi');
    }
  }

  // Receive posts to the receivable side, Pay to the payable side; re-read under the party row lock.
  await assertPartySideLocked(tx, body.partyId, body.paymentType === 'Receive' ? 'RECEIVABLE' : 'PAYABLE');
  await recalcPartyOutstanding(tx, body.partyId);
  return { payment, party, unallocatedAmount };
}

type SubmittedPayment = Awaited<ReturnType<typeof submitPaymentInTx>>;

/** Tag Proforma hanya untuk CustomerDeposit; proforma harus aktif dan milik customer yang sama. */
async function proformaTagOf(tx: Tx, body: SubmitPaymentInput): Promise<string | null> {
  if (body.paymentType !== 'CustomerDeposit' || !body.proformaInvoiceId) return null;
  const pf = await tx.proformaInvoice.findUnique({ where: { id: body.proformaInvoiceId } });
  if (!pf) throw new BusinessError('Proforma Invoice tidak ditemukan.');
  if (pf.status === 'Cancelled') throw new BusinessError('Proforma Invoice sudah dibatalkan.');
  if (pf.partyId !== body.partyId) throw new BusinessError('Customer pada uang muka tidak sama dengan Proforma Invoice.');
  return pf.id;
}

/**
 * An opening deposit from the deposit screen (or AIRA): the opening balance service posts it on the
 * cut-over date as the party's VDEP/CDEP opening, replacing the earlier one. `body.date` must be the
 * cut-over day; `body.accountId` is ignored (the counter account is the opening equity). The
 * reference, notes and (customer) Sales Order / Proforma tags go on the new deposit payment.
 */
async function submitOpeningDepositInTx(tx: Tx, body: SubmitPaymentInput, parsedDate: Date, userId: string): Promise<SubmittedPayment> {
  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Data mitra tidak ditemukan.');
  if (!party.isActive) throw new BusinessError('Mitra sudah tidak aktif.');
  const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : businessDayOf(parsedDate);
  const isCustomer = body.paymentType === 'CustomerDeposit';
  const outcome = await setOpeningBalanceInTx(tx, {
    target: { kind: 'PARTY', partyId: body.partyId, subledger: isCustomer ? 'CDEP' : 'VDEP' },
    amount: String(body.amount),
    asOfDate,
    userId,
    deposit: {
      referenceNo: body.referenceNo || null,
      notes: body.notes || null,
      salesOrderId: isCustomer ? (body.salesOrderId ?? null) : null,
      proformaInvoiceId: await proformaTagOf(tx, body),
    },
  });
  if (!outcome.payment) throw new BusinessError('Saldo awal uang muka tidak tercatat.');
  return { payment: outcome.payment, party, unallocatedAmount: 0 };
}

/**
 * Auto-allocate a Receive/Pay payment to outstanding invoices (oldest-first).
 * Locks invoice rows with FOR UPDATE to prevent concurrent allocation drift.
 * Returns the unallocated remainder.
 */
async function autoAllocatePayment(
  tx: Tx,
  paymentId: string,
  partyId: string,
  paymentType: string,
  amount: number,
): Promise<number> {
  let remaining = new Decimal(amount);

  if (paymentType === 'Receive') {
    await tx.$queryRaw`SELECT id FROM sales_invoices WHERE party_id = ${partyId} AND status IN ('Submitted', 'PartiallyPaid', 'Overdue') FOR UPDATE`;
    // Nothing left to pay (e.g. a legacy Submitted invoice emptied by a full return) gets no
    // allocation: a Rp 0 allocation would only flip its status.
    const invoices = await tx.salesInvoice.findMany({
      where: { partyId, status: { in: ['Submitted', 'PartiallyPaid', 'Overdue'] }, outstanding: { gt: OUTSTANDING_TOLERANCE.toNumber() } },
      orderBy: { date: 'asc' },
    });

    for (const inv of invoices) {
      if (remaining.lte(0)) break;
      const outstanding = new Decimal(inv.outstanding.toString());
      if (outstanding.lte(OUTSTANDING_TOLERANCE)) continue;
      const allocate = Decimal.min(remaining, outstanding);
      remaining = remaining.minus(allocate);

      await setSalesInvoiceOutstandingInTx(tx, inv.id, { delta: allocate.neg() });
      await tx.paymentAllocation.create({
        data: {
          paymentId,
          invoiceType: 'SalesInvoice',
          invoiceId: inv.id,
          allocatedAmount: allocate.toNumber(),
        },
      });
    }
  } else {
    await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE party_id = ${partyId} AND status IN ('Submitted', 'PartiallyPaid', 'Overdue') FOR UPDATE`;
    const invoices = await tx.purchaseInvoice.findMany({
      where: { partyId, status: { in: ['Submitted', 'PartiallyPaid', 'Overdue'] } },
      orderBy: { date: 'asc' },
    });

    for (const inv of invoices) {
      if (remaining.lte(0)) break;
      const outstanding = new Decimal(inv.outstanding.toString());
      const allocate = Decimal.min(remaining, outstanding);
      remaining = remaining.minus(allocate);
      const newOutstanding = outstanding.minus(allocate);
      const newStatus = newOutstanding.lte(new Decimal('0.01')) ? 'Paid' : 'PartiallyPaid';

      await tx.purchaseInvoice.update({
        where: { id: inv.id },
        data: { outstanding: newOutstanding.toNumber(), status: newStatus },
      });
      await tx.paymentAllocation.create({
        data: {
          paymentId,
          invoiceType: 'PurchaseInvoice',
          invoiceId: inv.id,
          allocatedAmount: allocate.toNumber(),
        },
      });
    }
  }

  return remaining.gt(0) ? remaining.toNumber() : 0;
}
