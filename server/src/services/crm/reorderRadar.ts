/**
 * Reorder radar loader: per active Customer, feed invoice dates into evaluateReorder.
 * Looks back REORDER_LOOKBACK_DAYS so a long-dormant Customer does not keep its old cycle forever.
 */
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { addDays, businessDateOf, startOfBusinessDate } from './businessDate';
import { evaluateReorder, type ReorderResult } from './reorder';
import { ownerClause, type OwnerFilter } from './owner';
import type { CrmSettingsView } from './settings';

type Db = Prisma.TransactionClient | typeof prisma;

export const REORDER_LOOKBACK_DAYS = 730;

export interface ReorderRow extends ReorderResult {
  partyId: string;
  partyName: string;
  phone: string | null;
  salesOwnerId: string | null;
  salesOwnerName: string | null;
  /** null when the viewer may not see sales invoice amounts (see redactReorderRows). */
  avgOrderValue: number | null;
  lastContactOn: string | null;
  snoozedUntil: string | null;
}

export interface ReorderFilter extends OwnerFilter {
  partyId?: string;
}

export async function loadReorderRadar(
  settings: CrmSettingsView,
  filter: ReorderFilter = {},
  now: Date = new Date(),
  db: Db = prisma,
): Promise<ReorderRow[]> {
  const today = businessDateOf(now);
  const since = startOfBusinessDate(addDays(today, -REORDER_LOOKBACK_DAYS));

  const parties = await db.party.findMany({
    where: {
      isActive: true,
      partyType: { in: ['Customer', 'Both'] },
      ...(filter.partyId ? { id: filter.partyId } : {}),
      ...ownerClause(filter),
      salesInvoices: { some: { status: { notIn: ['Draft', 'Cancelled'] }, date: { gte: since } } },
    },
    select: {
      id: true,
      name: true,
      phone: true,
      reorderCycleDays: true,
      reorderSnoozedUntil: true,
      salesOwnerId: true,
      salesOwner: { select: { fullName: true } },
      contacts: { where: { isPrimary: true, phone: { not: null } }, select: { phone: true }, take: 1 },
      salesInvoices: {
        where: { status: { notIn: ['Draft', 'Cancelled'] }, date: { gte: since } },
        select: { date: true, grandTotal: true },
      },
      crmActivities: { orderBy: { occurredAt: 'desc' }, select: { occurredAt: true }, take: 1 },
    },
  });

  return parties.map((p) => {
    const lastContactOn = p.crmActivities[0] ? businessDateOf(p.crmActivities[0].occurredAt) : null;
    const snoozedUntil = p.reorderSnoozedUntil ? businessDateOf(p.reorderSnoozedUntil) : null;
    const total = p.salesInvoices.reduce((sum, inv) => sum.plus(inv.grandTotal.toString()), new Decimal(0));
    const result = evaluateReorder({
      orderDates: p.salesInvoices.map((inv) => businessDateOf(inv.date)),
      manualCycleDays: p.reorderCycleDays,
      minInvoices: settings.reorderMinInvoices,
      toleranceFactor: settings.reorderToleranceFactor,
      today,
      snoozedUntil,
      lastContactOn,
    });
    return {
      ...result,
      partyId: p.id,
      partyName: p.name,
      phone: p.contacts[0]?.phone ?? p.phone,
      salesOwnerId: p.salesOwnerId,
      salesOwnerName: p.salesOwner?.fullName ?? null,
      avgOrderValue: p.salesInvoices.length ? total.div(p.salesInvoices.length).toDecimalPlaces(0).toNumber() : 0,
      lastContactOn,
      snoozedUntil,
    };
  });
}

/** Late first (most overdue on top), then the rest by days until late. */
export function sortReorderRows(rows: ReorderRow[]): ReorderRow[] {
  const rank: Record<ReorderRow['state'], number> = { late: 0, ok: 1, snoozed: 2, insufficient: 3 };
  return [...rows].sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      b.overdueDays - a.overdueDays ||
      (a.lateAfter ?? '9999').localeCompare(b.lateAfter ?? '9999') ||
      a.partyName.localeCompare(b.partyName),
  );
}

/** Remove invoice-derived amounts for viewers without sales invoice access. */
export function redactReorderRows(rows: ReorderRow[], canSeeInvoices: boolean): ReorderRow[] {
  return canSeeInvoices ? rows : rows.map((r) => ({ ...r, avgOrderValue: null }));
}
