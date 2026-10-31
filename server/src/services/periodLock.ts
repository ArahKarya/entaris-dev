// Monthly period lock: one global lock date (period_lock, single row id = 1). The period guard
// (utils/periodGuard.ts) rejects postings, edits and cancels dated on or before it with
// PERIOD_LOCKED. Moving the date is limited to the period.lock capability (route gate); moving it
// back or clearing it needs a reason, and every change is written to period_lock_logs.

import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { businessToday } from '../utils/businessDate';

type Db = Prisma.TransactionClient | PrismaClient;

/** Error code: the lock date is today or later; only past days can be locked. */
export const PERIOD_LOCK_NOT_PAST = 'PERIOD_LOCK_NOT_PAST';
/** Error code: moving the lock back (or clearing it) without a reason of at least 5 characters. */
export const PERIOD_LOCK_REASON_REQUIRED = 'PERIOD_LOCK_REASON_REQUIRED';

const REASON_MIN = 5;
const HISTORY_LIMIT = 50;

export interface PeriodLockLogView {
  id: string;
  oldDate: string | null;
  newDate: string | null;
  reason: string | null;
  createdAt: Date;
  user: { id: string; fullName: string } | null;
}

export interface PeriodLockView {
  /** YYYY-MM-DD, or null when nothing is locked. */
  lockDate: string | null;
  updatedAt: Date | null;
  updatedBy: { id: string; fullName: string } | null;
  logs: PeriodLockLogView[];
}

export interface SetPeriodLockInput {
  lockDate: string | null;
  reason?: string | null;
  userId: string;
  /** Today's business day; defaults to the WIB (APP_UTC_OFFSET) day of now. */
  today?: string;
}

export interface SetPeriodLockResult {
  lockDate: string | null;
  previousLockDate: string | null;
  /** False when the date was already the requested one (nothing is logged). */
  changed: boolean;
  logId: string | null;
}

/** A DATE column read through Prisma (UTC midnight) as YYYY-MM-DD. */
const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const dateOf = (day: string | null): Date | null => (day ? new Date(`${day}T00:00:00.000Z`) : null);

/** True when `next` unlocks days that `prev` kept locked: an earlier date, or no lock at all. */
export function movesLockBack(prev: string | null, next: string | null): boolean {
  if (prev === null) return false;
  return next === null || next < prev;
}

/** Current lock and the latest changes, newest first. */
export async function getPeriodLock(db: Db): Promise<PeriodLockView> {
  const [row, logs] = await Promise.all([
    db.periodLock.findUnique({ where: { id: 1 } }),
    db.periodLockLog.findMany({ orderBy: { createdAt: 'desc' }, take: HISTORY_LIMIT }),
  ]);
  const userIds = [...new Set([row?.updatedBy, ...logs.map((l) => l.userId)].filter((id): id is string => !!id))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })
    : [];
  const userOf = (id: string | null | undefined) => users.find((u) => u.id === id) ?? null;
  return {
    lockDate: dayOf(row?.lockDate ?? null),
    updatedAt: row?.updatedBy ? row.updatedAt : null,
    updatedBy: userOf(row?.updatedBy),
    logs: logs.map((l) => ({
      id: l.id,
      oldDate: dayOf(l.oldDate),
      newDate: dayOf(l.newDate),
      reason: l.reason,
      createdAt: l.createdAt,
      user: userOf(l.userId),
    })),
  };
}

/**
 * Sets (or clears, with null) the lock date. Takes FOR UPDATE on the lock row first, so it waits
 * for postings that already passed the guard (they hold FOR SHARE) and compares against the
 * committed date. Rejects a date on or after today (PERIOD_LOCK_NOT_PAST) and a move back or
 * clear without a reason (PERIOD_LOCK_REASON_REQUIRED). Writes one period_lock_logs row per change.
 */
export async function setPeriodLockInTx(tx: Prisma.TransactionClient, input: SetPeriodLockInput): Promise<SetPeriodLockResult> {
  const today = input.today ?? businessToday();
  if (input.lockDate !== null && input.lockDate >= today) {
    throw new BusinessError(
      `Tanggal kunci harus sebelum hari ini (${today}). Hanya hari yang sudah lewat yang bisa dikunci.`,
      PERIOD_LOCK_NOT_PAST,
    );
  }

  // The seed row comes from the migration; recreate it if it was removed, so FOR UPDATE has a row.
  await tx.$executeRaw`INSERT INTO period_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ lock_date: string | null }[]>`SELECT lock_date::text AS lock_date FROM period_lock WHERE id = 1 FOR UPDATE`;
  const previous = rows[0]?.lock_date ?? null;
  if (previous === input.lockDate) {
    return { lockDate: previous, previousLockDate: previous, changed: false, logId: null };
  }

  const reason = input.reason?.trim() || null;
  if (movesLockBack(previous, input.lockDate) && (reason === null || reason.length < REASON_MIN)) {
    throw new BusinessError(
      'Alasan wajib diisi (minimal 5 karakter) saat kunci periode dimundurkan atau dibuka.',
      PERIOD_LOCK_REASON_REQUIRED,
    );
  }

  await tx.periodLock.update({
    where: { id: 1 },
    data: { lockDate: dateOf(input.lockDate), updatedBy: input.userId, updatedAt: new Date() },
  });
  const log = await tx.periodLockLog.create({
    data: { id: randomUUID(), oldDate: dateOf(previous), newDate: dateOf(input.lockDate), reason, userId: input.userId, createdAt: new Date() },
  });
  return { lockDate: input.lockDate, previousLockDate: previous, changed: true, logId: log.id };
}
