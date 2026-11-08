import { Router } from 'express';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { updateAccountBalance, recalcPartyOutstanding } from '../utils/accountBalance';
import { validateBody } from '../utils/validate';
import { CancelReasonSchema, CreatePaymentSchema } from '../utils/schemas';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { BusinessError, handleRouteError } from '../utils/errors';
import { assertPeriodOpen } from '../utils/periodGuard';
import { cancelJournalsInTx } from '../services/ledger/cancelJournals';
import { logger } from '../lib/logger';
import { systemAccounts } from '../services/systemAccounts';
import { submitPaymentInTx } from '../services/paymentSubmit';
import { setSalesInvoiceOutstandingInTx } from '../services/salesInvoiceStatus';
import { withAllocationInvoiceNumbers } from '../services/paymentAllocationDetail';
import { isOpeningAllocation, restorePartyOpening } from '../services/ledger/partyOpeningConsumption';
import { parseListPaging, parseSort } from '../utils/listQuery';
import {
  buildCashLedgerFilter,
  CASH_LEDGER_SORT_FIELDS,
  DEFAULT_CASH_LEDGER_SORT,
  listCashLedger,
  summarizeCashLedgerQuery,
} from '../services/paymentList';

const router = Router();

// GET /api/payments
router.get('/', async (req, res) => {
  try {
    const { page = '1', limit = '50' } = req.query;
    const take = Math.min(Number(limit) || 50, 200);
    const skip = (Number(page) - 1) * take;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        include: { party: true, splits: { include: { account: true } } },
        orderBy: { date: 'desc' },
        skip,
        take,
      }),
      prisma.payment.count(),
    ]);

    return res.json({ data: payments, total, page: Number(page), limit: take });
  } catch (error) {
    logger.error({ error }, 'GET /payments error');
    return res.status(500).json({ error: 'Gagal mengambil data pembayaran.' });
  }
});

// GET /api/payments/cash-journals — journal entries affecting cash/bank accounts (not already linked to payments)
router.get('/cash-journals', async (_req, res) => {
  try {
    // Find journal items that touch cash accounts (1.1.x) and aren't linked to payments
    const cashItems = await prisma.journalItem.findMany({
      where: {
        account: { accountNumber: { startsWith: '1.1' }, isGroup: false },
        journalEntry: {
          status: { not: 'Cancelled' },
          // Exclude journals linked to payments (they start with JV-PAY)
          entryNumber: { not: { startsWith: 'JV-PAY' } },
        },
      },
      include: {
        journalEntry: true,
        account: true,
      },
      orderBy: { journalEntry: { date: 'desc' } },
      take: 100,
    });

    // Resolve party names for items with partyId
    const partyIds = [...new Set(cashItems.map((i) => i.partyId).filter((id): id is string => id != null))];
    const parties = partyIds.length > 0
      ? await prisma.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } })
      : [];
    const partyMap = new Map(parties.map((p) => [p.id, p.name]));

    const data = cashItems.map((item) => ({
      id: item.id,
      journalEntryId: item.journalEntryId,
      date: item.journalEntry.date,
      entryNumber: item.journalEntry.entryNumber,
      narration: item.journalEntry.narration,
      partyName: item.partyId ? partyMap.get(item.partyId) ?? null : null,
      amount: Number(item.credit) > 0 ? Number(item.credit) : Number(item.debit),
      isCredit: Number(item.credit) > 0,
      status: item.journalEntry.status,
    }));

    return res.json({ data });
  } catch (error) {
    logger.error({ error }, 'GET /payments/cash-journals error');
    return res.status(500).json({ error: 'Gagal mengambil data jurnal kas.' });
  }
});

// GET /api/payments/ledger — "Transaksi Kas & Bank" list: payments and
// cash-affecting journal lines as one server-paginated list (see
// services/paymentList). Query: page, limit (≤500), search, type, direction,
// status, partyId, accountId, startDate, endDate (YYYY-MM-DD),
// sort (date | number | party | amount, "-" = descending).
// → { data, total, page, limit }. GET / and /cash-journals stay unchanged.
router.get('/ledger', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const { page, limit: take, skip } = parseListPaging(query, { defaultLimit: 25, maxLimit: 500 });
    const parsed = buildCashLedgerFilter(query);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const sort = parseSort(query.sort, CASH_LEDGER_SORT_FIELDS, DEFAULT_CASH_LEDGER_SORT);
    const { rows, total } = await listCashLedger(prisma, parsed.filter, sort, { skip, take });
    return res.json({ data: rows, total, page, limit: take });
  } catch (error) {
    logger.error({ error }, 'GET /payments/ledger error');
    return res.status(500).json({ error: 'Gagal mengambil data transaksi kas & bank.' });
  }
});

