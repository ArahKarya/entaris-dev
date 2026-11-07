import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { CreateFiscalYearSchema, ReopenFiscalYearSchema } from '../utils/schemas';
import { BusinessError, handleRouteError } from '../utils/errors';
import { assertYearEndNotLocked } from '../utils/periodGuard';
import { voidJournalInTx } from '../utils/journalCancel';
import { cancelTrail } from '../utils/cancelClaim';
import { systemAccounts } from '../services/systemAccounts';
import { DOCUMENT_RULE } from '../services/ledger/accountGuard';
import { sourceKeys } from '../services/ledger/journalSource';
import { closeJournalPredicate } from '../services/ledger/closeJournals';
import { postJournal } from '../services/ledger/postJournal';
import { CloseChecklistFailedError, assertCloseChecklistPasses, runCloseChecklist } from '../services/fiscalYearClose';
import { ACCOUNT_MAPPING_MISSING, SYSTEM_ACCOUNT_ROLES, type SystemAccountRole } from '../types/systemAccounts';
import { logger } from '../lib/logger';

type Tx = Prisma.TransactionClient;

/** CURRENT_PROFIT or RETAINED_EARNINGS, which the year close posts to, is not mapped (defined with the roles). */
export { ACCOUNT_MAPPING_MISSING };
/** Error code: a reopen while a later fiscal year is still closed. */
export const FY_LATER_CLOSED = 'FY_LATER_CLOSED';

const router = Router();

/** First account mapped to `role`; a missing mapping is a 400 with its code, not a 500. */
async function mappedAccountId(role: SystemAccountRole): Promise<string> {
  const [account] = await systemAccounts.getAccounts(role);
  if (!account) {
    throw new BusinessError(
      `Akun sistem untuk "${SYSTEM_ACCOUNT_ROLES[role].label}" belum dikonfigurasi. Silakan atur di Pengaturan > Akun Sistem.`,
      ACCOUNT_MAPPING_MISSING,
    );
  }
  return account.id;
}

interface CloseJournalInput {
  year: { id: string; name: string; endDate: Date };
  /** Revenue minus expense of the year; not zero. */
  profit: Prisma.Decimal;
  currentProfitAccountId: string;
  retainedEarningsAccountId: string;
  userId: string;
}

/**
 * Posts the CLOSE journal on the year's last day through postJournal: a profit is DR current profit /
 * CR retained earnings, a loss the other way round. The first close is CLOSE-<name>; after n earlier
 * CLOSE journals of the year (each cancelled by a reopen) it is CLOSE-<name>-R<n+1>. The caller holds
 * the year row FOR UPDATE, so the count cannot race. The lines are fixed by code (DOCUMENT_RULE, no
 * party); the year must be the one of the year's last day; the monthly lock date is skipped (the
 * close locks the year itself, and a reopen needs the lock moved back first).
 */
async function postCloseJournalInTx(tx: Tx, input: CloseJournalInput): Promise<{ id: string; entryNumber: string }> {
  const { year, profit, userId } = input;
  const earlier = await tx.journalEntry.count({ where: closeJournalPredicate(year) });
  const entryNumber = earlier === 0 ? `CLOSE-${year.name}` : `CLOSE-${year.name}-R${earlier + 1}`;
  const zero = new Prisma.Decimal(0);
  const amount = profit.abs();
  // Current profit is debited by a profit and credited by a loss; retained earnings the opposite.
  const currentProfit = { debit: profit.isPositive() ? amount : zero, credit: profit.isNegative() ? amount : zero };
  const retained = { debit: currentProfit.credit, credit: currentProfit.debit };

  const { journal } = await postJournal(tx, {
    entryNumber,
    date: year.endDate,
    narration: `Tutup Buku Tahun ${year.name}`,
    lines: [
      { accountId: input.currentProfitAccountId, ...currentProfit, description: `Tutup akun laba tahun berjalan ${year.name}` },
      { accountId: input.retainedEarningsAccountId, ...retained, description: `Transfer ke laba ditahan ${year.name}` },
    ],
    sourceType: 'FY_CLOSE',
    sourceKey: sourceKeys.close(year.id),
    createdBy: userId,
    accountRule: DOCUMENT_RULE,
    partyRule: 'off',
    periodOptions: { ignoreLock: true },
    expectFiscalYearId: year.id,
  });
  return { id: journal.id, entryNumber };
}

/**
 * A reopen finds no active CLOSE journal: right for a year closed at zero profit, but a year whose
 * last close recorded a profit lost its CLOSE some other way (deleted before reopen kept it). Logged
 * for the accountant, not refused.
 */
