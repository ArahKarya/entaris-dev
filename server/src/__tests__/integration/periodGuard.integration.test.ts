/**
 * Integration test: assertPeriodOpen / resolveJournalFiscalYear against real fiscal-year rows.
 *
 * Fiscal years are stored at UTC midnight of their first and last day (routes/fiscalYears.ts).
 * The guard must still find the year for any instant on those business days (WIB), and report
 * a missing year and a closed year with distinct codes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { BusinessError } from '../../utils/errors';
import { assertPeriodOpen, resolveJournalFiscalYear, FISCAL_YEAR_MISSING, PERIOD_CLOSED } from '../../utils/periodGuard';
import { closedThenOpenYears, createFiscalYear } from '../helpers/periodFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 20000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

d('assertPeriodOpen', () => {
  it('31 Dec 23:30 WIB stays in the old year and 1 Jan 03:00 WIB lands in the new one', async () => {
    await inRollback(async (tx) => {
      const old = await createFiscalYear(tx, { year: 2091 });
      const next = await createFiscalYear(tx, { year: 2092 });
      expect((await resolveJournalFiscalYear(tx, new Date('2091-12-31T16:30:00Z'))).id).toBe(old.id);
      expect((await resolveJournalFiscalYear(tx, new Date('2091-12-31T20:00:00Z'))).id).toBe(next.id);
      expect((await resolveJournalFiscalYear(tx, new Date('2092-01-01T00:00:00Z'))).id).toBe(next.id);
    });
  });

  it('finds the year on its first business day before 07:00 WIB', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: 2093 });
      // 1 Jan 00:30 WIB = 31 Dec 17:30Z of the previous calendar year.
      expect((await assertPeriodOpen(tx, { date: new Date('2092-12-31T17:30:00Z') }, 'jurnal')).id).toBe(fy.id);
    });
  });

  it('reports a date with no fiscal year as FISCAL_YEAR_MISSING', async () => {
    await inRollback(async (tx) => {
      expect(await codeOf(assertPeriodOpen(tx, { date: new Date('2094-06-15T03:00:00Z') }, 'jurnal'))).toBe(FISCAL_YEAR_MISSING);
      expect(await codeOf(assertPeriodOpen(tx, { fiscalYearId: 'missing-fy-id' }, 'dokumen'))).toBe(FISCAL_YEAR_MISSING);
    });
  });

  it('reports a closed year as PERIOD_CLOSED, by date and by id', async () => {
    await inRollback(async (tx) => {
      const { closed, open } = await closedThenOpenYears(tx, 2095);
      expect(await codeOf(assertPeriodOpen(tx, { date: new Date('2095-08-01T03:00:00Z') }, 'invoice'))).toBe(PERIOD_CLOSED);
      expect(await codeOf(assertPeriodOpen(tx, { fiscalYearId: closed.id }, 'invoice'))).toBe(PERIOD_CLOSED);
      expect((await assertPeriodOpen(tx, { fiscalYearId: open.id }, 'invoice')).id).toBe(open.id);
      // The first business day of the open year is not swallowed by the closed one.
      expect((await assertPeriodOpen(tx, { date: new Date('2095-12-31T18:00:00Z') }, 'invoice')).id).toBe(open.id);
    });
  });
});
