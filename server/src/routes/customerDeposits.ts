import { Router, type Response } from 'express';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { updateAccountBalance, recalcPartyOutstanding } from '../utils/accountBalance';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { validateBody } from '../utils/validate';
import { ApplyCustomerDepositSchema, CancelReasonSchema, RefundCustomerDepositSchema } from '../utils/schemas';
import { BusinessError, handleRouteError } from '../utils/errors';
import { voidDepositApplicationJournalInTx } from '../services/depositApplicationCancel';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { assertPeriodOpen } from '../utils/periodGuard';
import { systemAccounts } from '../services/systemAccounts';
import { setSalesInvoiceOutstandingInTx } from '../services/salesInvoiceStatus';
import { cancelDepositPaymentInTx } from '../services/depositCancel';
import { cancelDepositRefundInTx, depositRefundSourceKey, listDepositRefunds } from '../services/depositRefundCancel';
import { logger } from '../lib/logger';
import { parseListPaging, parseSort } from '../utils/listQuery';
import {
  buildCustomerDepositWhere,
  CUSTOMER_DEPOSIT_SORT_FIELDS,
  DEFAULT_CUSTOMER_DEPOSIT_SORT,
  depositFigures,
  filterByUsage,
  pageDeposits,
  summarizeCustomerDeposits,
  toLightRow,
} from '../services/customerDepositList';

const router = Router();

const DEPOSIT_LIST_INCLUDE = {
  party: true,
  account: { select: { id: true, name: true, accountNumber: true } },
  customerDepositApplications: {
    where: { isCancelled: false },
    select: { id: true, appliedAmount: true, salesInvoiceId: true, appliedAt: true },
  },
} satisfies Prisma.PaymentInclude;

type DepositWithApplications = Prisma.PaymentGetPayload<{ include: typeof DEPOSIT_LIST_INCLUDE }>;

/** Row shape returned by both list modes: the payment + computed figures. */
function enrichDeposit(d: DepositWithApplications) {
  return { ...d, ...depositFigures(d.amount, d.refundedAmount, d.customerDepositApplications) };
}

/** Light projection for paging / summary (see services/customerDepositList). */
async function loadDepositLightRows(where: Prisma.PaymentWhereInput) {
  const rows = await prisma.payment.findMany({
    where,
    select: {
      id: true,
      paymentNumber: true,
      date: true,
      status: true,
      amount: true,
      refundedAmount: true,
      party: { select: { name: true } },
      customerDepositApplications: { where: { isCancelled: false }, select: { appliedAmount: true } },
    },
  });
  return rows.map(toLightRow);
}

// GET /api/customer-deposits — list customer deposits.
//
// Two modes (backward compatible):
//  • without `page` (legacy — PaymentModal and other callers): every deposit,
//    filters `partyId` and raw `status` (DocumentStatus), ordered by date desc,
//    response `{ data }` exactly as before.
//  • with `page` (list page): `page`, `limit` (≤200), `status` (Active |
//    PartiallyUsed | FullyUsed | Draft | Submitted | Cancelled), `partyId`,
//    `startDate`/`endDate` (YYYY-MM-DD), `search`, `sort` (e.g. "-remaining")
//    → `{ data, total, page, limit }`; rows also carry `state`.
router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    if (query.page !== undefined) return await listDepositsPaged(query, res);

    const { partyId, status } = req.query;

    const where: Prisma.PaymentWhereInput = { paymentType: 'CustomerDeposit' };
    if (partyId) where.partyId = partyId as string;
    if (status) where.status = status as any;

    const deposits = await prisma.payment.findMany({
      where,
      include: DEPOSIT_LIST_INCLUDE,
      orderBy: { date: 'desc' },
    });

    return res.json({ data: deposits.map(enrichDeposit) });
  } catch (error) {
    logger.error({ error }, 'GET /customer-deposits error');
    return res.status(500).json({ error: 'Gagal mengambil data uang muka customer.' });
  }
});

