// Period guard for postings and cancellations: the fiscal year must exist and be open. Every
// posting path reaches it, directly or through getOpenFiscalYear. It tells "no fiscal year" apart
// from "closed" through a stable BusinessError code, and it finds the year by business day (WIB),
// not by raw instant, so a posting late on 31 Dec or early on 1 Jan lands in the right year.

import type { FiscalYear, Prisma } from '@prisma/client';
import { BusinessError } from './errors';
import { addDays, businessDayOf, businessDayRange, startOfBusinessDay, type InstantRange } from './businessDate';

type Tx = Prisma.TransactionClient;

export const PERIOD_CLOSED = 'PERIOD_CLOSED';
export const FISCAL_YEAR_MISSING = 'FISCAL_YEAR_MISSING';
/** The date is on or before the monthly period lock date (period_lock.lock_date). */
export const PERIOD_LOCKED = 'PERIOD_LOCKED';
/** The year row stayed locked by a running close or reopen past YEAR_LOCK_WAIT_MS; retry later. */
export const PERIOD_BUSY = 'PERIOD_BUSY';

/**
 * How long a posting waits for a running year close or reopen before giving up with PERIOD_BUSY.
 * A close may hold the row for up to 30 s, but most posting transactions expire after Prisma's
 * default 5 s: the wait ends first, so the client gets a coded answer instead of a timed-out
 * transaction.
 */
export const YEAR_LOCK_WAIT_MS = 3000;

/**
 * The document or journal being checked. `date` is always its own date; `fiscalYearId`, when
 * given, is the year it is booked to, and that year is checked instead of the one found by date.
 */
export type PeriodRef = { date: Date; fiscalYearId?: string };

/**
 * What is being posted or cancelled, as it reads mid-sentence in the error message.
 * A fixed set so each noun has its own entry in the i18n dictionary.
 */
export type PeriodLabel =
  | 'jurnal'
  | 'invoice'
  | 'pembayaran'
  | 'uang muka'
  | 'uang jaminan'
  | 'penyusutan'
  | 'retur'
  | 'mutasi stok'
  | 'surat jalan'
  | 'produksi'
  | 'stok opname'
  | 'transfer stok'
  | 'penerimaan barang'
  | 'dokumen';

const MS_PER_DAY = 86_400_000;

/**
 * Business day (YYYY-MM-DD) of an instant. An instant at exact UTC midnight is a date-only value
 * (new Date('YYYY-MM-DD')) and keeps its UTC calendar day; a negative offset would otherwise move
 * it to the day before.
 */
function businessDay(date: Date): string {
  if (date.getTime() % MS_PER_DAY === 0) return date.toISOString().slice(0, 10);
  return businessDayOf(date);
}

/**
 * First and last business day of a fiscal year and the half-open instant range that covers them,
 * [first day 00:00, day after the last day 00:00) in the business offset. A document stored at local
 * or UTC midnight of any day of the year falls inside it.
 */
export function fiscalYearRange(fy: Pick<FiscalYear, 'startDate' | 'endDate'>): InstantRange & { startDay: string; endDay: string } {
  const startDay = businessDay(fy.startDate);
  const endDay = businessDay(fy.endDate);
  return { startDay, endDay, gte: startOfBusinessDay(startDay), lt: startOfBusinessDay(addDays(endDay, 1)) };
}

/** Options of the period guard. */
export interface PeriodGuardOptions {
  /**
   * Skip the monthly lock date (the fiscal-year checks still apply). Only for documents without
   * a GL or stock effect, which use the fiscal year for numbering alone: quotation, sales order,
   * proforma, inquiry, purchase order, temporary delivery note, and demo data. Also the year-end
   * CLOSE journal: the close locks the whole year itself, and a reopen requires the lock date to be
   * moved back before the year's last day first (assertYearEndNotLocked).
   */
  ignoreLock?: boolean;
}

const earlier = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/**
 * Fiscal year whose [startDate, endDate] touches the business day of `date`, open or closed.
 * Fiscal-year bounds are stored at UTC or local midnight of their calendar day. Each range end
 * is the earlier of the two midnights (of this day, and of the next day), which accepts either
 * form of this day and neither form of a neighbouring day, for positive and negative offsets.
 * When an odd end time makes two years touch one day, the later year wins.
 */
