import { Router, Response } from 'express';
import path from 'path';
import type { FiscalYear, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AuthRequest, requireCap, requirePerm } from '../../middleware/auth';
import { logger } from '../../lib/logger';
import { recalculateAccountBalances } from '../../utils/accountBalance';
import { BusinessError, handleRouteError } from '../../utils/errors';
import { FISCAL_YEAR_MISSING, PERIOD_CLOSED, assertPeriodOpen, fiscalYearRange } from '../../utils/periodGuard';
import { SAFETY_BACKUP_FAILED, createBackup, invalidateRuntimeCaches } from '../../services/backupService';
import { canManageDemoData } from '../../services/demoData/guard';
import { resetTables } from '../../services/demoData/tables';
import { DUMMY_LEDGER_MARKERS, matchGenericDummyJournals, specificDummyNarrations } from '../../services/dummyJournalMatch';

const router = Router();

/** Date and booked fiscal year of a row the legacy delete removes. */
type DummyRow = { date: Date; fiscalYearId: string };

/**
 * Refuses (PERIOD_CLOSED) when any row the legacy delete removes lies in a closed fiscal year:
 * the year it is booked to, or the year its date falls in. The monthly lock is ignored, as it was
 * when the old generator wrote these rows. A date that no fiscal year covers cannot be in a closed
 * period, so it is skipped rather than refused (FISCAL_YEAR_MISSING).
 */
async function assertDummyPeriodsOpen(tx: Prisma.TransactionClient, rows: readonly DummyRow[]): Promise<void> {
  if (rows.length === 0) return;
  const years = await tx.fiscalYear.findMany({ orderBy: { startDate: 'asc' } });
  const ranges = years.map((fy) => ({ fy, range: fiscalYearRange(fy) }));
  const covering = (date: Date) => {
    // Like the period guard, the later year wins when two touch the same day.
    for (let i = ranges.length - 1; i >= 0; i--) {
      const { fy, range } = ranges[i];
      if (date >= range.gte && date < range.lt) return fy;
    }
    return null;
  };
  const toCheck = new Map<string, { fy: FiscalYear; date: Date }>();
  const add = (fy: FiscalYear | null | undefined, date: Date) => {
    if (fy && !toCheck.has(fy.id)) toCheck.set(fy.id, { fy, date });
  };
  const byId = new Map(years.map((fy) => [fy.id, fy]));
  for (const row of rows) {
    add(byId.get(row.fiscalYearId), row.date);
    add(covering(row.date), row.date);
  }
  const ordered = [...toCheck.values()].sort((a, b) => a.fy.startDate.getTime() - b.fy.startDate.getTime());
  for (const { fy, date } of ordered) {
    try {
      await assertPeriodOpen(tx, { date, fiscalYearId: fy.id }, 'dokumen', { ignoreLock: true });
    } catch (error) {
      if (error instanceof BusinessError && error.code === FISCAL_YEAR_MISSING) continue;
      if (error instanceof BusinessError && error.code === PERIOD_CLOSED) {
        throw new BusinessError(
          `Data dummy lama ada di tahun buku ${fy.name} yang sudah ditutup. Buka kembali tahun buku itu, lalu hapus data dummy lama lagi.`,
          PERIOD_CLOSED,
        );
      }
      throw error;
    }
  }
}