async function listDepositsPaged(query: Record<string, unknown>, res: Response) {
  const { page, limit, skip } = parseListPaging(query, { defaultLimit: 25, maxLimit: 200 });
  const filter = buildCustomerDepositWhere(query);
  if (!filter.ok) return res.status(400).json({ error: filter.error });
  const sort = parseSort(query.sort, CUSTOMER_DEPOSIT_SORT_FIELDS, DEFAULT_CUSTOMER_DEPOSIT_SORT);

  const light = await loadDepositLightRows(filter.where);
  const { ids, total } = pageDeposits(light, { usage: filter.usage, sort, skip, limit });
  const stateById = new Map(light.map((r) => [r.id, r.state]));

  const rows = ids.length
    ? await prisma.payment.findMany({ where: { id: { in: ids } }, include: DEPOSIT_LIST_INCLUDE })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const data = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ ...enrichDeposit(row), state: stateById.get(id) }] : [];
  });

  return res.json({ data, total, page, limit });
}

// GET /api/customer-deposits/summary — KPI totals for the same filters as the
// paged list (status, partyId, startDate, endDate, search).
router.get('/summary', async (req, res) => {
  try {
    const filter = buildCustomerDepositWhere(req.query as Record<string, unknown>);
    if (!filter.ok) return res.status(400).json({ error: filter.error });
    const light = await loadDepositLightRows(filter.where);
    return res.json(summarizeCustomerDeposits(filterByUsage(light, filter.usage)));
  } catch (error) {
    logger.error({ error }, 'GET /customer-deposits/summary error');
    return res.status(500).json({ error: 'Gagal menghitung ringkasan uang muka customer.' });
  }
});

// GET /api/customer-deposits/balance/:partyId — deposit balance per customer
router.get('/balance/:partyId', async (req, res) => {
  try {
    const { partyId } = req.params;

    const deposits = await prisma.payment.findMany({
      where: { partyId, paymentType: 'CustomerDeposit', status: 'Submitted' },
      include: {
        account: { select: { id: true, name: true, accountNumber: true } },
        customerDepositApplications: {
          where: { isCancelled: false },
          select: { id: true, appliedAmount: true, salesInvoiceId: true, appliedAt: true },
        },
      },
      orderBy: { date: 'asc' },
    });

    const items = deposits.map((d) => {
      const totalApplied = d.customerDepositApplications.reduce(
        (sum, app) => sum.plus(new Decimal(app.appliedAmount.toString())),
        new Decimal(0)
      );
      const refunded = new Decimal((d as any).refundedAmount?.toString() ?? '0');
      const remaining = new Decimal(d.amount.toString()).minus(totalApplied).minus(refunded);
      return {
        id: d.id,
        paymentNumber: d.paymentNumber,
        date: d.date,
        amount: Number(d.amount),
        totalApplied: totalApplied.toNumber(),
        remaining: remaining.toNumber(),
        referenceNo: d.referenceNo,
        account: d.account,
      };
    }).filter((d) => d.remaining > 0.01);

    const totalBalance = items.reduce((sum, d) => sum + d.remaining, 0);

    return res.json({ data: items, totalBalance });
  } catch (error) {
    logger.error({ error }, 'GET /customer-deposits/balance error');
    return res.status(500).json({ error: 'Gagal mengambil saldo uang muka customer.' });
  }
});

// PATCH /api/customer-deposits/:id/cancel — cancel a customer deposit payment (requires doc.cancel)
router.patch('/:id/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const body = validateBody(CancelReasonSchema, req.body ?? {}, res);
  if (!body) return;
  const trail = cancelTrail(req.user!.userId, body.reason);

  try {
    await prisma.$transaction((tx: Prisma.TransactionClient) => cancelDepositPaymentInTx(tx, id, 'CUSTOMER', trail), { timeout: 15000 });

    return res.json({ message: 'Uang muka customer dibatalkan.' });
  } catch (error: any) {
    return handleRouteError(res, error, 'PATCH /customer-deposits/:id/cancel', 'Gagal membatalkan uang muka customer.');
  }
});

