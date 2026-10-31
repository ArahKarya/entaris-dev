import { Router } from 'express';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { updateBalancesForItems } from '../utils/accountBalance';
import { applyPartyImpact } from '../utils/partyBalance';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { validateBody } from '../utils/validate';
import { CancelReasonSchema, CreateJournalSchema } from '../utils/schemas';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { BusinessError, handleRouteError } from '../utils/errors';
import { journalMenuCancelBlockReason } from '../services/journalCancelGuard';
import {
  DEPOSIT_REFUND_MENU_MESSAGE,
  isDepositRefundJournal,
  JOURNAL_USE_DEPOSIT_REFUND_CANCEL,
} from '../services/depositRefundCancel';
import { assertPeriodOpen } from '../utils/periodGuard';
import { logger } from '../lib/logger';
import { parseListPaging, parseSort } from '../utils/listQuery';
import {
  buildJournalWhere,
  DEFAULT_JOURNAL_SORT,
  JOURNAL_SORT_FIELDS,
  journalOrderBy,
} from '../services/journalList';

const router = Router();

// GET /api/journals — list journal entries (filters/sort: services/journalList.ts)
router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    // maxLimit 200: same cap as the original endpoint.
    const { page, limit: take, skip } = parseListPaging(query, { defaultLimit: 50, maxLimit: 200 });
    const filter = buildJournalWhere(query);
    if (!filter.ok) return res.status(400).json({ error: filter.error });
    const { where } = filter;
    const sort = parseSort(query.sort, JOURNAL_SORT_FIELDS, DEFAULT_JOURNAL_SORT);

    const [entries, total] = await Promise.all([
      prisma.journalEntry.findMany({
        where,
        include: {
          items: { include: { account: { select: { accountNumber: true, name: true } } } },
          user: { select: { fullName: true } },
        },
        orderBy: journalOrderBy(sort),
        skip,
        take,
      }),
      prisma.journalEntry.count({ where }),
    ]);

    return res.json({ data: entries, total, page, limit: take });
  } catch (error) {
    logger.error({ error }, 'GET /journals error');
    return res.status(500).json({ error: 'Gagal mengambil data jurnal.' });
  }
});

// POST /api/journals — create journal entry
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateJournalSchema, req.body, res);
  if (!body) return;

  // Validate: each line must have either debit OR credit, not both
  for (const item of body.items) {
    if ((item.debit || 0) > 0 && (item.credit || 0) > 0) {
      return res.status(400).json({
        error: 'Satu baris jurnal tidak boleh memiliki debit dan kredit sekaligus.',
      });
    }
  }

  const totalDebit = body.items.reduce((s, i) => s + (i.debit || 0), 0);
  const totalCredit = body.items.reduce((s, i) => s + (i.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return res.status(400).json({
      error: `Jurnal tidak seimbang. Total Debit (${totalDebit}) ≠ Total Kredit (${totalCredit}).`,
    });
  }

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const parsedDate = new Date(body.date);
      const fiscalYear = await getOpenFiscalYear(tx, parsedDate);
      const entryNumber = await generateDocumentNumber(tx, 'JV', parsedDate, fiscalYear.id);

      const journalEntry = await tx.journalEntry.create({
        data: {
          entryNumber,
          date: parsedDate,
          narration: body.narration,
          status: 'Submitted',
          fiscalYearId: fiscalYear.id,
          createdBy: req.user!.userId,
          submittedAt: new Date(),
          sourceType: 'MANUAL',
          items: {
            create: body.items.map((item) => ({
              accountId: item.accountId,
              partyId: item.partyId || null,
              debit: item.debit || 0,
              credit: item.credit || 0,
              description: item.description || body.narration,
            })),
          },
        },
        include: {
          items: {
            include: { account: { select: { accountNumber: true, rootType: true } } },
          },
        },
      });

      // Post to immutable ledger
      await tx.accountingLedgerEntry.createMany({
        data: journalEntry.items.map((item) => ({
          date: parsedDate,
          accountId: item.accountId,
          partyId: item.partyId,
          debit: item.debit,
          credit: item.credit,
          referenceType: 'JournalEntry',
          referenceId: journalEntry.id,
          description: item.description || body.narration,
          fiscalYearId: fiscalYear.id,
        })),
      });

      // Update account balances with correct direction
      await updateBalancesForItems(
        tx,
        journalEntry.items.map((i) => ({
          accountId: i.accountId,
          debit: i.debit,
          credit: i.credit,
        })),
      );

      // Update party denorm balances — account-aware so UM (2.1.2/1.3) lines
      // hit customerDepositBalance/depositBalance instead of outstandingAmount.
      await applyPartyImpact(
        tx,
        journalEntry.items.map((i) => ({
          partyId: i.partyId,
          debit: Number(i.debit),
          credit: Number(i.credit),
          accountNumber: i.account.accountNumber,
          rootType: i.account.rootType,
        })),
        'apply',
      );

      return journalEntry;
    }, { timeout: 15000 });

    return res.status(201).json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /journals', 'Gagal menyimpan jurnal.');
  }
});

