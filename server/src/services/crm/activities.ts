/**
 * Sales activities (CRM F4/F6). Logging an activity also moves the follow-up along:
 *   on an Inquiry   next date set -> becomes the Inquiry's follow-up date (open again);
 *                   no next date  -> the Inquiry's current follow-up counts as done.
 *                   A new Inquiry (Baru) moves to Diproses.
 *   on a Customer   earlier open Customer follow-ups count as done; a next date opens a new one.
 */
import { CrmActivityType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BusinessError } from '../../utils/errors';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CreateActivityInput {
  partyId?: string | null;
  inquiryId?: string | null;
  contactId?: string | null;
  type: CrmActivityType;
  summary: string;
  outcome?: string | null;
  /** YYYY-MM-DD; defaults to now. */
  occurredAt?: string | null;
  /** YYYY-MM-DD */
  nextFollowUpDate?: string | null;
  source?: 'form' | 'aira';
}

export const activityInclude = {
  party: { select: { id: true, name: true } },
  inquiry: { select: { id: true, inquiryNumber: true, prospectName: true } },
  contact: { select: { id: true, name: true, phone: true } },
  creator: { select: { id: true, fullName: true } },
} satisfies Prisma.CrmActivityInclude;

export type ActivityWithRelations = Prisma.CrmActivityGetPayload<{ include: typeof activityInclude }>;

function dateOnly(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  return d;
}

/** Must run inside a transaction: the activity and the follow-up changes land together. */
export async function createActivityInTx(
  tx: Prisma.TransactionClient,
  input: CreateActivityInput,
  userId: string,
  now: Date = new Date(),
): Promise<ActivityWithRelations> {
  let partyId = input.partyId ?? null;
  const inquiryId = input.inquiryId ?? null;
  if (!partyId && !inquiryId) throw new BusinessError('Aktivitas harus tertaut ke Customer atau Inquiry.');

  if (inquiryId) {
    const inquiry = await tx.inquiry.findUnique({ where: { id: inquiryId } });
    if (!inquiry) throw new BusinessError('Inquiry tidak ditemukan.');
    if (partyId && inquiry.partyId && inquiry.partyId !== partyId) {
      throw new BusinessError('Inquiry tidak milik Customer ini.');
    }
    partyId = partyId ?? inquiry.partyId;
  }
  if (partyId) {
    const party = await tx.party.findUnique({ where: { id: partyId }, select: { id: true } });
    if (!party) throw new BusinessError('Customer tidak ditemukan.');
  }
  if (input.contactId) {
    const contact = await tx.partyContact.findUnique({ where: { id: input.contactId } });
    if (!contact || contact.partyId !== partyId) throw new BusinessError('Kontak tidak milik Customer ini.');
  }

  const nextFollowUpDate = input.nextFollowUpDate ? dateOnly(input.nextFollowUpDate) : null;
  const occurredAt = input.occurredAt ? dateOnly(input.occurredAt) : now;

  if (inquiryId) {
    const inquiry = await tx.inquiry.findUniqueOrThrow({ where: { id: inquiryId } });
    await tx.inquiry.update({
      where: { id: inquiryId },
      data: {
        ...(nextFollowUpDate
          ? { followUpDate: nextFollowUpDate, followUpDoneAt: null }
          : inquiry.followUpDate && !inquiry.followUpDoneAt
            ? { followUpDoneAt: now }
            : {}),
        ...(inquiry.status === 'Baru' ? { status: 'Diproses' as const } : {}),
      },
    });
  } else if (partyId) {
    await tx.crmActivity.updateMany({
      where: { partyId, inquiryId: null, nextFollowUpDate: { not: null }, followUpDoneAt: null },
      data: { followUpDoneAt: now },
    });
  }

  return tx.crmActivity.create({
    data: {
      partyId,
      inquiryId,
      contactId: input.contactId ?? null,
      type: input.type,
      summary: input.summary.trim(),
      outcome: input.outcome?.trim() || null,
      occurredAt,
      nextFollowUpDate,
      source: input.source ?? 'form',
      createdBy: userId,
    },
    include: activityInclude,
  });
}

export interface ActivityListFilter {
  partyId?: string;
  inquiryId?: string;
  page: number;
  take: number;
  skip: number;
}

export async function listActivities(
  filter: ActivityListFilter,
  db: Db = prisma,
): Promise<{ data: ActivityWithRelations[]; total: number }> {
  const where: Prisma.CrmActivityWhereInput = {
    ...(filter.partyId ? { partyId: filter.partyId } : {}),
    ...(filter.inquiryId ? { inquiryId: filter.inquiryId } : {}),
  };
  const [data, total] = await Promise.all([
    db.crmActivity.findMany({
      where,
      include: activityInclude,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      skip: filter.skip,
      take: filter.take,
    }),
    db.crmActivity.count({ where }),
  ]);
  return { data, total };
}

/** Mark a follow-up done, or move it to another date. */
export async function settleFollowup(
  db: Db,
  input: { kind: 'inquiry' | 'party'; id: string; snoozeTo?: string | null },
  now: Date = new Date(),
): Promise<void> {
  const snoozeTo = input.snoozeTo ? dateOnly(input.snoozeTo) : null;
  if (input.kind === 'inquiry') {
    const inquiry = await db.inquiry.findUnique({ where: { id: input.id }, select: { id: true } });
    if (!inquiry) throw new BusinessError('Inquiry tidak ditemukan.');
    await db.inquiry.update({
      where: { id: input.id },
      data: snoozeTo ? { followUpDate: snoozeTo, followUpDoneAt: null } : { followUpDoneAt: now },
    });
    return;
  }
  const activity = await db.crmActivity.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!activity) throw new BusinessError('Aktivitas tidak ditemukan.');
  await db.crmActivity.update({
    where: { id: input.id },
    data: snoozeTo ? { nextFollowUpDate: snoozeTo, followUpDoneAt: null } : { followUpDoneAt: now },
  });
}