async function warnIfCloseJournalMissing(tx: Tx, year: { id: string; name: string }): Promise<void> {
  const lastClose = await tx.fiscalYearEvent.findFirst({
    where: { fiscalYearId: year.id, action: 'close' },
    orderBy: { createdAt: 'desc' },
    select: { profit: true },
  });
  if (lastClose?.profit && !lastClose.profit.isZero()) {
    logger.warn(
      { fiscalYearId: year.id, fiscalYear: year.name, profit: lastClose.profit.toString() },
      'Reopen: no active CLOSE journal although the last close recorded a profit',
    );
  }
}

// GET /api/fiscal-years
router.get('/', async (req, res) => {
  try {
    const years = await prisma.fiscalYear.findMany({ orderBy: { startDate: 'desc' } });
    return res.json(years);
  } catch (error) {
    logger.error({ error }, 'GET /fiscal-years error');
    return res.status(500).json({ error: 'Gagal mengambil data tahun fiskal.' });
  }
});

// GET /api/fiscal-years/:id/close-checklist: what blocks or warns before closing the year (preview;
// the close runs the same checks again inside its transaction). The mount opens GET to every user,
// and the checklist names documents, so it needs doc.cancel like the close itself.
router.get('/:id/close-checklist', requireCap('doc.cancel'), async (req, res) => {
  const id = req.params.id as string;
  try {
    const checklist = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const year = await tx.fiscalYear.findUnique({ where: { id } });
      if (!year) throw new BusinessError('Tahun buku tidak ditemukan.');
      return runCloseChecklist(tx, year);
    }, { timeout: 30000 });
    return res.json(checklist);
  } catch (error) {
    return handleRouteError(res, error, 'GET /fiscal-years/:id/close-checklist', 'Gagal memuat daftar cek tutup buku.');
  }
});

// POST /api/fiscal-years (requires settings edit permission)
router.post('/', async (req, res) => {
  const body = validateBody(CreateFiscalYearSchema, req.body, res);
  if (!body) return;

  const start = new Date(body.startDate);
  const end = new Date(body.endDate);

  if (start >= end) {
    return res.status(400).json({ error: 'Tanggal mulai harus sebelum tanggal akhir.' });
  }

  try {
    const overlapping = await prisma.fiscalYear.findFirst({
      where: { OR: [{ startDate: { lte: end }, endDate: { gte: start } }] },
    });

    if (overlapping) {
      return res.status(409).json({
        error: `Tahun fiskal bertumpang tindih dengan "${overlapping.name}". Periksa rentang tanggal.`,
      });
    }

    const year = await prisma.fiscalYear.create({
      data: { name: body.name, startDate: start, endDate: end, isClosed: false },
    });
    return res.status(201).json(year);
  } catch (error: any) {
    logger.error({ error }, 'POST /fiscal-years error');
    if (error.code === 'P2002') return res.status(409).json({ error: 'Nama tahun fiskal sudah digunakan.' });
    return res.status(500).json({ error: 'Gagal membuat tahun fiskal.' });
  }
});