// GET /api/payments/ledger/summary — KPI totals (count, money in/out, net) for
// the same filters as /ledger. Declared before /:id.
router.get('/ledger/summary', async (req, res) => {
  try {
    const parsed = buildCashLedgerFilter(req.query as Record<string, unknown>);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    return res.json(await summarizeCashLedgerQuery(prisma, parsed.filter));
  } catch (error) {
    logger.error({ error }, 'GET /payments/ledger/summary error');
    return res.status(500).json({ error: 'Gagal menghitung ringkasan transaksi kas & bank.' });
  }
});

// GET /api/payments/:id — payment detail
router.get('/:id', async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id as string },
      include: {
        party: true,
        account: true,
        splits: { include: { account: true } },
        allocations: true,
        journalEntry: {
          include: { items: { include: { account: true } } },
        },
      },
    });
    if (!payment) return res.status(404).json({ error: 'Pembayaran tidak ditemukan.' });
    const allocations = await withAllocationInvoiceNumbers(prisma, payment.allocations);
    return res.json({ ...payment, allocations });
  } catch (error) {
    logger.error({ error }, 'GET /payments/:id error');
    return res.status(500).json({ error: 'Gagal mengambil detail pembayaran.' });
  }
});

// POST /api/payments — record payment/receipt
// POST /api/payments — record payment/receipt. All 6 paymentType branches
// + auto-allocate live in services/paymentSubmit.ts.
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreatePaymentSchema, req.body, res);
  if (!body) return;

  try {
    const { payment, party, unallocatedAmount } = await prisma.$transaction(
      (tx) => submitPaymentInTx(tx, body, req.user!.userId),
      { timeout: 15000 },
    );
    return res.status(201).json({ ...payment, party, unallocatedAmount });
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /payments', 'Gagal menyimpan pembayaran.');
  }
});

