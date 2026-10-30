import type { FiscalYear, Prisma } from '@prisma/client';
import { assertPeriodOpen, type PeriodLabel } from './periodGuard';

/**
 * The open fiscal year for a new document dated `date`, found by its business day (WIB by
 * default). It is the period guard (assertPeriodOpen): the year row stays share-locked until the
 * transaction ends, so a posting either commits before a running year close sums the year, or
 * waits for it (bounded, see YEAR_LOCK_WAIT_MS) and is rejected.
 * Throws BusinessError FISCAL_YEAR_MISSING when no year covers the day, PERIOD_CLOSED when it is closed,
 * PERIOD_BUSY when a close or reopen of that year is still running after YEAR_LOCK_WAIT_MS.
 */
export function getOpenFiscalYear(
  tx: Prisma.TransactionClient,
  date: Date,
  opts: { label?: PeriodLabel } = {},
): Promise<FiscalYear> {
  return assertPeriodOpen(tx, { date }, opts.label ?? 'dokumen');
}