// POST /api/settings/delete-dummy: deletes what the old dummy generator (removed in E7-R13) left
// behind. Same gate as demo data: settings edit + approval.bypass. Refused with 409 while any of
// it lies in a closed fiscal year. Only the balances of accounts it touched are recalculated, and
// real parties' outstanding amounts are left alone.
router.post('/delete-dummy', requirePerm('settings'), async (req: AuthRequest, res: Response) => {
  if (!(await canManageDemoData(req.user!.role))) {
    return res.status(403).json({ error: 'Hanya pengguna yang boleh melewati persetujuan yang dapat mengelola data uji coba.' });
  }
  try {
    // Demo parties are flagged isDummy too; they must go through the exclusive demo wipe instead.
    if (await prisma.demoDataBatch.findFirst({ select: { id: true } })) {
      return res.status(409).json({ error: 'Gunakan Hapus data uji coba untuk menghapus data uji coba lintas modul.' });
    }
    const results = { parties: 0, salesInvoices: 0, purchaseInvoices: 0, payments: 0, journals: 0, inventoryItems: 0, movements: 0, productionRuns: 0 };

    await prisma.$transaction(async (tx) => {
      const dated = { id: true, date: true, fiscalYearId: true } as const;
      const [dummySI, dummyPI, dummyParties, dummyItems] = await Promise.all([
        tx.salesInvoice.findMany({ where: { isDummy: true }, select: { ...dated, invoiceNumber: true } }),
        tx.purchaseInvoice.findMany({ where: { isDummy: true }, select: dated }),
        tx.party.findMany({ where: { isDummy: true }, select: { id: true, name: true, partyType: true } }),
        tx.inventoryItem.findMany({ where: { isDummy: true }, select: { id: true } }),
      ]);
      const siIds = dummySI.map(s => s.id);
      const piIds = dummyPI.map(p => p.id);
      const partyIds = dummyParties.map(p => p.id);
      const itemIds = dummyItems.map(i => i.id);

      const dummyPayments = await tx.payment.findMany({
        where: { partyId: { in: partyIds } },
        select: { ...dated, journalEntryId: true },
      });
      const paymentIds = dummyPayments.map(p => p.id);
      const paymentJeIds = dummyPayments.map(p => p.journalEntryId).filter((id): id is string => id != null);

      // Dummy journals carry isDummy. Journals generated before that flag existed are
      // matched exactly (dummy names, dummy invoice numbers, or a dummy ledger marker).
      const exactNarrations = specificDummyNarrations({
        customerNames: dummyParties.filter((p) => p.partyType !== 'Supplier').map((p) => p.name),
        supplierNames: dummyParties.filter((p) => p.partyType !== 'Customer').map((p) => p.name),
        salesInvoiceNumbers: dummySI.map((r) => r.invoiceNumber),
      });
      const markerRows = await tx.accountingLedgerEntry.findMany({
        where: { referenceId: { in: [...DUMMY_LEDGER_MARKERS] } },
        select: { date: true, accountId: true, debit: true },
      });
      const genericCandidates = await tx.journalEntry.findMany({
        where: {
          isDummy: false,
          OR: [
            { narration: 'Setoran modal awal' },
            { narration: 'Pembayaran ke supplier' },
            { narration: { startsWith: 'Gaji karyawan bulan ' } },
            { narration: { startsWith: 'Listrik & air bulan ' } },
          ],
        },
        select: { id: true, date: true, narration: true, items: { select: { accountId: true, debit: true } } },
      });
      const legacyGenericIds = matchGenericDummyJournals(
        genericCandidates.map((j) => ({ ...j, items: j.items.map((it) => ({ accountId: it.accountId, debit: Number(it.debit) })) })),
        markerRows.map((m) => ({ date: m.date, accountId: m.accountId, debit: Number(m.debit) })),
      );
      const dummyJournals = await tx.journalEntry.findMany({
        where: {
          OR: [
            { isDummy: true },
            ...(paymentJeIds.length > 0 ? [{ id: { in: paymentJeIds } }] : []),
            ...(exactNarrations.length > 0 ? [{ narration: { in: exactNarrations } }] : []),
            ...(legacyGenericIds.length > 0 ? [{ id: { in: legacyGenericIds } }] : []),
          ],
        },
        select: dated,
      });
      const journalIds = dummyJournals.map(j => j.id);

      // Every ledger row that goes: of dummy documents, of dummy parties, the generator's markers,
      // and rows referencing a dummy journal (they would be orphans once the journal is gone).
      const dummyRefIds = [...siIds, ...piIds, ...paymentIds, ...DUMMY_LEDGER_MARKERS];
      const ledgerRows = await tx.accountingLedgerEntry.findMany({
        where: {
          OR: [
            { referenceId: { in: dummyRefIds } },
            ...(partyIds.length > 0 ? [{ partyId: { in: partyIds } }] : []),
            ...(journalIds.length > 0 ? [{ referenceType: 'JournalEntry', referenceId: { in: journalIds } }] : []),
          ],
        },
        select: { ...dated, accountId: true },
      });

      const dummyProdItems = itemIds.length > 0
        ? await tx.productionRunItem.findMany({ where: { itemId: { in: itemIds } }, select: { productionRunId: true } })
        : [];
      const prodRunIds = [...new Set(dummyProdItems.map(p => p.productionRunId))];
      const [prodRuns, movements] = await Promise.all([
        prodRunIds.length > 0 ? tx.productionRun.findMany({ where: { id: { in: prodRunIds } }, select: dated }) : [],
        itemIds.length > 0 ? tx.stockMovement.findMany({ where: { itemId: { in: itemIds } }, select: dated }) : [],
      ]);

      // Nothing is deleted before every row has passed the fiscal-year check.
      await assertDummyPeriodsOpen(tx, [...dummySI, ...dummyPI, ...dummyPayments, ...dummyJournals, ...ledgerRows, ...prodRuns, ...movements]);

      // Deletion order follows FK constraints: allocations, payments, ledger, journals, invoices, runs, parties last.
      if (paymentIds.length > 0) {
        await tx.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
        results.payments = (await tx.payment.deleteMany({ where: { id: { in: paymentIds } } })).count;
      }

      if (ledgerRows.length > 0) {
        await tx.accountingLedgerEntry.deleteMany({ where: { id: { in: ledgerRows.map((r) => r.id) } } });
      }

      if (journalIds.length > 0) {
        await tx.journalItem.deleteMany({ where: { journalEntryId: { in: journalIds } } });
        results.journals = (await tx.journalEntry.deleteMany({ where: { id: { in: journalIds } } })).count;
      }

      if (siIds.length > 0) {
        await tx.salesInvoiceItem.deleteMany({ where: { salesInvoiceId: { in: siIds } } });
        results.salesInvoices = (await tx.salesInvoice.deleteMany({ where: { id: { in: siIds } } })).count;
      }
      if (piIds.length > 0) {
        await tx.purchaseInvoiceItem.deleteMany({ where: { purchaseInvoiceId: { in: piIds } } });
        results.purchaseInvoices = (await tx.purchaseInvoice.deleteMany({ where: { id: { in: piIds } } })).count;
      }

      if (prodRunIds.length > 0) {
        await tx.productionRunItem.deleteMany({ where: { productionRunId: { in: prodRunIds } } });
        results.productionRuns = (await tx.productionRun.deleteMany({ where: { id: { in: prodRunIds } } })).count;
      }
      if (itemIds.length > 0) {
        results.movements = (await tx.stockMovement.deleteMany({ where: { itemId: { in: itemIds } } })).count;
        results.inventoryItems = (await tx.inventoryItem.deleteMany({ where: { id: { in: itemIds } } })).count;
      }

      results.parties = (await tx.party.deleteMany({ where: { id: { in: partyIds } } })).count;

      // Only the accounts whose ledger rows were deleted. Real parties never carried dummy
      // documents, so their outstanding amounts (opening balance included) are not touched.
      const touchedAccountIds = [...new Set(ledgerRows.map((r) => r.accountId))];
      if (touchedAccountIds.length > 0) await recalculateAccountBalances(tx, touchedAccountIds);
    }, { timeout: 120000 });

    logger.info({ results }, 'Dummy data deleted');
    return res.json({ message: 'Data dummy dihapus.', results });
  } catch (error) {
    if (error instanceof BusinessError && error.code === PERIOD_CLOSED) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    return handleRouteError(res, error, 'POST /settings/delete-dummy error', 'Gagal menghapus data dummy.');
  }
});

