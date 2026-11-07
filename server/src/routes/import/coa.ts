import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AuthRequest } from '../../middleware/auth';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import { upload, parseFileDetailed, sanitizeCellValue } from './shared';
import { ACCOUNT_PARENT_NOT_FOUND } from '../../services/coa/accountRules';
import { loadImportFacts, lockAccounts } from '../../services/coa/accountStructure';
import { parseCoaRows, replanImportRow, validateCoaRows, type CoaImportRow } from '../../services/coa/coaImport';
import { hasCap } from '../../services/permissionService';
import {
  OPENING_DATE_MISMATCH,
  OPENING_LOCK_RIGHT,
  previewAccountOpening,
  setOpeningBalanceInTx,
  type OpeningChangePreview,
  type OpeningOutcome,
} from '../../services/ledger/openingBalance';

const router = Router();

/** A row would replace a recorded opening balance, and the request did not confirm that row. */
export const OPENING_REPLACE_UNCONFIRMED = 'OPENING_REPLACE_UNCONFIRMED';
/** A row's amount equals the account's running balance (old template), and the request did not confirm that row. */
export const OPENING_RUNNING_BALANCE = 'OPENING_RUNNING_BALANCE';

/** Rows that change an opening balance already in the ledger need their account number in `confirmReplace`. */
const needsConfirm = (p: OpeningChangePreview): boolean =>
  p.allowed && (p.action === 'replace' || (p.action === 'post' && p.runningBalance));

/**
 * The account numbers the user confirmed one by one: repeated form fields, or one comma-separated
 * value (body or query). Each row is confirmed on its own, so ticking one replacement never lets
 * another row (a running balance further down the file) through.
 */
function confirmedAccounts(...values: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const v of values.flat()) {
    if (typeof v !== 'string') continue;
    for (const n of v.split(',')) if (n.trim()) out.add(n.trim());
  }
  return out;
}

const THROUGH_LOCK_MIN = 10;

function previewAccount(row: CoaImportRow, id: string | null) {
  return { id, accountNumber: row.accountNumber, name: row.name, rootType: row.rootType, isGroup: row.isGroup };
}

/**
 * The row's opening balance through the opening balance service, in its own transaction after the
 * account is saved. Returns null when there is nothing to write: a blank cell, or the same amount
 * (also zero) on an account that takes no opening balance. The same amount as the recorded opening
 * is 'unchanged' without calling the service: a keyed journal dated after the cut-over day (an old
 * import, keyed by the opening audit) must not be voided and posted again on the cut-over day.
 * Throws a BusinessError with a code for a refusal; the account itself stays saved.
 */
async function importOpening(
  row: CoaImportRow,
  accountId: string,
  userId: string,
  confirmed: boolean,
  throughLock: { reason: string } | undefined,
): Promise<OpeningOutcome | null> {
  if (row.openingBalance === null) return null;
  const amount = row.openingBalance;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const preview = await previewAccountOpening(tx, previewAccount(row, accountId), amount, row.openingDate);
    // A wrong date goes on to the service, which refuses it with OPENING_DATE_MISMATCH.
    if (preview.action === 'unchanged' && preview.reason !== OPENING_DATE_MISMATCH) {
      if (!preview.allowed) return null;
      const same: OpeningOutcome = { action: 'unchanged', asOfDate: preview.cutoverDate!, amount: new Prisma.Decimal(amount), journal: null, cancelled: [] };
      return same;
    }
    if (needsConfirm(preview) && !confirmed) {
      throw preview.action === 'replace'
        ? new BusinessError(
            `saldo awal tercatat ${preview.recorded} akan diganti ${amount}. Centang konfirmasi akun ini di layar impor untuk menggantinya.`,
            OPENING_REPLACE_UNCONFIRMED,
          )
        : new BusinessError(
            `nilai ${amount} sama dengan saldo berjalan akun, bukan saldo per tanggal cut-over ${preview.cutoverDate}. Isi saldo per tanggal cut-over, atau centang konfirmasi akun ini bila nilai ini memang saldo awalnya.`,
            OPENING_RUNNING_BALANCE,
          );
    }
    const outcome = await setOpeningBalanceInTx(tx, {
      target: { kind: 'ACCOUNT', accountId },
      amount,
      asOfDate: row.openingDate ?? undefined,
      userId,
      throughLock,
    });
    // The preview ran before the service took its locks; a keyed journal that appeared since is still a replacement.
    if (outcome.cancelled.length > 0 && !confirmed) {
      throw new BusinessError(
        `saldo awal tercatat akan diganti ${amount}. Centang konfirmasi akun ini di layar impor untuk menggantinya.`,
        OPENING_REPLACE_UNCONFIRMED,
      );
    }
    return outcome;
  }, { timeout: 15000 });
}