// POST /api/fiscal-years/:id/close: requires settings edit permission and the doc.cancel capability.
// Refused with CLOSE_CHECKLIST_FAILED (and the checklist) while a blocking check fails.
// An account's stored balance is the sum of its active ledger rows over every year
// (services/ledger/storedBalances.ts); the close does not change it. The year's profit moves to
// retained earnings through the CLOSE journal only, and the profit and loss accounts keep their rows.
router.post('/:id/close', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const userId = req.user!.userId;

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Waits for postings and cancels that passed assertPeriodOpen (FOR SHARE; new postings reach it
      // through getOpenFiscalYear) to commit, and makes later ones wait for this close, so the sums
      // below see every committed change.
      await tx.$queryRaw`SELECT id FROM fiscal_years WHERE id = ${id} FOR UPDATE`;
      const year = await tx.fiscalYear.findUnique({ where: { id } });
      if (!year) throw new BusinessError('Tahun buku tidak ditemukan.');
      if (year.isClosed) throw new BusinessError('Tahun buku sudah ditutup.');

      const retainedEarningsAccountId = await mappedAccountId('RETAINED_EARNINGS');
      const currentProfitAccountId = await mappedAccountId('CURRENT_PROFIT');
      // After FOR UPDATE, so nothing the checklist counts can change before this close commits.
      await assertCloseChecklistPasses(tx, year);

      const [revAgg, expAgg] = await Promise.all([
        tx.accountingLedgerEntry.aggregate({
          where: { fiscalYearId: id, isCancelled: false, account: { rootType: 'REVENUE' as any } },
          _sum: { debit: true, credit: true },
        }),
        tx.accountingLedgerEntry.aggregate({
          where: { fiscalYearId: id, isCancelled: false, account: { rootType: 'EXPENSE' as any } },
          _sum: { debit: true, credit: true },
        }),
      ]);

      // Decimal sums, so 0.3 - 0.1 - 0.2 is exactly zero and posts no CLOSE.
      const sum = (v: Prisma.Decimal | null | undefined) => v ?? new Prisma.Decimal(0);
      const netRevenue = sum(revAgg._sum?.credit).minus(sum(revAgg._sum?.debit));
      const netExpense = sum(expAgg._sum?.debit).minus(sum(expAgg._sum?.credit));
      const profit = netRevenue.minus(netExpense);

      const closeJournal = profit.isZero()
        ? null
        : await postCloseJournalInTx(tx, { year, profit, currentProfitAccountId, retainedEarningsAccountId, userId });

      await tx.fiscalYearEvent.create({
        data: { fiscalYearId: id, action: 'close', userId, closeJournalId: closeJournal?.id ?? null, profit },
      });

      return tx.fiscalYear.update({
        where: { id },
        data: { isClosed: true, closedAt: new Date(), closedBy: userId },
      });
    }, { timeout: 30000 }); // heavy transaction: 30s timeout

    return res.json(result);
  } catch (error: any) {
    if (error instanceof CloseChecklistFailedError) {
      return res.status(400).json({ error: error.message, code: error.code, checklist: error.checklist });
    }
    return handleRouteError(res, error, 'POST /fiscal-years/:id/close', 'Gagal menutup tahun buku.');
  }
});

// POST /api/fiscal-years/:id/reopen: requires settings edit permission and the doc.cancel capability.
// Body { reason } (5..500). Cancels the active CLOSE journal (kept, status Cancelled, with the reason)
// instead of deleting it, and refuses while a later year is closed or the lock date covers the year end.
// Stored account balances do not change (see POST /:id/close).
router.post('/:id/reopen', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const fyId = req.params.id as string;
  const body = validateBody(ReopenFiscalYearSchema, req.body ?? {}, res);
  if (!body) return;
  const userId = req.user!.userId;

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Same row lock as the close; see POST /:id/close.
      await tx.$queryRaw`SELECT id FROM fiscal_years WHERE id = ${fyId} FOR UPDATE`;
      const year = await tx.fiscalYear.findUnique({ where: { id: fyId } });
      if (!year) throw new BusinessError('Tahun buku tidak ditemukan.');
      if (!year.isClosed) throw new BusinessError('Tahun buku belum ditutup.');

      // Share-locks every later year, so a close of one of them waits for this reopen (or this
      // reopen waits for it and then sees it closed): an open year never sits before a closed one.
      const later = await tx.$queryRaw<{ name: string; is_closed: boolean }[]>`
        SELECT name, is_closed FROM fiscal_years WHERE start_date > ${year.endDate} ORDER BY start_date FOR SHARE`;
      const laterClosed = later.find((y) => y.is_closed);
      if (laterClosed) {
        throw new BusinessError(
          `Tahun buku ${laterClosed.name} sesudahnya sudah ditutup. Buka kembali ${laterClosed.name} dulu, lalu buka tahun buku ${year.name}.`,
          FY_LATER_CLOSED,
        );
      }
      await assertYearEndNotLocked(tx, year);

      // Open the year first: voidJournalInTx checks the journal's own year (PERIOD_CLOSED otherwise).
      const reopened = await tx.fiscalYear.update({
        where: { id: fyId },
        data: { isClosed: false, closedAt: null, closedBy: null },
      });

      // The active CLOSE journal(s); ones cancelled by earlier reopens stay as they are.
      const closeJournals = await tx.journalEntry.findMany({
        where: { ...closeJournalPredicate(year), status: 'Submitted' },
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      });
      const trail = cancelTrail(userId, body.reason);
      for (const journal of closeJournals) {
        await voidJournalInTx(tx, journal, 'jurnal', trail);
      }

      if (closeJournals.length === 0) await warnIfCloseJournalMissing(tx, year);

      await tx.fiscalYearEvent.create({
        data: { fiscalYearId: fyId, action: 'reopen', userId, reason: trail.cancelReason, closeJournalId: closeJournals[0]?.id ?? null },
      });

      return reopened;
    }, { timeout: 30000 });

    return res.json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /fiscal-years/:id/reopen', 'Gagal membuka kembali tahun buku.');
  }
});

export default router;
