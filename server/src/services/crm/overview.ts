/** Customer 360 view (CRM F6): contacts, recent activity, open deals, buying pattern, receivable. */
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { BusinessError } from '../../utils/errors';
import { addDays, businessDateOf, startOfBusinessDate } from './businessDate';
import { activityInclude } from './activities';
import { loadReorderRadar, type ReorderRow } from './reorderRadar';
import type { CrmSettingsView } from './settings';

export const OVERVIEW_ACTIVITY_LIMIT = 10;

export interface OverviewOptions {
  /** Hide money owed when the viewer may not see sales invoices. */
  includeReceivable: boolean;
  now?: Date;
}

export async function loadPartyOverview(partyId: string, settings: CrmSettingsView, opts: OverviewOptions) {
  const now = opts.now ?? new Date();
  const today = businessDateOf(now);
  const yearAgo = startOfBusinessDate(addDays(today, -365));

  const party = await prisma.party.findUnique({
    where: { id: partyId },
    select: {
      id: true,
      name: true,
      partyType: true,
      phone: true,
      email: true,
      address: true,
      isActive: true,
      outstandingAmount: true,
      salesOwnerId: true,
      salesOwner: { select: { id: true, fullName: true } },
      reorderCycleDays: true,
      reorderSnoozedUntil: true,
    },
  });
  if (!party) throw new BusinessError('Customer tidak ditemukan.');

  const invoiceWhere = { partyId, status: { notIn: ['Draft', 'Cancelled'] as ('Draft' | 'Cancelled')[] } };
  const [contacts, activities, activityTotal, inquiries, quotations, yearInvoices, lastInvoice, radar] = await Promise.all([
    prisma.partyContact.findMany({ where: { partyId }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] }),
    prisma.crmActivity.findMany({
      where: { partyId },
      include: activityInclude,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: OVERVIEW_ACTIVITY_LIMIT,
    }),
    prisma.crmActivity.count({ where: { partyId } }),
    prisma.inquiry.findMany({
      where: { partyId, status: { in: ['Baru', 'Diproses'] } },
      select: {
        id: true,
        inquiryNumber: true,
        date: true,
        status: true,
        followUpDate: true,
        followUpDoneAt: true,
        itemsText: true,
        salesOwner: { select: { id: true, fullName: true } },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.quotation.findMany({
      where: { partyId, status: { in: ['Draft', 'Sent'] } },
      select: { id: true, quotationNumber: true, date: true, status: true, grandTotal: true, sentAt: true, validUntil: true },
      orderBy: { date: 'desc' },
    }),
    prisma.salesInvoice.findMany({ where: { ...invoiceWhere, date: { gte: yearAgo } }, select: { grandTotal: true } }),
    prisma.salesInvoice.findFirst({
      where: invoiceWhere,
      orderBy: { date: 'desc' },
      select: { id: true, invoiceNumber: true, date: true, grandTotal: true },
    }),
    loadReorderRadar(settings, { partyId }, now),
  ]);

  const yearTotal = yearInvoices.reduce((sum, inv) => sum.plus(inv.grandTotal.toString()), new Decimal(0));
  const reorder: ReorderRow | null = radar[0] ?? null;

  return {
    party: {
      ...party,
      outstandingAmount: opts.includeReceivable ? Number(party.outstandingAmount) : null,
      reorderSnoozedUntil: party.reorderSnoozedUntil ? businessDateOf(party.reorderSnoozedUntil) : null,
    },
    contacts,
    activities,
    activityTotal,
    inquiries,
    quotations,
    purchases: {
      last12MonthsTotal: opts.includeReceivable ? yearTotal.toNumber() : null,
      last12MonthsCount: yearInvoices.length,
      lastInvoice: lastInvoice
        ? { ...lastInvoice, grandTotal: opts.includeReceivable ? Number(lastInvoice.grandTotal) : null }
        : null,
    },
    reorder,
  };
}
