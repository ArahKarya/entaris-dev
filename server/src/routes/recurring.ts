import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { CreateRecurringSchema, UpdateRecurringSchema, parseTemplateData, type RecurringTemplateType } from '../utils/schemas';
import { checkNextRunDate, validateJournalTemplateData, RECURRING_TYPE_MISMATCH } from '../utils/recurringRules';
import { assertJournalLines } from '../utils/journalLineRules';
import { assertPostableAccounts, TEMPLATE_RULE } from '../services/ledger/accountGuard';
import { updateBalancesForItems } from '../utils/accountBalance';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { BusinessError, handleRouteError } from '../utils/errors';
import { logger } from '../lib/logger';

const router = Router();

type Tx = Prisma.TransactionClient;

/**
 * Save-time validation of a template body (E7-R5): the shape must match the template type; a journal
 * template must balance exactly, carry no party and use only plain posting accounts (no control or
 * tax accounts). Returns the data to store (journal amounts normalized to 2-decimal strings).
 */
async function validatedTemplateData(tx: Tx, templateType: RecurringTemplateType, data: unknown): Promise<Prisma.InputJsonValue> {
  const parsed = parseTemplateData(templateType, data);
  if (!parsed.success) {
    throw new BusinessError(`Data template tidak sesuai dengan tipe ${templateType}: ${parsed.error.issues[0].message}`, RECURRING_TYPE_MISMATCH);
  }
  if (templateType !== 'journal') return parsed.data as Prisma.InputJsonValue;
  const normalized = validateJournalTemplateData(parsed.data as Parameters<typeof validateJournalTemplateData>[0]);
  await assertPostableAccounts(tx, normalized.items.map((i) => i.accountId), TEMPLATE_RULE);
  return normalized as unknown as Prisma.InputJsonValue;
}

function assertNextRunDate(input: Parameters<typeof checkNextRunDate>[0]): Date {
  const check = checkNextRunDate(input);
  if (!check.ok) throw new BusinessError(check.message, check.code);
  return check.date;
}

// Helper: Calculate next run date
function calculateNextRunDate(frequency: string, fromDate: Date, dayOfMonth?: number | null): Date {
  const next = new Date(fromDate);
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      if (dayOfMonth) {
        const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(dayOfMonth, maxDay));
      }
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      if (dayOfMonth) {
        const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(dayOfMonth, maxDay));
      }
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + 1);
      break;
    default:
      next.setMonth(next.getMonth() + 1);
  }
  return next;
}

// Helper: Execute a template
async function executeTemplate(
  template: any,
  userId: string,
): Promise<{ success: boolean; result?: any; error?: string }> {
  const data = template.templateData as any;
  const now = new Date();

  try {
    if (template.templateType === 'journal') {
      // Create journal entry from template
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const parsedDate = now;
        const fiscalYear = await getOpenFiscalYear(tx, parsedDate);
        const entryNumber = await generateDocumentNumber(tx, 'JV', parsedDate, fiscalYear.id);

        const items = (data.items || []).map((item: any) => ({
          accountId: item.accountId,
          partyId: item.partyId || null,
          debit: item.debit || 0,
          credit: item.credit || 0,
          description: item.description || data.narration,
        }));
        assertJournalLines(items);

        const journalEntry = await tx.journalEntry.create({
          data: {
            entryNumber,
            date: parsedDate,
            narration: data.narration || template.name,
            status: 'Submitted',
            fiscalYearId: fiscalYear.id,
            createdBy: userId,
            submittedAt: new Date(),
            sourceType: 'RECURRING',
            items: { create: items },
          },
          include: { items: true },
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
            description: item.description || data.narration,
            fiscalYearId: fiscalYear.id,
          })),
        });

        await updateBalancesForItems(
          tx,
          journalEntry.items.map((i) => ({
            accountId: i.accountId,
            debit: i.debit,
            credit: i.credit,
          })),
        );

        return journalEntry;
      }, { timeout: 15000 });

      return { success: true, result };
    }

    // For other types, just return a placeholder — the template stores the data
    // but actual invoice creation would need the full flow. For simplicity,
    // we create a journal entry representation.
    return {
      success: false,
      error: `Eksekusi otomatis untuk tipe ${template.templateType} belum didukung. Gunakan tipe journal.`,
    };
  } catch (error: any) {
    logger.error({ error, templateId: template.id }, 'Execute recurring template error');
    return { success: false, error: error.message || 'Gagal mengeksekusi template.' };
  }
}

// GET /api/recurring — list all templates
router.get('/', async (_req, res) => {
  try {
    const templates = await prisma.recurringTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { fullName: true } } },
    });
    return res.json({ data: templates });
  } catch (error) {
    logger.error({ error }, 'GET /recurring error');
    return res.status(500).json({ error: 'Gagal mengambil data template berulang.' });
  }
});

