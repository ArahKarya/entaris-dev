/**
 * Monthly period lock on the client (server: GET/PUT /period-lock, services/periodLock.ts).
 * Shared by the card in Pengaturan > Tahun Buku and the General Ledger notice.
 */
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { can, cap } from '@/lib/permissions';
import { formatDate } from '@/lib/format';

interface UserRef { id: string; fullName: string }

export interface PeriodLockLog {
  id: string;
  oldDate: string | null;
  newDate: string | null;
  reason: string | null;
  createdAt: string;
  user: UserRef | null;
}

export interface PeriodLockState {
  lockDate: string | null;
  updatedAt: string | null;
  updatedBy: UserRef | null;
  logs: PeriodLockLog[];
}

/** True when `next` unlocks days that `prev` kept locked (same rule as the server). */
export function movesLockBack(prev: string | null, next: string | null): boolean {
  if (prev === null) return false;
  return next === null || next < prev;
}

/** Changing the lock needs journal edit (route mount) and period.lock (requireCap). */
export function canSetPeriodLock(): boolean {
  return can('journal', 'edit') && cap('period.lock');
}

/** A date-only value (YYYY-MM-DD) in the UI date style, read as a local calendar day. */
export function showDay(day: string | null, none: string): string {
  return day ? formatDate(`${day}T00:00:00`) : none;
}

/** The lock and its history (one cache key for every reader). */
export function usePeriodLock() {
  return useQuery<PeriodLockState>({
    queryKey: ['period-lock'],
    queryFn: async () => (await api.get<PeriodLockState>('/period-lock')).data,
  });
}
