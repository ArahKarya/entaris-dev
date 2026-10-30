import { Prisma } from '@prisma/client';
import { BusinessError } from './errors';
import { businessDayOf, businessDayRange } from './businessDate';

/**
 * Find the open fiscal year that contains the business day (WIB by default) of the given date.
 * A fiscal year matches when it overlaps that day, so years stored at UTC midnight or at WIB
 * midnight both cover 31 Dec 23:30 and 1 Jan 03:00 WIB correctly. When an odd end time makes
 * two years overlap one day, the later year wins.
 * Throws BusinessError if not found or already closed.
 */
export async function getOpenFiscalYear(
  tx: Prisma.TransactionClient,
  date: Date
) {
  const { gte, lt } = businessDayRange(businessDayOf(date));
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: {
      isClosed: false,
      startDate: { lt },
      endDate: { gte },
    },
    orderBy: { startDate: 'desc' },
  });

  if (!fiscalYear) {
    throw new BusinessError('Tahun fiskal tidak ditemukan atau sudah ditutup untuk tanggal ini.');
  }

  return fiscalYear;
}
