// Period guard for postings and cancellations: the fiscal year must exist and be open. Every
// posting path reaches it, directly or through getOpenFiscalYear. It tells "no fiscal year" apart
// from "closed" through a stable BusinessError code, and it finds the year by business day (WIB),
// not by raw instant, so a posting late on 31 Dec or early on 1 Jan lands in the right year.

import type { FiscalYear, Prisma } from '@prisma/client';
import { BusinessError } from './errors';
import { businessDayOf, businessDayRange } from './businessDate';

type Tx = Prisma.TransactionClient;

export const PERIOD_CLOSED = 'PERIOD_CLOSED';
export const FISCAL_YEAR_MISSING = 'FISCAL_YEAR_MISSING';
/** Reserved for the period lock date; nothing raises it until that column exists. */
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
 * Returns the fiscal year for the reference when it exists and is open, and holds a share lock
 * on its row for the rest of the transaction (see lockFiscalYearRow).
 * Throws BusinessError FISCAL_YEAR_MISSING when none covers it, PERIOD_CLOSED when it is closed,
 * PERIOD_BUSY when a close or reopen of that year is still running after YEAR_LOCK_WAIT_MS.
 */
export async function assertPeriodOpen(tx: Tx, ref: PeriodRef, label: PeriodLabel): Promise<FiscalYear> {
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
  return fy;
}

/**
 * assertPeriodOpen for every reference given, once per distinct date or fiscal year. Edit and
 * cancel paths pass the document's date and its stored fiscal year: an older edit that moved the
 * date can leave the stored id stale, and journals booked to that id must stay untouched too.
 */
export async function assertPeriodsOpen(
  tx: Tx,
  refs: ReadonlyArray<PeriodRef | null | undefined>,
  label: PeriodLabel,
): Promise<void> {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref) continue;
    const key = ref.fiscalYearId !== undefined ? `fy:${ref.fiscalYearId}` : `date:${ref.date.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await assertPeriodOpen(tx, ref, label);
  }
}

/**
 * Fiscal year for a NEW journal dated `journalDate` (revision, cancel or settlement journals):
 * always taken from the journal's own date, never from the source document's fiscal year.
 */
export function resolveJournalFiscalYear(tx: Tx, journalDate: Date): Promise<FiscalYear> {
  return assertPeriodOpen(tx, { date: journalDate }, 'jurnal');
}
