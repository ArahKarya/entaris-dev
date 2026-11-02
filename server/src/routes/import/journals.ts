import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AuthRequest, requirePerm } from '../../middleware/auth';
import { updateBalancesForItems } from '../../utils/accountBalance';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { assertPeriodOpen } from '../../utils/periodGuard';
import { importDateToInstant } from '../../utils/importDate';
import { BusinessError, handleRouteError } from '../../utils/errors';
import { hasCap } from '../../services/permissionService';
import {
  loadControlAccountMap,
  manualJournalRule,
  postableAccountProblem,
  TAX_ACCOUNT_ROLES,
  type AccountLite,
} from '../../services/ledger/accountGuard';
import { sourceKeys } from '../../services/ledger/journalSource';
import {
  checkGroupLines,
  groupSourceKeyParts,
  MAX_IMPORT_GROUPS,
  parseJournalRows,
  type CheckedGroup,
  type ImportRowError,
} from '../../services/journalImport';
import { upload, parseFileDetailed, sanitizeCellValue } from './shared';

const router = Router();

/** All groups post in one transaction; a big file needs more than the default 5 s. */
const IMPORT_TX_TIMEOUT_MS = 60_000;

/** Type of the journals this importer wrote, for the already-imported lookup. */
const ALREADY_IMPORTED_TYPE = 'IMPORT' as const;

interface ReadyGroup extends CheckedGroup {
  sourceKey: string;
}

interface ImportOutcome {
  errors: ImportRowError[];
  ready: ReadyGroup[];
  skipped: Array<{ narration: string; day: string; sourceKey: string }>;
  posted: Array<{ id: string; entryNumber: string }>;
}

// POST /api/import/journals
// Needs the settings right (mount in index.ts) and the journal right (here). All-or-nothing: every
// journal is checked first, one error anywhere means nothing is posted and every bad row is reported.
router.post(
  '/journals',
  requirePerm('journal'),
  upload.single('file'),
  async (req: AuthRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'File wajib diunggah.' });

    try {
      const { rows, numericCells } = await parseFileDetailed(req.file.buffer, req.file.originalname);
      const isPreview = req.query.preview === 'true';
      const userId = req.user!.userId;

      const parsed = parseJournalRows(rows, numericCells, sanitizeCellValue);
      if (parsed.groups.length > MAX_IMPORT_GROUPS) {
        return res.status(400).json({
          error: `File berisi ${parsed.groups.length} jurnal; maksimal ${MAX_IMPORT_GROUPS} jurnal per file. Pecah file menjadi beberapa bagian.`,
        });
      }
      const lineCheck = checkGroupLines(parsed.groups);
      const canControl = await hasCap(req.user!.role, 'journal.control');

      const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ImportOutcome> => {
        const errors: ImportRowError[] = [...parsed.errors, ...lineCheck.errors];
        const parts = groupSourceKeyParts(lineCheck.checked);
        const keyed = lineCheck.checked.map((c, i) => ({
          ...c,
          sourceKey: sourceKeys.importGroup(parts[i].hash, parts[i].occurrence),
        }));

        // A journal already imported (same content, not cancelled) is skipped, not posted twice.
        const existing = keyed.length === 0
          ? []
          : await tx.journalEntry.findMany({
              where: { sourceType: ALREADY_IMPORTED_TYPE, sourceKey: { in: keyed.map((k) => k.sourceKey) }, status: { not: 'Cancelled' } },
              select: { sourceKey: true },
            });
        const imported = new Set(existing.map((e) => e.sourceKey));
        const skipped = keyed.filter((k) => imported.has(k.sourceKey))
          .map((k) => ({ narration: k.group.narration, day: k.group.day, sourceKey: k.sourceKey }));
        const todo = keyed.filter((k) => !imported.has(k.sourceKey));

        errors.push(...(await accountErrors(tx, todo, canControl)));
        errors.push(...(await periodErrors(tx, todo)));

        const ready = todo;
        if (isPreview || errors.length > 0) return { errors, ready, skipped, posted: [] };

        const posted: ImportOutcome['posted'] = [];
        const accountIds = await accountIdsByNumber(tx, ready);
        for (const { group, lines, sourceKey } of ready) {
          const date = importDateToInstant(group.day);
          const fiscalYear = await assertPeriodOpen(tx, { date }, 'jurnal');
          const entryNumber = await generateDocumentNumber(tx, 'JV', date, fiscalYear.id);

          const journalEntry = await tx.journalEntry.create({
            data: {
              entryNumber,
              date,
              narration: group.narration,
              status: 'Submitted',
              fiscalYearId: fiscalYear.id,
              createdBy: userId,
              submittedAt: new Date(),
              sourceType: 'IMPORT',
              sourceKey,
              items: {
                create: lines.map((l) => ({
                  accountId: accountIds.get(l.accountId)!,
                  debit: l.debit,
                  credit: l.credit,
                  description: l.description || group.narration,
                })),
              },
            },
            include: { items: true },
          });

          // Post to immutable ledger
          await tx.accountingLedgerEntry.createMany({
            data: journalEntry.items.map((item) => ({
              date,
              accountId: item.accountId,
              partyId: item.partyId,
              debit: item.debit,
              credit: item.credit,
              referenceType: 'JournalEntry',
              referenceId: journalEntry.id,
              description: item.description || group.narration,
              fiscalYearId: fiscalYear.id,
            })),
          });

          await updateBalancesForItems(
            tx,
            journalEntry.items.map((i) => ({ accountId: i.accountId, debit: i.debit, credit: i.credit })),
          );
          posted.push({ id: journalEntry.id, entryNumber });
        }
        return { errors, ready, skipped, posted };
      }, { timeout: IMPORT_TX_TIMEOUT_MS });

      const skippedRows = outcome.skipped.map((s) => ({ narration: s.narration, date: s.day }));
      if (isPreview) {
        return res.json({
          data: outcome.ready.map((g) => ({
            date: g.group.day,
            ref: g.group.ref,
            narration: g.group.narration,
            items: g.group.items.map((i) => ({ accountNumber: i.accountNumber, debit: i.debit, credit: i.credit, description: i.description })),
          })),
          errors: outcome.errors,
          total: rows.length,
          journalCount: outcome.ready.length,
          alreadyImported: skippedRows,
        });
      }

      const totalJournals = outcome.ready.length + outcome.skipped.length;
      return res.json({
        success: outcome.posted.length,
        // Nothing posts when any row is bad, so every journal that was to post counts as failed.
        failed: outcome.errors.length > 0 ? outcome.ready.length : 0,
        errors: outcome.errors,
        totalJournals,
        journals: outcome.posted,
        alreadyImported: skippedRows,
      });
    } catch (error: any) {
      return handleRouteError(res, error, 'POST /import/journals error', 'Gagal memproses file.');
    }
  }
);

