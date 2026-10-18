/** CRM settings singleton (slug 'default'), created with defaults on first read. */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CrmSettingsView {
  reminderEnabled: boolean;
  reminderTime: string;
  reminderDays: number[];
  quotationNoReplyDays: number;
  reorderToleranceFactor: number;
  reorderMinInvoices: number;
  lastReminderOn: string | null;
}

export async function getCrmSettings(db: Db = prisma): Promise<CrmSettingsView> {
  const row = await db.crmSetting.upsert({ where: { slug: 'default' }, create: { slug: 'default' }, update: {} });
  return {
    reminderEnabled: row.reminderEnabled,
    reminderTime: row.reminderTime,
    reminderDays: [...row.reminderDays].sort((a, b) => a - b),
    quotationNoReplyDays: row.quotationNoReplyDays,
    reorderToleranceFactor: Number(row.reorderToleranceFactor),
    reorderMinInvoices: row.reorderMinInvoices,
    lastReminderOn: row.lastReminderOn,
  };
}
