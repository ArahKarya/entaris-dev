/**
 * Morning reminder (CRM F3). The scheduler calls this every few minutes; it sends once per business
 * day, at or after the configured time on the configured weekdays, within SEND_WINDOW_MINUTES (a
 * server that was down all morning does not send a stale reminder in the afternoon).
 * Each user with CRM access gets their own list (own items plus unowned ones) as an in-app
 * notification, echoed to their linked Telegram by notifyUsers.
 */
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { notifyUsers } from '../notificationService';
import { can } from '../permissionService';
import { businessDateOf, businessIsoWeekday, businessMinuteOfDay, parseClock } from './businessDate';
import { loadFollowups, type FollowupItem, type FollowupResult } from './followups';
import { getCrmSettings, type CrmSettingsView } from './settings';

export const SEND_WINDOW_MINUTES = 180;
export const REMINDER_TOP_ITEMS = 10;
export const CRM_REMINDER_TYPE = 'crm_followup_digest';

/** Pure: is it time to send today's reminder? */
export function isReminderDue(settings: CrmSettingsView, now: Date): boolean {
  if (!settings.reminderEnabled) return false;
  const today = businessDateOf(now);
  if (settings.lastReminderOn === today) return false;
  if (!settings.reminderDays.includes(businessIsoWeekday(now))) return false;
  const at = parseClock(settings.reminderTime);
  if (at === null) return false;
  const minute = businessMinuteOfDay(now);
  return minute >= at && minute < at + SEND_WINDOW_MINUTES;
}

const KIND_LABEL: Record<FollowupItem['kind'], string> = {
  inquiry: 'Inquiry',
  party: 'Follow-up',
  quotation: 'Quotation',
  reorder: 'Telat order',
};

/** Pure: the reminder text for one user, or null when there is nothing to do. */
export function formatReminder(result: FollowupResult): { title: string; message: string } | null {
  const { counts, items } = result;
  const total = items.length;
  if (total === 0) return null;
  const parts = [
    counts.inquiry ? `${counts.inquiry} inquiry` : null,
    counts.party ? `${counts.party} follow-up Customer` : null,
    counts.quotation ? `${counts.quotation} Quotation tanpa jawaban` : null,
    counts.reorder ? `${counts.reorder} Customer telat order` : null,
  ].filter(Boolean);
  const top = [...items]
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, REMINDER_TOP_ITEMS)
    .map((it) => {
      const late = it.overdueDays > 0 ? ` (lewat ${it.overdueDays} hari)` : '';
      const doc = it.documentNumber ? ` ${it.documentNumber}` : '';
      return `- ${KIND_LABEL[it.kind]}${doc}: ${it.partyName}${late}`;
    });
  const more = total > REMINDER_TOP_ITEMS ? `\n...dan ${total - REMINDER_TOP_ITEMS} lainnya.` : '';
  return {
    title: `Tindak lanjut hari ini: ${total}`,
    message: `${parts.join(', ')}.\n${top.join('\n')}${more}\nBuka menu Tindak Lanjut di Entaris.`,
  };
}

async function recipients(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, role: true } });
  const allowed: string[] = [];
  for (const u of users) {
    if (await can(u.role, 'crm', 'view')) allowed.push(u.id);
  }
  return allowed;
}

/** Returns the number of users notified (0 when not due or already sent today). */
export async function runCrmMorningReminder(now: Date = new Date()): Promise<number> {
  const settings = await getCrmSettings();
  if (!isReminderDue(settings, now)) return 0;
  const today = businessDateOf(now);

  // Claim the day first so two instances never both send.
  const claimed = await prisma.crmSetting.updateMany({
    where: { slug: 'default', OR: [{ lastReminderOn: null }, { lastReminderOn: { not: today } }] },
    data: { lastReminderOn: today },
  });
  if (claimed.count === 0) return 0;

  let sent = 0;
  for (const userId of await recipients()) {
    try {
      const result = await loadFollowups(settings, { ownerId: userId }, now);
      const text = formatReminder(result);
      if (!text) continue;
      sent += await notifyUsers(prisma, {
        userIds: [userId],
        type: CRM_REMINDER_TYPE,
        title: text.title,
        message: text.message,
        metadata: { date: today, counts: { ...result.counts }, link: '/crm' },
      });
    } catch (err) {
      logger.error({ err, userId }, 'CRM morning reminder failed for user');
    }
  }
  return sent;
}
