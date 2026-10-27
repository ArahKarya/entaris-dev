import type { FiscalYear, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface FiscalYearFixtureInput {
  /** Calendar year; bounds are stored the way routes/fiscalYears.ts does (UTC midnight). */
  year: number;
  isClosed?: boolean;
}

/**
 * Creates a uniquely named fiscal year inside the caller's (rollback) transaction.
 * Use far-future years (2090+) so the range never overlaps real data in a shared database.
 */
export function createFiscalYear(tx: Tx, { year, isClosed = false }: FiscalYearFixtureInput): Promise<FiscalYear> {
  return tx.fiscalYear.create({
    data: {
      name: `IT-${year}-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date(`${year}-01-01`),
      endDate: new Date(`${year}-12-31`),
      isClosed,
      ...(isClosed ? { closedAt: new Date() } : {}),
    },
  });
}

/** A closed year followed by an open one, for period-boundary tests. */
export async function closedThenOpenYears(tx: Tx, closedYear: number): Promise<{ closed: FiscalYear; open: FiscalYear }> {
  const closed = await createFiscalYear(tx, { year: closedYear, isClosed: true });
  const open = await createFiscalYear(tx, { year: closedYear + 1 });
  return { closed, open };
}