async function findFiscalYearForDate(tx: Tx, date: Date): Promise<FiscalYear | null> {
  const day = businessDay(date);
  const local = businessDayRange(day);
  const utcStart = new Date(`${day}T00:00:00.000Z`);
  const utcNext = new Date(utcStart.getTime() + MS_PER_DAY);
  return tx.fiscalYear.findFirst({
    where: { startDate: { lt: earlier(local.lt, utcNext) }, endDate: { gte: earlier(local.gte, utcStart) } },
    orderBy: { startDate: 'desc' },
  });
}

/** Read-only lookup of the fiscal year (open or closed) holding the business day of `date`; no row lock. */
export function fiscalYearOn(db: Tx, date: Date): Promise<FiscalYear | null> {
  return findFiscalYearForDate(db, date);
}

/**
 * Postgres lock_not_available (55P03), raised when a lock wait outlasts lock_timeout. Through the
 * pg driver adapter a raw query fails with P2010 and the SQLSTATE in meta.driverAdapterError.
 */
function isLockTimeout(err: unknown): boolean {
  const e = err as { meta?: { code?: unknown; driverAdapterError?: { cause?: { code?: unknown } } } } | null;
  return e?.meta?.driverAdapterError?.cause?.code === '55P03' || e?.meta?.code === '55P03';
}

/**
 * Share-locks the fiscal-year row until the transaction ends and returns its committed isClosed
 * (null when the row is gone). Year close and reopen take FOR UPDATE on the same row, so a
 * posting or cancel either finishes before the close sums the year, or waits and sees it closed.
 * The wait is bounded by YEAR_LOCK_WAIT_MS (PERIOD_BUSY past it, and the transaction is then
 * aborted); the caller's lock_timeout is put back for the rest of the transaction.
 */
