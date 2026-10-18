/**
 * Follow-up list (CRM F1): one place for everything a salesperson should act on today.
 *   inquiry        active Inquiry whose follow-up date is today or earlier and not marked done
 *   party          follow-up date set on a Customer activity (no Inquiry), not marked done
 *   quotation      Quotation sent N+ days ago with no answer and no contact in the last N days
 *   reorder        repeat Customer late for their next order and not contacted since
 * Owner filter: a user sees items they own plus items with no owner, so nothing falls through.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addDays, businessDateOf, daysBetween, startOfBusinessDate } from './businessDate';
import { loadReorderRadar, sortReorderRows } from './reorderRadar';
import { ownerClause, type OwnerFilter } from './owner';
import type { CrmSettingsView } from './settings';

type Db = Prisma.TransactionClient | typeof prisma;

export const FOLLOWUP_KINDS = ['inquiry', 'party', 'quotation', 'reorder'] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export interface FollowupItem {
  kind: FollowupKind;
  /** Inquiry id, CrmActivity id, Quotation id, or Party id (reorder). */
  id: string;
  partyId: string | null;
  partyName: string;
  title: string;
  /** Inquiry/Quotation number when there is one. */
  documentNumber: string | null;
  dueOn: string;
  /** Quotation: date sent. Reorder: last order date. Otherwise null. */
  referenceDate: string | null;
  overdueDays: number;
  ownerId: string | null;
  ownerName: string | null;
  phone: string | null;
  note: string | null;
}

export interface FollowupFilter extends OwnerFilter {
  kinds?: FollowupKind[];
}

export interface FollowupResult {
  today: string;
  items: FollowupItem[];
  counts: Record<FollowupKind, number>;
}

function primaryPhone(party: { phone: string | null; contacts: { phone: string | null }[] } | null): string | null {
  if (!party) return null;
  return party.contacts[0]?.phone ?? party.phone;
}

const partySelect = {
  id: true,
  name: true,
  phone: true,
  salesOwnerId: true,
  salesOwner: { select: { fullName: true } },
  contacts: { where: { isPrimary: true, phone: { not: null } }, select: { phone: true }, take: 1 },
} satisfies Prisma.PartySelect;

async function loadInquiryItems(db: Db, filter: FollowupFilter, today: string): Promise<FollowupItem[]> {
  const rows = await db.inquiry.findMany({
    where: {
      status: { in: ['Baru', 'Diproses'] },
      followUpDate: { lt: startOfBusinessDate(addDays(today, 1)) },
      followUpDoneAt: null,
      ...ownerClause(filter),
    },
    select: {
      id: true,
      inquiryNumber: true,
      prospectName: true,
      prospectPhone: true,
      followUpDate: true,
      notes: true,
      itemsText: true,
      salesOwnerId: true,
      salesOwner: { select: { fullName: true } },
      party: { select: partySelect },
    },
    orderBy: { followUpDate: 'asc' },
    take: 500,
  });
  return rows.map((r) => {
    const dueOn = businessDateOf(r.followUpDate as Date);
    return {
      kind: 'inquiry',
      id: r.id,
      partyId: r.party?.id ?? null,
      partyName: r.party?.name ?? r.prospectName,
      title: r.itemsText?.slice(0, 120) || r.notes?.slice(0, 120) || r.inquiryNumber,
      documentNumber: r.inquiryNumber,
      dueOn,
      referenceDate: null,
      overdueDays: Math.max(0, daysBetween(dueOn, today)),
      ownerId: r.salesOwnerId,
      ownerName: r.salesOwner?.fullName ?? null,
      phone: primaryPhone(r.party) ?? r.prospectPhone,
      note: r.notes,
    };
  });
}