// POST /api/customer-deposits/apply — apply deposit to sales invoice
router.post('/apply', async (req: AuthRequest, res) => {
  const body = validateBody(ApplyCustomerDepositSchema, req.body, res);
  if (!body) return;

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Lock rows to prevent concurrent application
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${body.depositPaymentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM sales_invoices WHERE id = ${body.salesInvoiceId} FOR UPDATE`;

      const deposit = await tx.payment.findUnique({
        where: { id: body.depositPaymentId },
        include: { customerDepositApplications: { where: { isCancelled: false } } },
      });
      if (!deposit) throw new BusinessError('Deposit tidak ditemukan.');
      if (deposit.paymentType !== 'CustomerDeposit') throw new BusinessError('Pembayaran bukan tipe Uang Muka Customer.');
      if (deposit.status !== 'Submitted') throw new BusinessError('Deposit sudah dibatalkan.');

      const invoice = await tx.salesInvoice.findUnique({
        where: { id: body.salesInvoiceId },
        include: { customer: true },
      });
      if (!invoice) throw new BusinessError('Invoice penjualan tidak ditemukan.');
      if (invoice.status === 'Cancelled') throw new BusinessError('Invoice sudah dibatalkan.');
      if (invoice.status === 'Paid') throw new BusinessError('Invoice sudah lunas.');

      if (deposit.partyId !== invoice.partyId) {
        throw new BusinessError('Deposit dan invoice harus dari customer yang sama.');
      }

      const totalApplied = deposit.customerDepositApplications.reduce(
        (sum, app) => sum.plus(new Decimal(app.appliedAmount.toString())),
        new Decimal(0)
      );
      const depositRemaining = new Decimal(deposit.amount.toString()).minus(totalApplied);
      const invoiceOutstanding = new Decimal(invoice.outstanding.toString());
      const applyAmount = new Decimal(body.amount);

      if (applyAmount.gt(depositRemaining)) {
        throw new BusinessError(`Sisa deposit hanya Rp ${depositRemaining.toFixed(2)}. Tidak cukup.`);
      }
      if (applyAmount.gt(invoiceOutstanding)) {
        throw new BusinessError(`Sisa outstanding invoice hanya Rp ${invoiceOutstanding.toFixed(2)}.`);
      }

      const parsedDate = new Date();
      const fiscalYear = await getOpenFiscalYear(tx, parsedDate);

      const arAccount = await systemAccounts.getAccount('AR');
      const depositAccount = await systemAccounts.getAccount('CUSTOMER_DEPOSIT');

      const applyAmountNum = applyAmount.toNumber();

      // Create journal: DR Uang Muka Pelanggan / CR Piutang Usaha
      const jvNumber = await generateDocumentNumber(tx, 'JV', parsedDate, fiscalYear.id);
      const journalEntry = await tx.journalEntry.create({
        data: {
          entryNumber: jvNumber,
          date: parsedDate,
          narration: `Aplikasi Uang Muka Pelanggan: ${deposit.paymentNumber} → ${invoice.invoiceNumber}`,
          status: 'Submitted',
          fiscalYearId: fiscalYear.id,
          createdBy: req.user!.userId,
          submittedAt: new Date(),
          items: {
            create: [
              { accountId: depositAccount.id, partyId: invoice.partyId, debit: applyAmountNum, credit: 0, description: `Aplikasi UM Pelanggan: ${deposit.paymentNumber}` },
              { accountId: arAccount.id, partyId: invoice.partyId, debit: 0, credit: applyAmountNum, description: `Aplikasi UM Pelanggan: ${deposit.paymentNumber}` },
            ],
          },
        },
      });

      await tx.accountingLedgerEntry.createMany({
        data: [
          { date: parsedDate, accountId: depositAccount.id, partyId: invoice.partyId, debit: applyAmountNum, credit: 0, referenceType: 'JournalEntry', referenceId: journalEntry.id, description: `Aplikasi UM Pelanggan: ${deposit.paymentNumber}`, fiscalYearId: fiscalYear.id },
          { date: parsedDate, accountId: arAccount.id, partyId: invoice.partyId, debit: 0, credit: applyAmountNum, referenceType: 'JournalEntry', referenceId: journalEntry.id, description: `Aplikasi UM Pelanggan: ${deposit.paymentNumber}`, fiscalYearId: fiscalYear.id },
        ],
      });

      await updateAccountBalance(tx, depositAccount.id, applyAmountNum, 0);  // DR liability (reduce)
      await updateAccountBalance(tx, arAccount.id, 0, applyAmountNum);       // CR AR (reduce)

      // Update invoice outstanding
      await setSalesInvoiceOutstandingInTx(tx, invoice.id, { delta: applyAmount.neg() });

      // Update party balances
      await tx.party.update({
        where: { id: invoice.partyId },
        data: { customerDepositBalance: { decrement: applyAmountNum } },
      });
      await recalcPartyOutstanding(tx, invoice.partyId);

      // Create application record
      const application = await tx.customerDepositApplication.create({
        data: {
          depositPaymentId: deposit.id,
          salesInvoiceId: invoice.id,
          appliedAmount: applyAmountNum,
          journalEntryId: journalEntry.id,
          createdBy: req.user!.userId,
        },
      });

      return application;
    }, { timeout: 15000 });

    return res.status(201).json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /customer-deposits/apply', 'Gagal mengaplikasikan uang muka customer.');
  }
});

// POST /api/customer-deposits/apply/:id/cancel — cancel deposit application
router.post('/apply/:id/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const body = validateBody(CancelReasonSchema, req.body ?? {}, res);
  if (!body) return;
  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const applicationId = req.params.id as string;
      // Row lock: a second concurrent cancel waits here, then sees isCancelled.
      await tx.$queryRaw`SELECT id FROM customer_deposit_applications WHERE id = ${applicationId} FOR UPDATE`;
      const application = await tx.customerDepositApplication.findUnique({
        where: { id: applicationId },
        include: {
          depositPayment: true,
          salesInvoice: { include: { customer: true } },
          journalEntry: { include: { items: true } },
        },
      });
      if (!application) throw new BusinessError('Aplikasi uang muka tidak ditemukan.');
      if (application.isCancelled) throw new BusinessError('Aplikasi sudah dibatalkan.');
      await claimCancel(tx.customerDepositApplication, application.id, { isCancelled: true, cancelledAt: new Date() });

      const applyAmount = new Decimal(application.appliedAmount.toString());
      const applyAmountNum = applyAmount.toNumber();

      // Void the application journal; rejected when its fiscal year (the apply date's) is closed,
      // or when it was already cancelled (the old Journal menu already reversed the deposit balance).
      // Legacy applications without a journal are checked against the apply date's year.
      if (application.journalEntry) {
        await voidDepositApplicationJournalInTx(tx, application.journalEntry, cancelTrail(req.user!.userId, body.reason));
      } else {
        await assertPeriodOpen(tx, { date: application.appliedAt }, 'uang muka');
      }

      // Restore invoice outstanding (read again under its row lock, not from the include above)
      const invoice = application.salesInvoice;
      await setSalesInvoiceOutstandingInTx(tx, invoice.id, { delta: applyAmount });

      // Restore party balances
      await tx.party.update({
        where: { id: invoice.partyId },
        data: { customerDepositBalance: { increment: applyAmountNum } },
      });
      await recalcPartyOutstanding(tx, invoice.partyId);

      return { id: application.id, status: 'Cancelled' };
    }, { timeout: 15000 });

    return res.json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /customer-deposits/apply/:id/cancel', 'Gagal membatalkan aplikasi uang muka customer.');
  }
});

// POST /api/customer-deposits/:id/refund — selesaikan sisa uang muka via
// offset piutang (FIFO ke faktur terlama) dan/atau refund kas ke bank.
router.post('/:id/refund', async (req: AuthRequest, res) => {
  const body = validateBody(RefundCustomerDepositSchema, req.body, res);
  if (!body) return;

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const depositId = req.params.id as string;
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${depositId} FOR UPDATE`;

      const deposit = await tx.payment.findUnique({
        where: { id: depositId },
        include: {
          party: true,
          customerDepositApplications: { where: { isCancelled: false } },
        },
      });
      if (!deposit) throw new BusinessError('Uang muka tidak ditemukan.');
      if (deposit.paymentType !== 'CustomerDeposit') throw new BusinessError('Bukan tipe uang muka customer.');
      if (deposit.status !== 'Submitted') throw new BusinessError('Uang muka sudah dibatalkan.');

      const totalApplied = deposit.customerDepositApplications.reduce(
        (sum, app) => sum.plus(new Decimal(app.appliedAmount.toString())),
        new Decimal(0),
      );
      const alreadyRefunded = new Decimal(deposit.refundedAmount.toString());
      const remaining = new Decimal(deposit.amount.toString()).minus(totalApplied).minus(alreadyRefunded);

      const offsetReq = new Decimal(body.offsetAmount);
      const cashReq = new Decimal(body.cashAmount);
      const totalReq = offsetReq.plus(cashReq);
      if (totalReq.gt(remaining.plus(new Decimal('0.01')))) {
        throw new BusinessError(`Total ${totalReq.toFixed(2)} melebihi sisa uang muka ${remaining.toFixed(2)}.`);
      }

      const parsedDate = new Date(body.date);
      if (isNaN(parsedDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
      const fiscalYear = await getOpenFiscalYear(tx, parsedDate);

      const depositAccount = await systemAccounts.getAccount('CUSTOMER_DEPOSIT');
      const arAccount = await systemAccounts.getAccount('AR');

      const createdApplications: string[] = [];
      let cashJournalId: string | null = null;

      // Offset against receivables (FIFO, oldest first).
      if (offsetReq.gt(0)) {
        await tx.$queryRaw`SELECT id FROM sales_invoices WHERE party_id = ${deposit.partyId} AND status IN ('Submitted','PartiallyPaid','Overdue') FOR UPDATE`;

        const invoices = await tx.salesInvoice.findMany({
          where: {
            partyId: deposit.partyId,
            status: { in: ['Submitted', 'PartiallyPaid', 'Overdue'] },
          },
          orderBy: { date: 'asc' },
        });

        let remainingOffset = offsetReq;
        for (const inv of invoices) {
          if (remainingOffset.lte(0)) break;
          const invOut = new Decimal(inv.outstanding.toString());
          if (invOut.lte(0)) continue;
          const apply = Decimal.min(invOut, remainingOffset);
          const applyNum = apply.toNumber();

          const jvNumber = await generateDocumentNumber(tx, 'JV', parsedDate, fiscalYear.id);
          const je = await tx.journalEntry.create({
            data: {
              entryNumber: jvNumber,
              date: parsedDate,
              narration: `Offset UM Pelanggan: ${deposit.paymentNumber} → ${inv.invoiceNumber}`,
              status: 'Submitted',
              fiscalYearId: fiscalYear.id,
              createdBy: req.user!.userId,
              submittedAt: new Date(),
              sourceType: 'DEPOSIT_OFFSET',
              items: {
                create: [
                  { accountId: depositAccount.id, partyId: deposit.partyId, debit: applyNum, credit: 0, description: `Offset UM Pelanggan: ${deposit.paymentNumber}` },
                  { accountId: arAccount.id, partyId: deposit.partyId, debit: 0, credit: applyNum, description: `Offset piutang: ${inv.invoiceNumber}` },
                ],
              },
            },
          });

          await tx.accountingLedgerEntry.createMany({
            data: [
              { date: parsedDate, accountId: depositAccount.id, partyId: deposit.partyId, debit: applyNum, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, description: `Offset UM Pelanggan: ${deposit.paymentNumber}`, fiscalYearId: fiscalYear.id },
              { date: parsedDate, accountId: arAccount.id, partyId: deposit.partyId, debit: 0, credit: applyNum, referenceType: 'JournalEntry', referenceId: je.id, description: `Offset piutang: ${inv.invoiceNumber}`, fiscalYearId: fiscalYear.id },
            ],
          });

          await updateAccountBalance(tx, depositAccount.id, applyNum, 0);
          await updateAccountBalance(tx, arAccount.id, 0, applyNum);

          await setSalesInvoiceOutstandingInTx(tx, inv.id, { delta: apply.neg() });

          const app = await tx.customerDepositApplication.create({
            data: {
              depositPaymentId: deposit.id,
              salesInvoiceId: inv.id,
              appliedAmount: applyNum,
              journalEntryId: je.id,
              createdBy: req.user!.userId,
            },
          });
          createdApplications.push(app.id);

          await tx.party.update({
            where: { id: deposit.partyId },
            data: { customerDepositBalance: { decrement: applyNum } },
          });

          remainingOffset = remainingOffset.minus(apply);
        }

        if (remainingOffset.gt(new Decimal('0.01'))) {
          throw new BusinessError(
            `Piutang customer tidak cukup untuk offset. Sisa offset yang tidak teralokasi: Rp ${remainingOffset.toFixed(2)}.`,
          );
        }
        await recalcPartyOutstanding(tx, deposit.partyId);
      }

      if (cashReq.gt(0)) {
        const cashAccount = await tx.account.findUnique({ where: { id: body.cashAccountId! } });
        if (!cashAccount) throw new BusinessError('Akun kas/bank tidak ditemukan.');
        const isCash = await systemAccounts.isCashAccount(cashAccount.accountNumber);
        if (!isCash) throw new BusinessError('Akun yang dipilih bukan kas/bank.');

        const cashNum = cashReq.toNumber();
        const jvNumber = await generateDocumentNumber(tx, 'JV', parsedDate, fiscalYear.id);
        const je = await tx.journalEntry.create({
          data: {
            entryNumber: jvNumber,
            date: parsedDate,
            narration: `Refund UM Pelanggan: ${deposit.paymentNumber} - ${deposit.party.name}`,
            status: 'Submitted',
            fiscalYearId: fiscalYear.id,
            createdBy: req.user!.userId,
            submittedAt: new Date(),
            sourceType: 'DEPOSIT_REFUND',
            sourceKey: depositRefundSourceKey(deposit.id),
            items: {
              create: [
                { accountId: depositAccount.id, partyId: deposit.partyId, debit: cashNum, credit: 0, description: `Refund UM Pelanggan: ${deposit.paymentNumber}` },
                { accountId: cashAccount.id, debit: 0, credit: cashNum, description: `Refund UM Pelanggan: ${deposit.paymentNumber}` },
              ],
            },
          },
        });
        cashJournalId = je.id;

        await tx.accountingLedgerEntry.createMany({
          data: [
            { date: parsedDate, accountId: depositAccount.id, partyId: deposit.partyId, debit: cashNum, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, description: `Refund UM Pelanggan: ${deposit.paymentNumber}`, fiscalYearId: fiscalYear.id },
            { date: parsedDate, accountId: cashAccount.id, debit: 0, credit: cashNum, referenceType: 'JournalEntry', referenceId: je.id, description: `Refund UM Pelanggan: ${deposit.paymentNumber}`, fiscalYearId: fiscalYear.id },
          ],
        });

        await updateAccountBalance(tx, depositAccount.id, cashNum, 0);
        await updateAccountBalance(tx, cashAccount.id, 0, cashNum);

        await tx.party.update({
          where: { id: deposit.partyId },
          data: { customerDepositBalance: { decrement: cashNum } },
        });

        await tx.payment.update({
          where: { id: deposit.id },
          data: { refundedAmount: { increment: cashNum } },
        });
      }

      return {
        message: 'Uang muka diselesaikan.',
        offsetApplied: offsetReq.toNumber(),
        cashRefunded: cashReq.toNumber(),
        applications: createdApplications,
        cashJournalId,
      };
    }, { timeout: 20000 });

    return res.json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /customer-deposits/:id/refund', 'Gagal memproses refund/offset uang muka.');
  }
});

