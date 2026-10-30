// Period guard for postings and cancellations: the fiscal year must exist and be open.
// Unlike getOpenFiscalYear it tells "no fiscal year" apart from "closed" through a stable
// BusinessError code, and it finds the year by business day (WIB), not by raw instant, so a
// posting late on 31 Dec or early on 1 Jan lands in the right year.

import type { FiscalYear, Prisma } from '@prisma/client';
import { BusinessError } from './errors';
import { businessUtcOffset, localDayRange } from './listQuery';

type Tx = Prisma.TransactionClient;

export const PERIOD_CLOSED = 'PERIOD_CLOSED';
export const FISCAL_YEAR_MISSING = 'FISCAL_YEAR_MISSING';
/** Reserved for the period lock date; nothing raises it until that column exists. */
export const PERIOD_LOCKED = 'PERIOD_LOCKED';

export type PeriodRef = { date: Date } | { fiscalYearId: string };

/**
 * What is being posted or cancelled, as it reads mid-sentence in the error message.
 * A fixed set so each noun has its own entry in the i18n dictionary.
 */
export type PeriodLabel = 'jurnal' | 'invoice' | 'pembayaran' | 'uang muka' | 'uang jaminan' | 'penyusutan' | 'dokumen';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Calendar day (YYYY-MM-DD) of an instant in the business time zone. An instant at exact UTC
 * midnight is a date-only value (new Date('YYYY-MM-DD')) and keeps its UTC calendar day; a
 * negative offset would otherwise move it to the day before.
 */
function businessDay(date: Date, offset: string): string {
  if (date.getTime() % MS_PER_DAY === 0) return date.toISOString().slice(0, 10);
  const sign = offset.startsWith('-') ? -1 : 1;
  const [h, m] = offset.slice(1).split(':').map(Number);
  const shifted = new Date(date.getTime() + sign * (h! * 60 + m!) * MS_PER_MINUTE);
  return shifted.toISOString().slice(0, 10);
}

const earlier = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/**
 * Fiscal year whose [startDate, endDate] touches the business day of `date`, open or closed.
 * Fiscal-year bounds are stored at UTC or local midnight of their calendar day. Each range end
 * is the earlier of the two midnights (of this day, and of the next day), which accepts either
 * form of this day and neither form of a neighbouring day, for positive and negative offsets.
 */
async function findFiscalYearForDate(tx: Tx, date: Date): Promise<FiscalYear | null> {
  const offset = businessUtcOffset();
  const day = businessDay(date, offset);
  const local = localDayRange(day, day, offset);
  const utcStart = new Date(`${day}T00:00:00.000Z`);
  const utcNext = new Date(utcStart.getTime() + MS_PER_DAY);
  return tx.fiscalYear.findFirst({
    where: { startDate: { lt: earlier(local.lt!, utcNext) }, endDate: { gte: earlier(local.gte!, utcStart) } },
    orderBy: { startDate: 'desc' },
  });
}

/**
 * Returns the fiscal year for the reference when it exists and is open.
 * Throws BusinessError FISCAL_YEAR_MISSING when none covers it, PERIOD_CLOSED when it is closed.
 */
export async function assertPeriodOpen(tx: Tx, ref: PeriodRef, label: PeriodLabel): Promise<FiscalYear> {
  const fy =
    'fiscalYearId' in ref
      ? await tx.fiscalYear.findUnique({ where: { id: ref.fiscalYearId } })
      : await findFiscalYearForDate(tx, ref.date);
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
 * Fiscal year for a NEW journal dated `journalDate` (revision, cancel or settlement journals):
 * always taken from the journal's own date, never from the source document's fiscal year.
 */
export function resolveJournalFiscalYear(tx: Tx, journalDate: Date): Promise<FiscalYear> {
  return assertPeriodOpen(tx, { date: journalDate }, 'jurnal');
}
