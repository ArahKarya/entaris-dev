/**
 * Integration test: CRM follow-ups against a real database.
 * A repeat Customer with a 14-day cycle goes late, shows on the follow-up list, drops off once
 * contacted; an Inquiry follow-up closes when an activity is logged without a next date.
 * Everything runs in one transaction rolled back by a sentinel.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { createActivityInTx, settleFollowup } from '../../services/crm/activities';
import { addDays, businessDateOf } from '../../services/crm/businessDate';
import { loadFollowups } from '../../services/crm/followups';
import { loadReorderRadar } from '../../services/crm/reorderRadar';
import type { CrmSettingsView } from '../../services/crm/settings';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;

const settings: CrmSettingsView = {
  reminderEnabled: true,
  reminderTime: '07:30',
  reminderDays: [1, 2, 3, 4, 5, 6],
  quotationNoReplyDays: 3,
  reorderToleranceFactor: 1.5,
  reorderMinInvoices: 3,
  lastReminderOn: null,
};

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool as any);
  prisma = new PrismaClient({ adapter });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

d('CRM follow-ups', () => {
  it('flags a late repeat Customer and clears it once contacted', async () => {
    const now = new Date();
    const today = businessDateOf(now);
    try {
      await prisma.$transaction(async (tx) => {
        const party = await tx.party.create({
          data: { name: `TEST-CRM-${Date.now()}`, partyType: 'Customer', isActive: true, salesOwnerId: userId },
        });
        // Orders every 14 days, last one 28 days ago: late after 28 - 21 = 7 days ago.
        for (const back of [70, 56, 42, 28]) {
          await submitSalesInvoiceInTx(
            tx,
            {
              date: addDays(today, -back),
              partyId: party.id,
              items: [{ itemName: 'Jasa (crm test)', itemType: 'service', quantity: 1, rate: 1_000_000 }],
            },
            userId,
          );
        }

        const [radar] = await loadReorderRadar(settings, { partyId: party.id }, now, tx);
        expect(radar.state).toBe('late');
        expect(radar.cycleDays).toBe(14);
        expect(radar.overdueDays).toBe(7);
        expect(radar.avgOrderValue).toBe(1_000_000);

        const before = await loadFollowups(settings, { ownerId: userId, kinds: ['reorder', 'party'] }, now, tx);
        expect(before.items.some((i) => i.kind === 'reorder' && i.id === party.id)).toBe(true);

        // Contact today with a follow-up date today: off the reorder list, onto the party list.
        const activity = await createActivityInTx(
          tx,
          { partyId: party.id, type: 'WhatsApp', summary: 'Tanya rencana order', nextFollowUpDate: today },
          userId,
          now,
        );
        const after = await loadFollowups(settings, { ownerId: userId, kinds: ['reorder', 'party'] }, now, tx);
        expect(after.items.some((i) => i.kind === 'reorder' && i.id === party.id)).toBe(false);
        expect(after.items.some((i) => i.kind === 'party' && i.id === activity.id)).toBe(true);

        // Strict owner filter for another user hides it; the reminder uses strictOwner=false.
        const other = await loadFollowups(settings, { ownerId: '00000000-0000-0000-0000-000000000000', strictOwner: true, kinds: ['party'] }, now, tx);
        expect(other.items.some((i) => i.id === activity.id)).toBe(false);

        // A note without a next date leaves a follow-up planned for a later day open.
        const planned = await createActivityInTx(
          tx,
          { partyId: party.id, type: 'Telepon', summary: 'Janji telepon minggu depan', nextFollowUpDate: addDays(today, 5) },
          userId,
          now,
        );
        await createActivityInTx(tx, { partyId: party.id, type: 'Catatan', summary: 'Catatan saja' }, userId, now);
        const plannedAfter = await tx.crmActivity.findUniqueOrThrow({ where: { id: planned.id } });
        expect(plannedAfter.followUpDoneAt).toBeNull();
        // ...while the follow-up due today was closed by the planned call above.
        const todayAfter = await tx.crmActivity.findUniqueOrThrow({ where: { id: activity.id } });
        expect(todayAfter.followUpDoneAt).not.toBeNull();

        await expect(settleFollowup(tx, { kind: 'party', id: planned.id }, now)).resolves.toBeUndefined();
        const settled = await loadFollowups(settings, { ownerId: userId, kinds: ['party'] }, now, tx);
        expect(settled.items.some((i) => i.id === activity.id || i.id === planned.id)).toBe(false);

        throw new RollbackSentinel();
      });
    } catch (e) {
      if (!(e instanceof RollbackSentinel)) throw e;
    }
  });

  it('closes an Inquiry follow-up when an activity is logged without a next date', async () => {
    const now = new Date();
    const today = businessDateOf(now);
    try {
      await prisma.$transaction(async (tx) => {
        const fy = await tx.fiscalYear.findFirst({ where: { isClosed: false }, orderBy: { startDate: 'desc' } });
        if (!fy) throw new Error('No open fiscal year.');
        const inquiry = await tx.inquiry.create({
          data: {
            inquiryNumber: `INQ-TEST-${Date.now()}`,
            date: new Date(addDays(today, -3)),
            status: 'Baru',
            channel: 'WhatsApp',
            prospectName: 'Prospek uji CRM',
            followUpDate: new Date(addDays(today, -1)),
            fiscalYearId: fy.id,
            createdBy: userId,
            salesOwnerId: userId,
          },
        });

        const due = await loadFollowups(settings, { ownerId: userId, kinds: ['inquiry'] }, now, tx);
        const item = due.items.find((i) => i.id === inquiry.id);
        expect(item?.overdueDays).toBe(1);

        await createActivityInTx(tx, { inquiryId: inquiry.id, type: 'Telepon', summary: 'Sudah ditelepon' }, userId, now);
        const updated = await tx.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
        expect(updated.status).toBe('Diproses');
        expect(updated.followUpDoneAt).not.toBeNull();

        const after = await loadFollowups(settings, { ownerId: userId, kinds: ['inquiry'] }, now, tx);
        expect(after.items.some((i) => i.id === inquiry.id)).toBe(false);

        // A next date reopens it on that date.
        await createActivityInTx(
          tx,
          { inquiryId: inquiry.id, type: 'WhatsApp', summary: 'Minta dihubungi lagi', nextFollowUpDate: today },
          userId,
          now,
        );
        const reopened = await loadFollowups(settings, { ownerId: userId, kinds: ['inquiry'] }, now, tx);
        expect(reopened.items.some((i) => i.id === inquiry.id)).toBe(true);

        throw new RollbackSentinel();
      });
    } catch (e) {
      if (!(e instanceof RollbackSentinel)) throw e;
    }
  });
});