async function loadPartyFollowupItems(db: Db, filter: FollowupFilter, today: string): Promise<FollowupItem[]> {
  const rows = await db.crmActivity.findMany({
    where: {
      inquiryId: null,
      partyId: { not: null },
      nextFollowUpDate: { lt: startOfBusinessDate(addDays(today, 1)) },
      followUpDoneAt: null,
      ...(filter.ownerId ? { party: ownerClause(filter) } : {}),
    },
    select: {
      id: true,
      summary: true,
      outcome: true,
      nextFollowUpDate: true,
      party: { select: partySelect },
      contact: { select: { phone: true } },
    },
    orderBy: { nextFollowUpDate: 'asc' },
    take: 500,
  });
  return rows.map((r) => {
    const dueOn = businessDateOf(r.nextFollowUpDate as Date);
    return {
      kind: 'party',
      id: r.id,
      partyId: r.party?.id ?? null,
      partyName: r.party?.name ?? '',
      title: r.summary.slice(0, 120),
      documentNumber: null,
      dueOn,
      referenceDate: null,
      overdueDays: Math.max(0, daysBetween(dueOn, today)),
      ownerId: r.party?.salesOwnerId ?? null,
      ownerName: r.party?.salesOwner?.fullName ?? null,
      phone: r.contact?.phone ?? primaryPhone(r.party),
      note: r.outcome,
    };
  });
}

async function loadQuotationItems(
  db: Db,
  filter: FollowupFilter,
  today: string,
  settings: CrmSettingsView,
): Promise<FollowupItem[]> {
  const days = settings.quotationNoReplyDays;
  const cutoff = startOfBusinessDate(addDays(today, -days + 1));
  const rows = await db.quotation.findMany({
    where: {
      status: 'Sent',
      sentAt: { lt: cutoff },
      ...(filter.ownerId ? { customer: ownerClause(filter) } : {}),
    },
    select: {
      id: true,
      quotationNumber: true,
      sentAt: true,
      grandTotal: true,
      validUntil: true,
      customer: {
        select: {
          ...partySelect,
          crmActivities: { orderBy: { occurredAt: 'desc' }, select: { occurredAt: true }, take: 1 },
        },
      },
    },
    orderBy: { sentAt: 'asc' },
    take: 500,
  });
  return rows
    .filter((r) => {
      const last = r.customer.crmActivities[0]?.occurredAt;
      return !last || last < cutoff;
    })
    .map((r) => {
      const sentOn = businessDateOf(r.sentAt as Date);
      const dueOn = addDays(sentOn, days);
      return {
        kind: 'quotation',
        id: r.id,
        partyId: r.customer.id,
        partyName: r.customer.name,
        title: r.quotationNumber,
        documentNumber: r.quotationNumber,
        dueOn,
        referenceDate: sentOn,
        overdueDays: Math.max(0, daysBetween(dueOn, today)),
        ownerId: r.customer.salesOwnerId,
        ownerName: r.customer.salesOwner?.fullName ?? null,
        phone: primaryPhone(r.customer),
        note: null,
      };
    });
}

async function loadReorderItems(
  db: Db,
  filter: FollowupFilter,
  settings: CrmSettingsView,
  now: Date,
): Promise<FollowupItem[]> {
  const rows = await loadReorderRadar(settings, filter, now, db);
  return sortReorderRows(rows)
    .filter((r) => r.state === 'late' && !r.contactedSinceLate)
    .map((r) => ({
      kind: 'reorder' as const,
      id: r.partyId,
      partyId: r.partyId,
      partyName: r.partyName,
      title: '',
      documentNumber: null,
      dueOn: r.lateAfter as string,
      referenceDate: r.lastOrderOn,
      overdueDays: r.overdueDays,
      ownerId: r.salesOwnerId,
      ownerName: r.salesOwnerName,
      phone: r.phone,
      note: null,
    }));
}

export async function loadFollowups(
  settings: CrmSettingsView,
  filter: FollowupFilter = {},
  now: Date = new Date(),
  db: Db = prisma,
): Promise<FollowupResult> {
  const today = businessDateOf(now);
  const kinds = new Set<FollowupKind>(filter.kinds?.length ? filter.kinds : FOLLOWUP_KINDS);
  const [inquiries, parties, quotations, reorders] = await Promise.all([
    kinds.has('inquiry') ? loadInquiryItems(db, filter, today) : [],
    kinds.has('party') ? loadPartyFollowupItems(db, filter, today) : [],
    kinds.has('quotation') ? loadQuotationItems(db, filter, today, settings) : [],
    kinds.has('reorder') ? loadReorderItems(db, filter, settings, now) : [],
  ]);
  return {
    today,
    items: [...inquiries, ...parties, ...quotations, ...reorders],
    counts: {
      inquiry: inquiries.length,
      party: parties.length,
      quotation: quotations.length,
      reorder: reorders.length,
    },
  };
}
