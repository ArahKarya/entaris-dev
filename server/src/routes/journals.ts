import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { recalcPartyOutstanding, updateBalancesForItems } from '../utils/accountBalance';
import { reverseManualDepositLines } from '../utils/partyBalance';
import { hasCap } from '../services/permissionService';
import { createManualJournalInTx } from '../services/manualJournal';
import { loadControlAccountMap, manualCancelRule, restrictedKindProblem } from '../services/ledger/accountGuard';
import { validateBody } from '../utils/validate';
import { CancelReasonSchema, CreateJournalSchema } from '../utils/schemas';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { BusinessError, handleRouteError } from '../utils/errors';
import {
  JOURNAL_NOT_MANUAL,
  JOURNAL_NOT_MANUAL_MESSAGE,
  journalMenuCancelBlockReason,
} from '../services/journalCancelGuard';
import { isMenuCancellableSource } from '../services/ledger/journalSource';
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

/**
 * The journal that reverses this one (reversedById; today only legacy STT cancels paired by
 * scripts/repair/e1-stt-cancel-model.ts): such an original stays Submitted and nets to zero with it.
 */
const REVERSED_BY = { select: { id: true, entryNumber: true } } as const;

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
          reversedBy: REVERSED_BY,
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

// POST /api/journals — create a manual journal (MANUAL) through postJournal: one line validator
// (Decimal, exact balance), detail active accounts, control/tax accounts only with journal.control,
// never a deposit account, a party exactly on receivable/payable lines; outstanding recalculated.
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateJournalSchema, req.body, res);
  if (!body) return;

  try {
    const canControl = await hasCap(req.user!.role, 'journal.control');
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const { journal } = await createManualJournalInTx(tx, body, {
        userId: req.user!.userId,
        sourceType: 'MANUAL',
        canControl,
      });
      return tx.journalEntry.findUniqueOrThrow({
        where: { id: journal.id },
        include: {
          items: {
            include: { account: { select: { accountNumber: true, name: true, rootType: true } } },
          },
        },
      });
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
        reversedBy: REVERSED_BY,
      },
    });
    if (!entry) return res.status(404).json({ error: 'Jurnal tidak ditemukan.' });
    return res.json(entry);
  } catch (error) {
    logger.error({ error }, 'GET /journals/:id error');
    return res.status(500).json({ error: 'Gagal mengambil data jurnal.' });
  }
});

/** Throws ACCOUNT_CONTROL when the canceller may not reverse one of the journal's accounts. */
async function assertMayReverseLines(
  tx: Prisma.TransactionClient,
  items: { accountId: string; account: { accountNumber: string; name: string } }[],
  canControl: boolean,
): Promise<void> {
  const rule = manualCancelRule(canControl);
  if (rule.allowControl === true) return;
  const control = await loadControlAccountMap(tx, rule.alsoRestrict);
  for (const item of items) {
    const problem = restrictedKindProblem(item.account, rule, control.get(item.accountId) ?? null);
    if (problem) throw new BusinessError(problem.message, problem.code);
  }
}

// PATCH /api/journals/:id/cancel — cancel a hand-made journal (MANUAL, IMPORT, RECURRING,
// CASH_BOOK) and reverse balances. Every other journal is undone from its source document.
router.patch('/:id/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const body = validateBody(CancelReasonSchema, req.body ?? {}, res);
  if (!body) return;

  try {
    const canControl = await hasCap(req.user!.role, 'journal.control');
    const found = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Read inside the transaction: the claim below decides between two concurrent cancels.
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        include: {
          items: {
            include: { account: { select: { accountNumber: true, name: true, rootType: true } } },
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
      await assertPeriodOpen(tx, { fiscalYearId: entry.fiscalYearId, date: entry.date }, 'jurnal');
      // Deposit refunds have their own cancel on the deposit page, which also lowers refundedAmount.
      if (isDepositRefundJournal(entry)) {
        throw new BusinessError(DEPOSIT_REFUND_MENU_MESSAGE, JOURNAL_USE_DEPOSIT_REFUND_CANCEL);
      }
      // Allowlist by source type; a NULL (unknown legacy) source is never cancellable here.
      if (!isMenuCancellableSource(entry.sourceType)) {
        throw new BusinessError(JOURNAL_NOT_MANUAL_MESSAGE, JOURNAL_NOT_MANUAL);
      }
      // Second layer: a hand-made source type linked to a module document still goes to that module.
      const blockReason = await journalMenuCancelBlockReason(tx, entry.id);
      if (blockReason) throw new BusinessError(blockReason, JOURNAL_NOT_MANUAL);

      // Reversing the lines moves the same balances as posting them, so control and tax accounts
      // need journal.control here too (owner decision #1); see manualCancelRule.
      await assertMayReverseLines(tx, entry.items, canControl);

      // Reverse account balances (swap debit↔credit to undo)
      await updateBalancesForItems(
        tx,
        entry.items.map((i) => ({
          accountId: i.accountId,
          debit: i.credit,
          credit: i.debit,
        })),
      );

      // Deposit lines of an old manual or imported journal (before E2-R4 refused deposit accounts)
      // moved the party's deposit balance at posting; undo that. Receivable and payable lines are
      // covered by the recalculation below, and the other sources never moved a party balance.
      if (entry.sourceType === 'MANUAL' || entry.sourceType === 'IMPORT') {
        await reverseManualDepositLines(
          tx,
          entry.items.map((i) => ({ partyId: i.partyId, accountId: i.accountId, debit: i.debit, credit: i.credit })),
        );
      }

      // Soft-cancel the original ALE rows, like the other cancel handlers. Adding [BATAL]
      // reversal rows instead would double ALE totals vs JournalItem and fail the health check.
      await tx.accountingLedgerEntry.updateMany({
        where: { referenceId: entry.id, isCancelled: false },
        data: { isCancelled: true },
      });

      // Outstanding of every party on the journal, recalculated from the documents and the manual
      // adjustments that remain (this journal's ledger rows are cancelled now), never decremented:
      // a journal posted under an older rule (a party on an expense line, a recurring or cash book
      // line that never moved the balance) cannot push it away from the recalculated value.
      const partyIds = [...new Set(entry.items.map((i) => i.partyId).filter((p): p is string => !!p))].sort();
      for (const partyId of partyIds) await recalcPartyOutstanding(tx, partyId);
      return true;
    }, { timeout: 15000 });

    if (!found) return res.status(404).json({ error: 'Jurnal tidak ditemukan.' });
    return res.json({ message: 'Jurnal dibatalkan.' });
  } catch (error: any) {
    return handleRouteError(res, error, 'PATCH /journals/:id/cancel', 'Gagal membatalkan jurnal.');
  }
});

export default router;
