/** CRM client: types mirroring /api/crm, query keys, and small helpers. */
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

export const FOLLOWUP_KINDS = ['inquiry', 'party', 'quotation', 'reorder'] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const ACTIVITY_TYPES = ['Telepon', 'WhatsApp', 'Kunjungan', 'Email', 'Catatan'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface FollowupItem {
  kind: FollowupKind;
  id: string;
  partyId: string | null;
  partyName: string;
  title: string;
  documentNumber: string | null;
  dueOn: string;
  referenceDate: string | null;
  overdueDays: number;
  ownerId: string | null;
  ownerName: string | null;
  phone: string | null;
  note: string | null;
}

export interface FollowupResult {
  today: string;
  items: FollowupItem[];
  counts: Record<FollowupKind, number>;
}

export type ReorderState = 'late' | 'ok' | 'snoozed' | 'insufficient';

export interface ReorderRow {
  partyId: string;
  partyName: string;
  phone: string | null;
  state: ReorderState;
  orderCount: number;
  lastOrderOn: string | null;
  avgIntervalDays: number | null;
  cycleDays: number | null;
  cycleSource: 'manual' | 'average' | null;
  daysSinceLastOrder: number | null;
  lateAfter: string | null;
  overdueDays: number;
  contactedSinceLate: boolean;
  avgOrderValue: number;
  salesOwnerId: string | null;
  salesOwnerName: string | null;
  lastContactOn: string | null;
  snoozedUntil: string | null;
}

export interface PartyContact {
  id: string;
  partyId: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  notes: string | null;
}

export interface CrmActivity {
  id: string;
  type: ActivityType;
  summary: string;
  outcome: string | null;
  occurredAt: string;
  nextFollowUpDate: string | null;
  followUpDoneAt: string | null;
  source: 'form' | 'aira';
  party: { id: string; name: string } | null;
  inquiry: { id: string; inquiryNumber: string; prospectName: string } | null;
  contact: { id: string; name: string; phone: string | null } | null;
  creator: { id: string; fullName: string };
}

export interface SalesUser {
  id: string;
  fullName: string;
}

export interface CrmSettings {
  reminderEnabled: boolean;
  reminderTime: string;
  reminderDays: number[];
  quotationNoReplyDays: number;
  reorderToleranceFactor: number;
  reorderMinInvoices: number;
  lastReminderOn: string | null;
}

export interface PartyOverview {
  party: {
    id: string;
    name: string;
    partyType: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    isActive: boolean;
    outstandingAmount: number | null;
    salesOwnerId: string | null;
    salesOwner: SalesUser | null;
    reorderCycleDays: number | null;
    reorderSnoozedUntil: string | null;
  };
  contacts: PartyContact[];
  activities: CrmActivity[];
  activityTotal: number;
  inquiries: {
    id: string;
    inquiryNumber: string;
    date: string;
    status: string;
    followUpDate: string | null;
    followUpDoneAt: string | null;
    itemsText: string | null;
    salesOwner: SalesUser | null;
  }[];
  quotations: {
    id: string;
    quotationNumber: string;
    date: string;
    status: string;
    grandTotal: string;
    sentAt: string | null;
    validUntil: string;
  }[];
  purchases: {
    last12MonthsTotal: number | null;
    last12MonthsCount: number;
    lastInvoice: { id: string; invoiceNumber: string; date: string; grandTotal: number | null } | null;
  };
  reorder: ReorderRow | null;
}

export const crmKeys = {
  all: ['crm'] as const,
  followups: (ownerId: string) => ['crm', 'followups', ownerId] as const,
  radar: (ownerId: string) => ['crm', 'radar', ownerId] as const,
  overview: (partyId: string) => ['crm', 'overview', partyId] as const,
  activities: (scope: { partyId?: string; inquiryId?: string }) => ['crm', 'activities', scope] as const,
  salesUsers: ['crm', 'sales-users'] as const,
  settings: ['crm', 'settings'] as const,
};

export function useSalesUsers(enabled = true) {
  return useQuery({
    queryKey: crmKeys.salesUsers,
    queryFn: async () => (await api.get<SalesUser[]>('/crm/sales-users')).data,
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/** Digits-only international number (62xxx) for wa.me; null when the number cannot be used. */
export function toWhatsappNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const normalized = digits.startsWith('62') ? digits : digits.startsWith('0') ? `62${digits.slice(1)}` : digits.startsWith('8') ? `62${digits}` : digits;
  return normalized.length >= 9 && normalized.length <= 15 ? normalized : null;
}

export function whatsappUrl(raw: string | null | undefined): string | null {
  const number = toWhatsappNumber(raw);
  return number ? `https://wa.me/${number}` : null;
}

/** Today in the browser's calendar as YYYY-MM-DD (the user's own day). */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Id of the signed-in user (stored at login), or null. */
export function currentUserId(): string | null {
  try {
    return (JSON.parse(localStorage.getItem('user') || 'null') as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}