// POST /api/import/coa
// Accounts first (structure rules, one transaction per row), then each row's opening balance at
// the cut-over date through the opening balance service. ?preview=true writes nothing and shows per
// row what the opening balance would do; a row that replaces a recorded opening, or that equals the
// running balance, needs its account number in confirmReplace. throughLockReason posts into a locked
// month: period.lock holders only, never AIRA, the reason goes to the audit trail (owner decision #10).
router.post(
  '/coa',
  upload.single('file'),
  async (req: AuthRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'File wajib diunggah.' });

    try {
      const isPreview = req.query.preview === 'true';
      const confirmReplace = confirmedAccounts(req.body?.confirmReplace, req.query.confirmReplace);
      const reasonRaw = req.body?.throughLockReason;
      const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
      if (reason && !isPreview) {
        if (reason.length < THROUGH_LOCK_MIN) {
          return res.status(400).json({ error: 'Alasan menembus kunci periode minimal 10 karakter.' });
        }
        if (req.user!.via === 'mcp') {
          return res.status(403).json({ error: 'AIRA tidak dapat menembus kunci periode untuk saldo awal.', code: OPENING_LOCK_RIGHT });
        }
        if (!(await hasCap(req.user!.role, 'period.lock'))) {
          return res.status(403).json({ error: 'Menembus kunci periode untuk saldo awal butuh hak Kunci Periode (period.lock).', code: OPENING_LOCK_RIGHT });
        }
      }
      const throughLock = reason && !isPreview ? { reason } : undefined;

      const { rows, numericCells } = await parseFileDetailed(req.file.buffer, req.file.originalname);

      const { parsed, errors } = parseCoaRows(rows, sanitizeCellValue, numericCells);
      const validated = await validateCoaRows(prisma, parsed);
      errors.push(...validated.errors);
      const validRows = validated.rows;

      if (isPreview) {
        const data = [];
        for (const r of validRows) {
          const opening = r.openingBalance === null ? null : await previewAccountOpening(prisma, previewAccount(r, r.existingId), r.openingBalance, r.openingDate);
          data.push({
            accountNumber: r.accountNumber,
            name: r.name,
            rootType: r.rootType,
            accountType: r.accountType,
            parentNumber: r.parentNumber ?? '',
            isGroup: r.isGroup,
            openingBalance: r.openingBalance ?? '',
            opening: opening && { ...opening, needsConfirm: needsConfirm(opening) },
          });
        }
        return res.json({ data, errors, total: rows.length });
      }

      // Insert valid rows, parents first (validateCoaRows sorts by depth).
      let success = 0;
      const openings: Array<{ row: number; accountNumber: string; action: OpeningOutcome['action']; journalNumber: string | null; cancelled: string[] }> = [];
      for (const row of validRows) {
        let account: Awaited<ReturnType<typeof prisma.account.upsert>>;
        try {
          account = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            // Same lock order as the COA screen, so an edit and an import of the same account queue up.
            const before = await loadImportFacts(tx, [row.accountNumber, row.parentNumber ?? ''].filter(Boolean));
            const parentBefore = row.parentNumber ? before.parents.get(row.parentNumber) : undefined;
            if (row.parentNumber && !parentBefore) {
              throw new BusinessError(`Induk ${row.parentNumber} tidak ditemukan atau barisnya ditolak.`, ACCOUNT_PARENT_NOT_FOUND);
            }
            await lockAccounts(tx, [parentBefore?.id, before.existing.get(row.accountNumber)?.id, row.existingId]);
            // The file was validated without locks; plan the row again now that the accounts are held.
            const current = await replanImportRow(tx, row);
            if (!current.ok) throw new BusinessError(current.message, current.code);
            const parentId = current.parentId;

            const upsertData = {
              name: row.name,
              rootType: row.rootType,
              accountType: row.accountType,
              parentId,
              isGroup: row.isGroup,
            };
            return tx.account.upsert({
              where: { accountNumber: row.accountNumber },
              update: upsertData,
              create: { accountNumber: row.accountNumber, ...upsertData },
            });
          });
        } catch (err: any) {
          const message = err instanceof BusinessError ? err.message : `Baris ${row.rowNum}: gagal menyimpan akun "${row.accountNumber}": ${err.message}`;
          errors.push({ row: row.rowNum, message, ...(err instanceof BusinessError && err.code ? { code: err.code } : {}) });
          continue;
        }

        try {
          const outcome = await importOpening(row, account.id, req.user!.userId, confirmReplace.has(row.accountNumber), throughLock);
          if (outcome) {
            openings.push({
              row: row.rowNum,
              accountNumber: row.accountNumber,
              action: outcome.action,
              journalNumber: outcome.journal?.entryNumber ?? null,
              cancelled: outcome.cancelled,
            });
          }
          success++;
        } catch (err: any) {
          if (err instanceof BusinessError) {
            // The account itself was saved; only its opening balance was left as it was.
            success++;
            errors.push({ row: row.rowNum, message: `Akun "${row.accountNumber}" disimpan, tetapi ${err.message}`, ...(err.code ? { code: err.code } : {}) });
          } else {
            logger.error({ error: err, accountNumber: row.accountNumber }, 'POST /import/coa opening balance error');
            errors.push({ row: row.rowNum, message: `Baris ${row.rowNum}: gagal membuat jurnal saldo awal akun "${row.accountNumber}": ${err.message}` });
          }
        }
      }

      return res.json({ success, failed: rows.length - success, errors, openings });
    } catch (error: any) {
      logger.error({ error }, 'POST /import/coa error');
      return res.status(400).json({ error: error.message || 'Gagal memproses file.' });
    }
  }
);

export default router;
