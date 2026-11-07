// Runs recurring templates (E2-R3, E7-R5, plan PR-4.5a). The one execution path: the manual run
// (POST /recurring/:id/execute), the due run (POST /recurring/run-due) and the daily scheduler
// (services/recurringRunner.ts) all come here, and a journal template posts through postJournal:
// the one line validator, the fiscal year of the run day, TEMPLATE_RULE (no control or tax
// account) and the party rule 'strict' (a template carries no party, owner decision #3).
// A run that fails posts nothing, keeps the schedule where it was, stores the reason on the
// template (lastError) and notifies Admin and Accountant once per template per business day, so a
// failing template is never a silent stop. The next successful run clears the reason.
// A template runs at most once per business day (owner decision #8, plan step 5 PR-5.6): while an
// active journal carries that day's sourceKey, a manual run answers already_ran and the due run
// not_due, without recording a failure. Cancelling that journal allows the run again.

import type { Prisma, RecurringTemplate } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { BusinessError } from '../utils/errors';
import { businessToday } from '../utils/businessDate';
import { JournalTemplateDataSchema } from '../utils/schemas';
import { RECURRING_TYPE_MISMATCH, RECURRING_TYPE_UNSUPPORTED } from '../utils/recurringRules';
import { TEMPLATE_RULE } from './ledger/accountGuard';
import { sourceKeys } from './ledger/journalSource';
import { postJournal, type PostedJournal } from './ledger/postJournal';
import { notifyUsers } from './notificationService';

type Tx = Prisma.TransactionClient;

/** Notification type of a failed template run (client label: shell notifications.types). */
export const RECURRING_FAILED_NOTIFICATION = 'recurring_failed';

const FALLBACK_ERROR = 'Gagal mengeksekusi template.';

/** Next run after `fromDate` by frequency; a monthly or quarterly day of month is capped at the month's last day. */
export function calculateNextRunDate(frequency: string, fromDate: Date, dayOfMonth?: number | null): Date {
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

export interface ExecuteTemplateOptions {
  userId: string;
  /** Business day of the run (YYYY-MM-DD): the journal's date and the day in its sourceKey. */
  runDate: string;
}

/**
 * Posts one run of a journal template in the caller's transaction. The stored data is checked
 * again (it may predate the save-time rules): its shape, then everything postJournal checks.
 * Throws BusinessError with the rule's code; nothing is written then.
 */
export async function executeJournalTemplateInTx(
  tx: Tx,
  template: Pick<RecurringTemplate, 'id' | 'templateType' | 'templateData'>,
  opts: ExecuteTemplateOptions,
): Promise<PostedJournal> {
  if (template.templateType !== 'journal') {
    throw new BusinessError(`Eksekusi otomatis untuk tipe ${template.templateType} belum didukung. Gunakan tipe journal.`, RECURRING_TYPE_UNSUPPORTED);
  }
  const parsed = JournalTemplateDataSchema.safeParse(template.templateData);
  if (!parsed.success) {
    throw new BusinessError(`Data template tidak sesuai dengan tipe ${template.templateType}: ${parsed.error.issues[0].message}`, RECURRING_TYPE_MISMATCH);
  }
  const data = parsed.data;
  return postJournal(tx, {
    date: new Date(`${opts.runDate}T00:00:00.000Z`),
    narration: data.narration,
    lines: data.items.map((item) => ({
      accountId: item.accountId,
      debit: item.debit,
      credit: item.credit,
      partyId: item.partyId ?? null,
      description: item.description || data.narration,
    })),
    sourceType: 'RECURRING',
    sourceKey: sourceKeys.recurring(template.id, opts.runDate),
    createdBy: opts.userId,
    accountRule: TEMPLATE_RULE,
    partyRule: 'strict',
    partyEffect: 'none',
  });
}

export type TemplateRun =
  | { outcome: 'posted'; journal: PostedJournal['journal'] }
  /** A manual run on a day that already has an active journal of this template: nothing posted. */
  | { outcome: 'already_ran'; journal: PostedJournal['journal'] }
  | { outcome: 'failed'; code: string | null; message: string; error: unknown }
  | { outcome: 'not_due' }
  | { outcome: 'not_found' };

export interface RunTemplateOptions {
  userId: string;
  now?: Date;
  /** Due run: post only while the template is still active and due once its row is locked. */
  onlyIfDue?: boolean;
}

/**
 * Runs one template in its own transaction: the template row is locked first, so a manual run and
 * the due run never post from the same stale row, then the journal is posted and the schedule
 * moves one period from now. A day that already has an active journal of the template posts
 * nothing and moves nothing (already_ran, or not_due for the due run). A failure is recorded
 * (recordTemplateFailure) and returned, never thrown.
 */
export async function runRecurringTemplate(templateId: string, opts: RunTemplateOptions): Promise<TemplateRun> {
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx: Tx): Promise<TemplateRun> => {
      await tx.$queryRaw`SELECT id FROM recurring_templates WHERE id = ${templateId} FOR UPDATE`;
      const template = await tx.recurringTemplate.findUnique({ where: { id: templateId } });
      if (!template) return { outcome: 'not_found' };
      if (opts.onlyIfDue && (!template.isActive || template.nextRunDate > now)) return { outcome: 'not_due' };

      const runDate = businessToday(now);
      // Read under the template lock, so two runs of the same template cannot both miss it.
      const ran = await tx.journalEntry.findFirst({
        where: { sourceKey: sourceKeys.recurring(template.id, runDate), status: { not: 'Cancelled' } },
        include: { items: true },
      });
      if (ran) return opts.onlyIfDue ? { outcome: 'not_due' } : { outcome: 'already_ran', journal: ran };

      const { journal } = await executeJournalTemplateInTx(tx, template, { userId: opts.userId, runDate });
      await tx.recurringTemplate.update({
        where: { id: template.id },
        data: {
          lastRunDate: now,
          nextRunDate: calculateNextRunDate(template.frequency, now, template.dayOfMonth),
          lastError: null,
          lastErrorAt: null,
        },
      });
      return { outcome: 'posted', journal };
    }, { timeout: 15000 });
  } catch (error) {
    const failure = describeFailure(error);
    await recordTemplateFailure(templateId, failure.message, now, error);
    return { outcome: 'failed', ...failure, error };
  }
}