async function lockFiscalYearRow(tx: Tx, fy: FiscalYear, label: PeriodLabel): Promise<boolean | null> {
  const before = await tx.$queryRaw<{ lock_timeout?: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${YEAR_LOCK_WAIT_MS}ms`}, true)`;
  let rows: { is_closed: boolean }[];
  try {
    rows = await tx.$queryRaw<{ is_closed: boolean }[]>`SELECT is_closed FROM fiscal_years WHERE id = ${fy.id} FOR SHARE`;
  } catch (err) {
    if (!isLockTimeout(err)) throw err;
    throw new BusinessError(
      `Tahun buku ${fy.name} sedang ditutup atau dibuka kembali; ${label} belum bisa diproses. Coba lagi beberapa saat lagi.`,
      PERIOD_BUSY,
    );
  }
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${before[0]?.lock_timeout ?? '0'}, true)`;
  return rows[0]?.is_closed ?? null;
}

/**
 * The period lock date (YYYY-MM-DD), or null when none is set. Share-locks the single
 * period_lock row until the transaction ends: PUT /period-lock takes FOR UPDATE on it, so moving
 * the lock waits for running postings, and a posting that starts later sees the new date.
 */
async function readLockDate(tx: Tx): Promise<string | null> {
  const rows = await tx.$queryRaw<{ lock_date: string | null }[]>`SELECT lock_date::text AS lock_date FROM period_lock WHERE id = 1 FOR SHARE`;
  return rows[0]?.lock_date ?? null;
}

/** Throws PERIOD_LOCKED when the business day `day` is on or before the lock date. */
async function assertNotLocked(tx: Tx, day: string, label: PeriodLabel): Promise<void> {
  const lockDate = await readLockDate(tx);
  if (lockDate !== null && day <= lockDate) {
    throw new BusinessError(
      `Periode s.d. ${lockDate} sudah dikunci; ${label} bertanggal ${day} tidak bisa diposting, diubah, atau dibatalkan. Minta pemegang hak Kunci Periode memundurkan kunci.`,
      PERIOD_LOCKED,
    );
  }
}

/**
 * Throws PERIOD_LOCKED when the lock date reaches the last day of `fy`. A reopen checks this first:
 * the closing journal is dated on that day, so the lock has to move back before the year can open.
 * Share-locks the lock row like the guard does.
 */
export async function assertYearEndNotLocked(tx: Tx, fy: Pick<FiscalYear, 'name' | 'endDate'>): Promise<void> {
  const lockDate = await readLockDate(tx);
  const end = businessDay(fy.endDate);
  if (lockDate !== null && end <= lockDate) {
    throw new BusinessError(
      `Periode s.d. ${lockDate} sudah dikunci, termasuk akhir tahun buku ${fy.name} (${end}). Mundurkan kunci periode ke sebelum ${end} dulu, lalu buka kembali tahun buku.`,
      PERIOD_LOCKED,
    );
  }
}

/**
 * The first business day (YYYY-MM-DD) after the period lock date that lies in an open fiscal year,
 * or null when no lock is set. For postings that fall into a locked month and move to the first
 * open day instead (recurring catch-up, month-end settlement): the day after the lock, or the start
 * of the next open fiscal year when that day's year is closed. Throws FISCAL_YEAR_MISSING when no
 * open year covers or follows it. Share-locks the lock row like the guard does; the posting itself
 * still goes through assertPeriodOpen.
 */
export async function firstOpenBusinessDay(tx: Tx): Promise<string | null> {
  const lockDate = await readLockDate(tx);
  if (lockDate === null) return null;
  const day = addDays(lockDate, 1);
  const local = businessDayRange(day);
  const utcStart = new Date(`${day}T00:00:00.000Z`);
  // Same bounds as findFiscalYearForDate: the earliest open year ending on or after `day`.
  const fy = await tx.fiscalYear.findFirst({
    where: { isClosed: false, endDate: { gte: earlier(local.gte, utcStart) } },
    orderBy: { startDate: 'asc' },
  });
  if (!fy) {
    throw new BusinessError(
      `Tidak ada tahun buku terbuka mulai ${day}. Buat atau buka kembali tahun buku terlebih dahulu.`,
      FISCAL_YEAR_MISSING,
    );
  }
  const start = businessDay(fy.startDate);
  return start > day ? start : day;
}

/**
 * Returns the fiscal year for the reference when it exists and is open, and holds a share lock
 * on its row for the rest of the transaction (see lockFiscalYearRow). Then checks the monthly
 * lock date against the reference's business day, unless `opts.ignoreLock`.
 * Throws BusinessError FISCAL_YEAR_MISSING when none covers it, PERIOD_CLOSED when it is closed,
 * PERIOD_BUSY when a close or reopen of that year is still running after YEAR_LOCK_WAIT_MS,
 * PERIOD_LOCKED when the date is on or before the lock date.
 */
export async function assertPeriodOpen(
  tx: Tx,
  ref: PeriodRef,
  label: PeriodLabel,
  opts: PeriodGuardOptions = {},
): Promise<FiscalYear> {
  const found =
    ref.fiscalYearId !== undefined
      ? await tx.fiscalYear.findUnique({ where: { id: ref.fiscalYearId } })
      : await findFiscalYearForDate(tx, ref.date);
  const isClosed = found ? await lockFiscalYearRow(tx, found, label) : null;
  const fy = found && isClosed !== null ? { ...found, isClosed } : null;
  if (!fy) {
    throw new BusinessError(
      `Tahun buku untuk ${label} tidak ditemukan. Buat tahun buku untuk tanggal ini terlebih dahulu.`,
      FISCAL_YEAR_MISSING,
    );
  }
  if (fy.isClosed) {
    throw new BusinessError(
      `Tahun buku ${fy.name} sudah ditutup; ${label} di periode ini tidak bisa diposting, diubah, atau dibatalkan. Buat koreksi di periode berjalan.`,
      PERIOD_CLOSED,
    );
  }
  if (!opts.ignoreLock) await assertNotLocked(tx, businessDay(ref.date), label);
  return fy;
}

/**
 * assertPeriodOpen for every reference given: the fiscal-year check once per distinct date or
 * fiscal year, the lock date once per distinct business day. Edit and cancel paths pass the
 * document's date and its stored fiscal year: an older edit that moved the date can leave the
 * stored id stale, and journals booked to that id must stay untouched too.
 */
export async function assertPeriodsOpen(
  tx: Tx,
  refs: ReadonlyArray<PeriodRef | null | undefined>,
  label: PeriodLabel,
): Promise<void> {
  const seen = new Set<string>();
  const lockChecked = new Set<string>();
  for (const ref of refs) {
    if (!ref) continue;
    const key = ref.fiscalYearId !== undefined ? `fy:${ref.fiscalYearId}` : `date:${ref.date.getTime()}`;
    const day = businessDay(ref.date);
    if (!seen.has(key)) {
      seen.add(key);
      lockChecked.add(day);
      await assertPeriodOpen(tx, ref, label);
    } else if (!lockChecked.has(day)) {
      lockChecked.add(day);
      await assertNotLocked(tx, day, label);
    }
  }
}

/**
 * Fiscal year for a NEW journal dated `journalDate` (revision, cancel or settlement journals):
 * always taken from the journal's own date, never from the source document's fiscal year.
 */
export function resolveJournalFiscalYear(tx: Tx, journalDate: Date): Promise<FiscalYear> {
  return assertPeriodOpen(tx, { date: journalDate }, 'jurnal');
}