// POST /api/settings/reset-data: wipes all data and re-seeds. Admin only by default (settings edit
// + rbac.manage + doc.cancel); stays available in production (owner decision), but never runs
// without a pre-reset safety backup.
router.post('/reset-data', requirePerm('settings'), requireCap('rbac.manage'), requireCap('doc.cancel'), async (req, res) => {
  const body = req.body;
  if (body?.confirmation !== 'RESET') {
    return res.status(400).json({ error: 'Ketik RESET untuk mengonfirmasi.' });
  }

  let safetyBackup: string;
  try {
    safetyBackup = (await createBackup('pre-reset')).filename;
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : error }, 'POST /settings/reset-data safety backup failed');
    return res.status(500).json({
      error: 'Cadangan pengaman gagal dibuat, jadi reset dibatalkan. Tidak ada data yang dihapus.',
      code: SAFETY_BACKUP_FAILED,
    });
  }

  try {
    // Table names come from services/demoData/tables.ts, never from input.
    const tables = resetTables().map((t) => `"${t}"`).join(', ');
    await prisma.$transaction(async (tx) => {
      // First statement: lets the reset purge audit_trail once it is append-only (E7-R11).
      // Transaction-local; has no effect before that trigger exists.
      await tx.$executeRawUnsafe(`SELECT set_config('entaris.audit_purge', 'on', true)`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE`);
      // The single period_lock row (no lock) that postings share-lock.
      await tx.$executeRawUnsafe(`INSERT INTO period_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    }, { timeout: 60000 });

    // Re-seed by running the seed script
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('npx', ['tsx', 'prisma/seed.ts'], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env },
        timeout: 120000,
      });
    } catch (seedError) {
      logger.error({ error: seedError, safetyBackup }, 'Seed failed after reset');
      return res.status(500).json({ error: 'Data dihapus, tetapi data awal gagal diisi ulang. Silakan mulai ulang server.', safetyBackup });
    } finally {
      // The seed recreates accounts and their system mappings with new ids; drop the cached
      // mappings (and roles, Telegram config) so nothing keeps pointing at truncated rows.
      invalidateRuntimeCaches();
    }

    logger.info({ safetyBackup }, 'Database reset and re-seeded successfully');
    return res.json({ message: 'Data direset. Silakan masuk ulang.', safetyBackup });
  } catch (error) {
    logger.error({ error, safetyBackup }, 'POST /settings/reset-data error');
    return res.status(500).json({ error: 'Gagal mereset data.', safetyBackup });
  }
});

// GET /api/settings/check-update — Check GitHub for newer version

export default router;