/** A BusinessError keeps its message and code; anything else is logged and stored as the generic message. */
function describeFailure(error: unknown): { code: string | null; message: string } {
  if (error instanceof BusinessError) return { code: error.code ?? null, message: error.message };
  return { code: null, message: FALLBACK_ERROR };
}

/**
 * Stores the reason on the template and notifies Admin and Accountant, at most once per template
 * per business day. Never throws: the run already failed, and its caller reports that.
 */
async function recordTemplateFailure(templateId: string, message: string, now: Date, error: unknown): Promise<void> {
  if (error instanceof BusinessError) logger.warn({ templateId, code: error.code, message }, 'Recurring template not posted');
  else logger.error({ err: error, templateId }, 'Recurring template execution failed');
  try {
    const template = await prisma.recurringTemplate.update({
      where: { id: templateId },
      data: { lastError: message, lastErrorAt: now },
      select: { id: true, name: true },
    });
    const today = businessToday(now);
    // Keyed on the run's business day in the metadata, not on createdAt, so the day is the run's own.
    const already = await prisma.notification.count({
      where: {
        type: RECURRING_FAILED_NOTIFICATION,
        AND: [{ metadata: { path: ['templateId'], equals: template.id } }, { metadata: { path: ['day'], equals: today } }],
      },
    });
    if (already > 0) return;
    const users = await prisma.user.findMany({
      where: { isActive: true, role: { in: ['Admin', 'Accountant'] } },
      select: { id: true },
    });
    await notifyUsers(prisma, {
      userIds: users.map((u) => u.id),
      type: RECURRING_FAILED_NOTIFICATION,
      title: 'Transaksi Berulang Gagal',
      message: `Template "${template.name}" tidak diposting: ${message} Jadwalnya tidak maju sampai template diperbaiki.`,
      metadata: { templateId: template.id, day: today, link: '/recurring' },
    });
  } catch (err) {
    // A template that no longer exists (or a failing write) leaves nothing to record.
    logger.error({ err, templateId }, 'Recording a recurring template failure failed');
  }
}

export interface DueRunResult {
  templateId: string;
  name: string;
  outcome: 'posted' | 'failed' | 'skipped';
  code?: string | null;
  error?: string;
}

/**
 * Runs every active template that is due at `now`, each in its own transaction, so one failure
 * does not stop the others. Only journal templates run; other types are skipped (reported, not
 * recorded as a failure, since they have no automatic execution at all).
 */
export async function runDueTemplates(userId: string, now: Date = new Date()): Promise<DueRunResult[]> {
  const due = await prisma.recurringTemplate.findMany({
    where: { isActive: true, nextRunDate: { lte: now } },
    select: { id: true, name: true, templateType: true },
    orderBy: [{ nextRunDate: 'asc' }, { id: 'asc' }],
  });
  const results: DueRunResult[] = [];
  for (const template of due) {
    const base = { templateId: template.id, name: template.name };
    if (template.templateType !== 'journal') {
      results.push({
        ...base,
        outcome: 'skipped',
        code: RECURRING_TYPE_UNSUPPORTED,
        error: `Eksekusi otomatis untuk tipe ${template.templateType} belum didukung. Gunakan tipe journal.`,
      });
      continue;
    }
    const run = await runRecurringTemplate(template.id, { userId, now, onlyIfDue: true });
    if (run.outcome === 'posted') results.push({ ...base, outcome: 'posted' });
    else if (run.outcome === 'failed') results.push({ ...base, outcome: 'failed', code: run.code, error: run.message });
    // not_due / not_found: run or changed by someone else after the list was read.
  }
  return results;
}
