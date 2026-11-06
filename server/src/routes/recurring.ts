import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { CreateRecurringSchema, UpdateRecurringSchema, parseTemplateData, type RecurringTemplateType } from '../utils/schemas';
import { checkNextRunDate, validateJournalTemplateData, RECURRING_TYPE_MISMATCH } from '../utils/recurringRules';
import { assertPostableAccounts, TEMPLATE_RULE } from '../services/ledger/accountGuard';
import { runDueTemplates, runRecurringTemplate } from '../services/recurringExecute';
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

// POST /api/recurring/:id/execute: run one template now (services/recurringExecute.ts). A run that
// does not post is refused with its code (400) and recorded on the template (lastError).
router.post('/:id/execute', async (req: AuthRequest, res) => {
  try {
    const run = await runRecurringTemplate(req.params.id as string, { userId: req.user!.userId });
    if (run.outcome === 'not_found') return res.status(404).json({ error: 'Template tidak ditemukan.' });
    if (run.outcome === 'failed') return handleRouteError(res, run.error, 'POST /recurring/:id/execute', 'Gagal mengeksekusi template.');
    return res.json({ success: true, result: run.outcome === 'posted' ? run.journal : null });
  } catch (error) {
    return handleRouteError(res, error, 'POST /recurring/:id/execute', 'Gagal mengeksekusi template.');
  }
});

// POST /api/recurring/run-due: execute all due templates (requires the doc.cancel capability).
// Each template runs on its own; a failing one is recorded on the template and the rest continue.
router.post('/run-due', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  try {
    const runs = await runDueTemplates(req.user!.userId);
    const results = runs.map((r) => ({
      templateId: r.templateId,
      name: r.name,
      success: r.outcome === 'posted',
      ...(r.outcome !== 'posted' && { error: r.error, code: r.code ?? undefined }),
    }));
    const successCount = results.filter((r) => r.success).length;
    return res.json({
      message: `${successCount}/${runs.length} template dijalankan.`,
      results,
    });
  } catch (error) {
    return handleRouteError(res, error, 'POST /recurring/run-due', 'Gagal menjalankan template berulang.');
  }
});

export default router;