// POST /api/payments/:id/cancel — cancel payment and reverse allocations (invoices and the party opening)
router.post('/:id/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const body = validateBody(CancelReasonSchema, req.body ?? {}, res);
  if (!body) return;
  const trail = cancelTrail(req.user!.userId, body.reason);
  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const payment = await tx.payment.findUnique({
        where: { id: req.params.id as string },
        include: { party: true },
      });
      if (!payment) throw new BusinessError('Pembayaran tidak ditemukan.');
      if (payment.status === 'Cancelled') throw new BusinessError('Pembayaran sudah dibatalkan.');
      // First write: a concurrent second cancel gets STALE_STATUS instead of reopening the invoices
      // and reversing the balances again. The rejections below roll the claim back.
      await claimCancel(tx.payment, payment.id, { status: 'Cancelled', cancelledAt: new Date(), ...trail });
      await assertPeriodOpen(tx, { fiscalYearId: payment.fiscalYearId, date: payment.date }, 'pembayaran');

      // Deposits must be cancelled via their own endpoints (vendor-deposits / customer-deposits
      // PATCH /:id/cancel); cancelling here too causes a double cancel and GL drift.
      if (payment.paymentType === 'VendorDeposit') {
        throw new BusinessError('Gunakan endpoint Uang Muka Supplier untuk membatalkan deposit.');
      }
      if (payment.paymentType === 'CustomerDeposit') {
        throw new BusinessError('Gunakan endpoint Uang Muka Customer untuk membatalkan deposit.');
      }
      if (payment.paymentType === 'VendorRefund' || payment.paymentType === 'CustomerRefund') {
        throw new BusinessError(
          'Refund belum mendukung cancel otomatis. Buat jurnal koreksi manual untuk membatalkan refund ini.',
        );
      }

      // Receive / Pay cancel branch
      // Reverse payment allocations
      const allocations = await tx.paymentAllocation.findMany({
        where: { paymentId: payment.id },
      });

      for (const alloc of allocations) {
        const allocAmt = new Decimal(alloc.allocatedAmount.toString());
        if (alloc.invoiceType === 'SalesInvoice') {
          await setSalesInvoiceOutstandingInTx(tx, alloc.invoiceId, { delta: allocAmt });
        } else if (alloc.invoiceType === 'PurchaseInvoice') {
          const inv = await tx.purchaseInvoice.findUnique({ where: { id: alloc.invoiceId } });
          if (inv) {
            const newOutstanding = new Decimal(inv.outstanding.toString()).plus(allocAmt);
            const newOutstandingNum = newOutstanding.toNumber();
            await tx.purchaseInvoice.update({
              where: { id: inv.id },
              data: { outstanding: newOutstandingNum, status: newOutstanding.gte(new Decimal(inv.grandTotal.toString())) ? 'Submitted' : 'PartiallyPaid' },
            });
          }
        } else if (isOpeningAllocation(alloc.invoiceType)) {
          // What the payment took from the party's opening goes back into the same bucket (PR-5.13).
          await restorePartyOpening(tx, payment.partyId, alloc.invoiceType, allocAmt.toFixed(2));
        }
      }

      // Delete allocations
      await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });

      // Void the payment's journal: its ledger entries are cancelled and account balances reversed
      // per journal line, so an AR/AP remap after posting cannot move the wrong account (P-11).
      const journal = await tx.journalEntry.findFirst({
        where: payment.journalEntryId ? { id: payment.journalEntryId } : { entryNumber: `JV-${payment.paymentNumber}` },
        include: { items: true },
      });
      if (journal) {
        const voided = await cancelJournalsInTx(tx, [journal], { label: 'pembayaran', trail });
        if (voided.length === 0) {
          logger.warn(
            { paymentId: payment.id, journalId: journal.id },
            'Payment cancel: journal was already cancelled, balances left as they are',
          );
        }
      } else {
        // Legacy payment posted without a journal: reverse from the nominal amount and the current
        // AR/AP mapping, as before. Rejecting it would leave the payment impossible to cancel.
        logger.warn({ paymentId: payment.id, paymentNumber: payment.paymentNumber }, 'Payment cancel: no journal, nominal reversal');
        await reverseNominalPaymentBalances(tx, payment);
      }

      // Recalc party outstanding from invoice data (source of truth)
      await recalcPartyOutstanding(tx, payment.partyId);

      return { id: payment.id, status: 'Cancelled' };
    }, { timeout: 15000 });

    return res.json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /payments/:id/cancel', 'Gagal membatalkan pembayaran.');
  }
});

/**
 * Balance reversal for a legacy payment that has no journal: the splits (or the payment account)
 * and the AR/AP account mapped today, for the nominal amount.
 */
async function reverseNominalPaymentBalances(
  tx: Prisma.TransactionClient,
  payment: { id: string; paymentType: string; accountId: string; amount: Prisma.Decimal },
): Promise<void> {
  const amount = new Decimal(payment.amount.toString()).toNumber();
  const paymentSplits = await tx.paymentSplit.findMany({ where: { paymentId: payment.id } });
  const reverseSplits = paymentSplits.length > 0
    ? paymentSplits.map((s) => ({ accountId: s.accountId, amount: Number(s.amount) }))
    : [{ accountId: payment.accountId, amount }];

  if (payment.paymentType === 'Receive') {
    // Original: each split DR; AR CR. Reverse: each split CR; AR DR.
    const arAccount = await systemAccounts.getAccount('AR');
    for (const sp of reverseSplits) {
      await updateAccountBalance(tx, sp.accountId, 0, sp.amount);
    }
    await updateAccountBalance(tx, arAccount.id, amount, 0);
  } else {
    // Original: each split CR; AP DR. Reverse: each split DR; AP CR.
    const apAccount = await systemAccounts.getAccount('AP');
    for (const sp of reverseSplits) {
      await updateAccountBalance(tx, sp.accountId, sp.amount, 0);
    }
    await updateAccountBalance(tx, apAccount.id, 0, amount);
  }
}

export default router;