// GET /api/customer-deposits/:id/refunds — cash refunds of one deposit (refund journals), newest first.
router.get('/:id/refunds', async (req, res) => {
  try {
    const refunds = await listDepositRefunds(prisma, 'customer', req.params.id as string);
    if (!refunds) return res.status(404).json({ error: 'Uang muka tidak ditemukan.' });
    return res.json({ data: refunds });
  } catch (error) {
    logger.error({ error }, 'GET /customer-deposits/:id/refunds error');
    return res.status(500).json({ error: 'Gagal mengambil daftar refund uang muka.' });
  }
});

// POST /api/customer-deposits/:id/refunds/:journalId/cancel — cancel one refund (requires doc.cancel):
// voids its journal, lowers refundedAmount and restores the customer deposit balance.
router.post('/:id/refunds/:journalId/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const body = validateBody(CancelReasonSchema, req.body ?? {}, res);
  if (!body) return;
  try {
    const result = await prisma.$transaction(
      (tx: Prisma.TransactionClient) => cancelDepositRefundInTx(tx, {
        side: 'customer',
        depositId: req.params.id as string,
        journalEntryId: req.params.journalId as string,
        userId: req.user!.userId,
        reason: body.reason,
      }),
      { timeout: 15000 },
    );
    return res.json({ message: 'Refund uang muka dibatalkan.', ...result });
  } catch (error) {
    return handleRouteError(res, error, 'POST /customer-deposits/:id/refunds/:journalId/cancel', 'Gagal membatalkan refund uang muka.');
  }
});

export default router;