const ACCOUNT_SELECT = { id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true } as const;

/** Account lookup by number for every journal at once; a missing or non-postable account is an error on its rows. */
async function accountErrors(tx: Prisma.TransactionClient, groups: readonly CheckedGroup[], canControl: boolean): Promise<ImportRowError[]> {
  const numbers = [...new Set(groups.flatMap((g) => g.lines.map((l) => l.accountId)))];
  if (numbers.length === 0) return [];
  const [accounts, controlMap] = await Promise.all([
    tx.account.findMany({ where: { accountNumber: { in: numbers } }, select: ACCOUNT_SELECT }),
    loadControlAccountMap(tx, TAX_ACCOUNT_ROLES),
  ]);
  const byNumber = new Map<string, AccountLite>(accounts.map((a) => [a.accountNumber, a]));
  const rule = manualJournalRule(canControl);
  const errors: ImportRowError[] = [];
  for (const { group } of groups) {
    for (const item of group.items) {
      const account = byNumber.get(item.accountNumber);
      if (!account) {
        errors.push({ row: item.rowNum, message: `Akun "${item.accountNumber}" tidak ditemukan.` });
        continue;
      }
      const problem = postableAccountProblem(account, rule, controlMap.get(account.id) ?? null);
      if (problem) errors.push({ row: item.rowNum, message: problem.message });
    }
  }
  return errors;
}

async function accountIdsByNumber(tx: Prisma.TransactionClient, groups: readonly CheckedGroup[]): Promise<Map<string, string>> {
  const numbers = [...new Set(groups.flatMap((g) => g.lines.map((l) => l.accountId)))];
  const accounts = await tx.account.findMany({ where: { accountNumber: { in: numbers } }, select: { id: true, accountNumber: true } });
  return new Map(accounts.map((a) => [a.accountNumber, a.id]));
}

/** An open fiscal year and an unlocked period for each distinct date; a failure lands on every row of the journals dated then. */
async function periodErrors(tx: Prisma.TransactionClient, groups: readonly CheckedGroup[]): Promise<ImportRowError[]> {
  const problems = new Map<string, string | null>();
  const errors: ImportRowError[] = [];
  for (const { group } of groups) {
    if (!problems.has(group.day)) {
      try {
        await assertPeriodOpen(tx, { date: importDateToInstant(group.day) }, 'jurnal');
        problems.set(group.day, null);
      } catch (err) {
        if (!(err instanceof BusinessError)) throw err;
        problems.set(group.day, err.message);
      }
    }
    const message = problems.get(group.day);
    if (message) for (const item of group.items) errors.push({ row: item.rowNum, message });
  }
  return errors;
}

export default router;
