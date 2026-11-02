import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AuthRequest } from '../../middleware/auth';
import { updateBalancesForItems } from '../../utils/accountBalance';
import { BusinessError } from '../../utils/errors';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { getOpenFiscalYear } from '../../utils/fiscalYear';
import { systemAccounts } from '../../services/systemAccounts';
import { logger } from '../../lib/logger';
import { upload, parseFile, sanitizeCellValue } from './shared';
import { ACCOUNT_PARENT_NOT_FOUND } from '../../services/coa/accountRules';
import { lockAccounts } from '../../services/coa/accountStructure';
import { parseCoaRows, validateCoaRows } from '../../services/coa/coaImport';

const router = Router();

// POST /api/import/coa
router.post(
  '/coa',
  upload.single('file'),
  async (req: AuthRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'File wajib diunggah.' });

    try {
      const rows = await parseFile(req.file.buffer, req.file.originalname);
      const isPreview = req.query.preview === 'true';

      const { parsed, errors } = parseCoaRows(rows, sanitizeCellValue);
      const validated = await validateCoaRows(prisma, parsed);
      errors.push(...validated.errors);
      const validRows = validated.rows;

      if (isPreview) {
        const data = validRows.map((r) => ({
          accountNumber: r.accountNumber,
          name: r.name,
          rootType: r.rootType,
          accountType: r.accountType,
          parentNumber: r.parentNumber ?? '',
          isGroup: r.isGroup,
          openingBalance: r.openingBalance,
        }));
        return res.json({ data, errors, total: rows.length });
      }

      // Insert valid rows, parents first (validateCoaRows sorts by depth).
      let success = 0;
      for (const row of validRows) {
        let account: Awaited<ReturnType<typeof prisma.account.upsert>>;
        try {
          account = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            let parentId: string | null = null;
            if (row.parentNumber) {
              const parent = await tx.account.findUnique({ where: { accountNumber: row.parentNumber }, select: { id: true } });
              if (!parent) throw new BusinessError(`Induk ${row.parentNumber} tidak ditemukan atau barisnya ditolak.`, ACCOUNT_PARENT_NOT_FOUND);
              parentId = parent.id;
            }
            // Same lock order as the COA screen, so an edit and an import of the same account queue up.
            await lockAccounts(tx, [parentId, row.existingId]);

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
          errors.push({ row: row.rowNum, message });
          continue;
        }

        try {
          // Create opening balance GL journal for non-group accounts with balance
          if (row.openingBalance !== 0 && !row.isGroup) {
            const openingEquity = await systemAccounts.getAccount('OPENING_EQUITY');
            if (account.id !== openingEquity.id) {
              const now = new Date();
              const absAmount = Math.abs(row.openingBalance);

              // ASSET/EXPENSE normal balance = debit, LIABILITY/EQUITY/REVENUE normal balance = credit
              const isDebitNormal = ['ASSET', 'EXPENSE'].includes(account.rootType);
              const isPositive = row.openingBalance > 0;

              // Positive balance on debit-normal account → DR account / CR retained
              // Positive balance on credit-normal account → CR account / DR retained
              const accountDebit = (isDebitNormal === isPositive) ? absAmount : 0;
              const accountCredit = (isDebitNormal === isPositive) ? 0 : absAmount;

              await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
                // Inside the transaction so the fiscal year stays share-locked until the journal commits.
                const fiscalYear = await getOpenFiscalYear(tx, now);
                // Re-import never deletes posted journals (audit G-25): an account that already has
                // an active opening-balance journal keeps it, and the row is reported instead.
                const existingOpening = await tx.journalEntry.findFirst({
                  where: {
                    status: 'Submitted',
                    OR: [
                      { narration: { startsWith: `Saldo awal akun: ${row.accountNumber} - ` } },
                      // Opening balance set from the COA screen (PATCH /coa/:id/balance).
                      { narration: { startsWith: `Saldo Awal: ${row.accountNumber} - ` } },
                    ],
                  },
                  select: { entryNumber: true },
                });
                if (existingOpening) {
                  throw new BusinessError(
                    `saldo awal sudah tercatat di jurnal ${existingOpening.entryNumber}. Impor ulang tidak mengubah saldo awal; koreksi lewat jurnal manual.`,
                  );
                }

                const jvNumber = await generateDocumentNumber(tx, 'JV', now, fiscalYear.id);
                const journal = await tx.journalEntry.create({
                  data: {
                    entryNumber: jvNumber,
                    date: now,
                    narration: `Saldo awal akun: ${row.accountNumber} - ${row.name}`,
                    status: 'Submitted',
                    fiscalYearId: fiscalYear.id,
                    createdBy: req.user!.userId,
                    submittedAt: now,
                    sourceType: 'OPENING',
                    items: {
                      create: [
                        { accountId: account.id, debit: accountDebit, credit: accountCredit, description: `Saldo awal: ${row.accountNumber} - ${row.name}` },
                        { accountId: openingEquity.id, debit: accountCredit, credit: accountDebit, description: `Saldo awal: ${row.accountNumber} - ${row.name}` },
                      ],
                    },
                  },
                  include: { items: true },
                });

                await tx.accountingLedgerEntry.createMany({
                  data: journal.items.map((item: any) => ({
                    date: now,
                    accountId: item.accountId,
                    debit: item.debit,
                    credit: item.credit,
                    referenceType: 'JournalEntry' as const,
                    referenceId: journal.id,
                    description: item.description || `Saldo awal: ${row.accountNumber}`,
                    fiscalYearId: fiscalYear.id,
                  })),
                });

                await updateBalancesForItems(
                  tx,
                  journal.items.map((i: any) => ({ accountId: i.accountId, debit: Number(i.debit), credit: Number(i.credit) }))
                );
              }, { timeout: 15000 });
            }
          }

          success++;
        } catch (err: any) {
          if (err instanceof BusinessError) {
            // The account itself was saved; only its opening balance was left as it was.
            success++;
            errors.push({ row: row.rowNum, message: `Akun "${row.accountNumber}" disimpan, tetapi ${err.message}` });
          } else {
            errors.push({ row: row.rowNum, message: `Baris ${row.rowNum}: gagal membuat jurnal saldo awal akun "${row.accountNumber}": ${err.message}` });
          }
        }
      }

      return res.json({ success, failed: rows.length - success, errors });
    } catch (error: any) {
      logger.error({ error }, 'POST /import/coa error');
      return res.status(400).json({ error: error.message || 'Gagal memproses file.' });
    }
  }
);

export default router;