// GET /api/journals/:id — get single journal entry
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      include: {
        items: { include: { account: { select: { id: true, accountNumber: true, name: true, rootType: true } } } },
        user: { select: { fullName: true } },
      },
    });
    if (!entry) return res.status(404).json({ error: 'Jurnal tidak ditemukan.' });
    return res.json(entry);
  } catch (error) {
    logger.error({ error }, 'GET /journals/:id error');
    return res.status(500).json({ error: 'Gagal mengambil data jurnal.' });
  }
});

// PATCH /api/journals/:id/cancel — cancel a journal entry and reverse balances
router.patch('/:id/cancel', async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const body = validateBody(CancelReasonSchema, req.body ?? {}, res);
  if (!body) return;

  try {
    const found = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Read inside the transaction: the claim below decides between two concurrent cancels.
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        include: {
          items: {
            include: { account: { select: { accountNumber: true, rootType: true } } },
          },
        },
      });
      if (!entry) return false;
      if (entry.status === 'Cancelled') throw new BusinessError('Jurnal sudah dibatalkan.');

      // Claim the journal first so a double click or a concurrent AIRA call cannot reverse it
      // twice: the loser gets STALE_STATUS before any balance moves.
      await claimCancel(tx.journalEntry, id, {
        status: 'Cancelled',
        cancelledAt: new Date(),
        ...cancelTrail(req.user!.userId, body.reason),
      });

      // Closed fiscal year first so the client gets the PERIOD_CLOSED code; then only hand-made
      // journals pass, module journals are undone from their module.
      await assertPeriodOpen(tx, { fiscalYearId: entry.fiscalYearId }, 'jurnal');
      // Deposit refunds have their own cancel on the deposit page, which also lowers refundedAmount.
      if (isDepositRefundJournal(entry)) {
        throw new BusinessError(DEPOSIT_REFUND_MENU_MESSAGE, JOURNAL_USE_DEPOSIT_REFUND_CANCEL);
      }
      const blockReason = await journalMenuCancelBlockReason(tx, entry.id);
      if (blockReason) throw new BusinessError(blockReason);

      // Reverse account balances (swap debit↔credit to undo)
      await updateBalancesForItems(
        tx,
        entry.items.map((i) => ({
          accountId: i.accountId,
          debit: i.credit,
          credit: i.debit,
        })),
      );

      // Reverse party denorm balances — symmetric with POST classification.
      await applyPartyImpact(
        tx,
        entry.items.map((i) => ({
          partyId: i.partyId,
          debit: Number(i.debit),
          credit: Number(i.credit),
          accountNumber: i.account.accountNumber,
          rootType: i.account.rootType,
        })),
        'reverse',
      );

      // Undo offset side-effects created by customerDeposits.ts.
      // Offset JVs: linked customer_deposit_applications → mark cancelled and
      // restore the sales invoice outstanding + status.
      const offsetApps = await tx.customerDepositApplication.findMany({
        where: { journalEntryId: entry.id, isCancelled: false },
      });
      for (const app of offsetApps) {
        await tx.customerDepositApplication.update({
          where: { id: app.id },
          data: { isCancelled: true, cancelledAt: new Date() },
        });
        const inv = await tx.salesInvoice.findUnique({ where: { id: app.salesInvoiceId } });
        if (inv) {
          const restored = new Decimal(inv.outstanding.toString())
            .plus(app.appliedAmount.toString());
          const grandTotal = new Decimal(inv.grandTotal.toString());
          const newStatus = restored.greaterThanOrEqualTo(grandTotal) ? 'Submitted' : 'PartiallyPaid';
          await tx.salesInvoice.update({
            where: { id: inv.id },
            data: { outstanding: restored, status: newStatus },
          });
        }
      }

      // Soft-cancel the original ALE rows, like the other cancel handlers. Adding [BATAL]
      // reversal rows instead would double ALE totals vs JournalItem and fail the health check.
      await tx.accountingLedgerEntry.updateMany({
        where: { referenceId: entry.id, isCancelled: false },
        data: { isCancelled: true },
      });
      return true;
    }, { timeout: 15000 });

    if (!found) return res.status(404).json({ error: 'Jurnal tidak ditemukan.' });
    return res.json({ message: 'Jurnal dibatalkan.' });
  } catch (error: any) {
    return handleRouteError(res, error, 'PATCH /journals/:id/cancel', 'Gagal membatalkan jurnal.');
  }
});

export default router;
