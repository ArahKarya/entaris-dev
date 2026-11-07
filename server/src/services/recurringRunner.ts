import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { runDueTemplates } from './recurringExecute';

/**
 * Resolve the user id under which scheduled (non-HTTP) executions should be
 * recorded. Use the first active Admin — same convention as audit-trail
 * automated entries.
 */
async function resolveSchedulerUserId(): Promise<string | null> {
  const admin = await prisma.user.findFirst({
    where: { role: 'Admin', isActive: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return admin?.id ?? null;
}

/**
 * Daily scheduler entry: run every due template through the one execution path
 * (services/recurringExecute.ts). Each template runs in its own transaction, a failing one is
 * recorded on the template and notified, and the batch continues. Returns counters for logging.
 */
export async function runDueRecurringTemplates(now: Date = new Date()): Promise<{
  executed: number;
  failed: number;
  skipped: number;
}> {
  const userId = await resolveSchedulerUserId();
  if (!userId) {
    logger.warn('Recurring runner: no active Admin user to attribute scheduled entries — skipping');
    return { executed: 0, failed: 0, skipped: 0 };
  }

  const results = await runDueTemplates(userId, now);
  const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
  return { executed: count('posted'), failed: count('failed'), skipped: count('skipped') };
}