// POST /api/recurring — create template
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateRecurringSchema, req.body, res);
  if (!body) return;

  try {
    const template = await prisma.$transaction(async (tx: Tx) => {
      const nextRunDate = assertNextRunDate({ nextRunDate: body.nextRunDate });
      const templateData = await validatedTemplateData(tx, body.templateType, body.templateData);
      return tx.recurringTemplate.create({
        data: {
          name: body.name,
          templateType: body.templateType,
          frequency: body.frequency,
          dayOfMonth: body.dayOfMonth || null,
          nextRunDate,
          templateData,
          createdBy: req.user!.userId,
        },
      });
    });
    return res.status(201).json(template);
  } catch (error) {
    return handleRouteError(res, error, 'POST /recurring', 'Gagal membuat template berulang.');
  }
});

// PUT /api/recurring/:id — update template
router.put('/:id', async (req, res) => {
  const body = validateBody(UpdateRecurringSchema, req.body, res);
  if (!body) return;

  try {
    const outcome = await prisma.$transaction(async (tx: Tx) => {
      const existing = await tx.recurringTemplate.findUnique({ where: { id: req.params.id as string } });
      if (!existing) return null;

      const templateType = (body.templateType ?? existing.templateType) as RecurringTemplateType;
      // Data is re-validated when it or its type changes, and before a template is switched back on
      // (the stored data may predate these rules).
      const revalidate = body.templateData !== undefined || body.templateType !== undefined || body.isActive === true;
      const templateData = revalidate
        ? await validatedTemplateData(tx, templateType, body.templateData ?? existing.templateData)
        : undefined;
      const nextRunDate = body.nextRunDate === undefined
        ? undefined
        : assertNextRunDate({
          nextRunDate: body.nextRunDate,
          lastRunDate: existing.lastRunDate,
          previousNextRunDate: existing.nextRunDate,
        });

      return tx.recurringTemplate.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.templateType !== undefined && { templateType: body.templateType }),
          ...(body.frequency !== undefined && { frequency: body.frequency }),
          ...(body.dayOfMonth !== undefined && { dayOfMonth: body.dayOfMonth }),
          ...(nextRunDate !== undefined && { nextRunDate }),
          ...(templateData !== undefined && { templateData }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
    });
    if (!outcome) return res.status(404).json({ error: 'Template tidak ditemukan.' });
    return res.json(outcome);
  } catch (error: any) {
    return handleRouteError(res, error, 'PUT /recurring/:id', 'Gagal mengupdate template berulang.');
  }
});

// DELETE /api/recurring/:id — soft delete (set isActive=false)
router.delete('/:id', async (req, res) => {
  try {
    await prisma.recurringTemplate.update({
      where: { id: req.params.id as string },
      data: { isActive: false },
    });
    return res.json({ message: 'Template berulang dinonaktifkan.' });
  } catch (error: any) {
    return handleRouteError(res, error, 'DELETE /recurring/:id', 'Gagal menonaktifkan template berulang.');
  }
});

// POST /api/recurring/:id/execute — manually execute one template
router.post('/:id/execute', async (req: AuthRequest, res) => {
  try {
    const template = await prisma.recurringTemplate.findUnique({
      where: { id: req.params.id as string },
    });
    if (!template) return res.status(404).json({ error: 'Template tidak ditemukan.' });

    const result = await executeTemplate(template, req.user!.userId);

    if (result.success) {
      // Update lastRunDate and nextRunDate
      const nextRun = calculateNextRunDate(template.frequency, new Date(), template.dayOfMonth);
      await prisma.recurringTemplate.update({
        where: { id: template.id },
        data: { lastRunDate: new Date(), nextRunDate: nextRun },
      });
    }

    return res.json(result);
  } catch (error) {
    return handleRouteError(res, error, 'POST /recurring/:id/execute', 'Gagal mengeksekusi template.');
  }
});

// POST /api/recurring/run-due: execute all due templates (requires the doc.cancel capability)
router.post('/run-due', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  try {
    const now = new Date();
    const dueTemplates = await prisma.recurringTemplate.findMany({
      where: { isActive: true, nextRunDate: { lte: now } },
    });

    const results: Array<{ templateId: string; name: string; success: boolean; error?: string }> = [];

    for (const template of dueTemplates) {
      const result = await executeTemplate(template, req.user!.userId);
      results.push({
        templateId: template.id,
        name: template.name,
        success: result.success,
        error: result.error,
      });

      if (result.success) {
        const nextRun = calculateNextRunDate(template.frequency, now, template.dayOfMonth);
        await prisma.recurringTemplate.update({
          where: { id: template.id },
          data: { lastRunDate: now, nextRunDate: nextRun },
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return res.json({
      message: `${successCount}/${dueTemplates.length} template dijalankan.`,
      results,
    });
  } catch (error) {
    return handleRouteError(res, error, 'POST /recurring/run-due', 'Gagal menjalankan template berulang.');
  }
});

export default router;
