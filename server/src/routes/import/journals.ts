import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AuthRequest, requirePerm } from '../../middleware/auth';
import { assertPeriodOpen, PERIOD_BUSY } from '../../utils/periodGuard';
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
import { createManualJournalInTx } from '../../services/manualJournal';
import { sourceKeys } from '../../services/ledger/journalSource';
import {
  checkGroupLines,
  groupSourceKeyParts,
  MAX_IMPORT_GROUPS,
  parseJournalRows,
  type CheckedGroup,
  type ImportRowError,
} from '../../services/journalImport';
import { resolveImportParties } from '../../services/journalImportParties';
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
      let parsedFile;
      try {
        parsedFile = await parseFileDetailed(req.file.buffer, req.file.originalname);
      } catch (parseError: any) {
        throw new BusinessError(`File tidak bisa dibaca: ${parseError?.message ?? 'format tidak dikenali'}`);
      }
      const { rows, numericCells } = parsedFile;
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

        // One import at a time: keys are not unique in the database, so two uploads of the same file
        // would both see no existing key and post twice.
        if (!isPreview) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('IMPORT_JOURNALS'))`;

        const accounts = await loadAccounts(tx, lineCheck.checked);
        errors.push(...(await accountErrors(tx, lineCheck.checked, accounts, canControl)));
        // Parties resolve to ids before the content hash, so naming a party by id or by name is the same journal.
        const accountIds = new Map([...accounts].map(([number, a]) => [number, a.id]));
        const resolved = await resolveImportParties(tx, lineCheck.checked, accountIds);
        errors.push(...resolved.errors);

        const parts = groupSourceKeyParts(resolved.groups);
        const keyed = resolved.groups.map((c, i) => ({
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

        errors.push(...(await periodErrors(tx, todo)));

        const ready = todo;
        if (isPreview || errors.length > 0) return { errors, ready, skipped, posted: [] };

        const posted: ImportOutcome['posted'] = [];
        for (const { group, lines, sourceKey } of ready) {
          const { journal } = await createManualJournalInTx(
            tx,
            {
              date: group.day,
              narration: group.narration,
              items: lines.map((l) => ({
                accountId: accountIds.get(l.accountId)!,
                debit: l.debit.toFixed(2),
                credit: l.credit.toFixed(2),
                partyId: l.partyId,
                description: l.description,
              })),
            },
            { userId, sourceType: 'IMPORT', sourceKey, canControl },
          );
          posted.push({ id: journal.id, entryNumber: journal.entryNumber });
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
            items: g.group.items.map((i) => ({ accountNumber: i.accountNumber, debit: i.debit, credit: i.credit, description: i.description, partyCode: i.partyCode })),
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

/** Every account the checked journals name, by account number. */
async function loadAccounts(tx: Prisma.TransactionClient, groups: readonly CheckedGroup[]): Promise<Map<string, AccountLite>> {
  const numbers = [...new Set(groups.flatMap((g) => g.lines.map((l) => l.accountId)))];
  if (numbers.length === 0) return new Map();
  const accounts = await tx.account.findMany({ where: { accountNumber: { in: numbers } }, select: ACCOUNT_SELECT });
  return new Map(accounts.map((a) => [a.accountNumber, a]));
}

/** A missing or non-postable account is an error on its rows. */
async function accountErrors(
  tx: Prisma.TransactionClient,
  groups: readonly CheckedGroup[],
  byNumber: ReadonlyMap<string, AccountLite>,
  canControl: boolean,
): Promise<ImportRowError[]> {
  if (groups.length === 0) return [];
  const controlMap = await loadControlAccountMap(tx, TAX_ACCOUNT_ROLES);
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
      if (problem) errors.push({ row: item.rowNum, message: problem.message, code: problem.code });
    }
  }
  return errors;
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
        // A lock timeout aborts the transaction: stop and let the route answer with the retryable code.
        if (!(err instanceof BusinessError) || err.code === PERIOD_BUSY) throw err;
        problems.set(group.day, err.message);
      }
    }
    const message = problems.get(group.day);
    if (message) for (const item of group.items) errors.push({ row: item.rowNum, message });
  }
  return errors;
}

export default router;
