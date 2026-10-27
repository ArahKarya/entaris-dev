/**
 * Integration test: document numbers compare their suffix as a number (audit E2-R2).
 *
 * Text order puts JV-…-9999 after JV-…-10000, so every series used to stall at 9999 and hit P2002.
 * Also covers journals named after a document, non-numeric suffixes, and the dash boundary used
 * when a document's journals are cancelled. Runs in year 2099 inside rolled-back transactions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { cancelJournalsByPrefix } from '../../utils/journalCancel';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Runs fn in a transaction that is always rolled back. */
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

async function openFiscalYear(tx: Tx) {
  const tag = Math.random().toString(36).slice(2, 8);
  return tx.fiscalYear.create({
    data: { name: `IT-${tag}`, startDate: new Date('2099-01-01'), endDate: new Date('2099-12-31'), isClosed: false },
  });
}

async function journal(tx: Tx, fiscalYearId: string, entryNumber: string) {
  return tx.journalEntry.create({
    data: { entryNumber, date: new Date('2099-01-15'), status: 'Submitted', narration: 'Uji penomoran', fiscalYearId, createdBy: userId },
  });
}

const JAN_2099 = new Date('2099-01-15T12:00:00Z');
const MAR_2099 = new Date('2099-03-15T12:00:00Z');

d('generateDocumentNumber numeric suffix', () => {
  it('goes JV-209901-9999 → -10000 → -10001 without P2002', async () => {
    await inRollback(async (tx) => {
      const fy = await openFiscalYear(tx);
      await journal(tx, fy.id, 'JV-209901-9999');

      const first = await generateDocumentNumber(tx, 'JV', JAN_2099, fy.id);
      expect(first).toBe('JV-209901-10000');
      await journal(tx, fy.id, first);

      const second = await generateDocumentNumber(tx, 'JV', JAN_2099, fy.id);
      expect(second).toBe('JV-209901-10001');
      await journal(tx, fy.id, second);
    });
  });

  it('skips sales invoice numbers whose JV-/JV-COGS- journal name is taken', async () => {
    await inRollback(async (tx) => {
      const fy = await openFiscalYear(tx);
      await journal(tx, fy.id, 'JV-SI-209902-0005');
      expect(await generateDocumentNumber(tx, 'SI', new Date('2099-02-15T12:00:00Z'), fy.id)).toBe('SI-209902-0006');

      await journal(tx, fy.id, 'JV-COGS-SI-209902-10002');
      expect(await generateDocumentNumber(tx, 'SI', new Date('2099-02-15T12:00:00Z'), fy.id)).toBe('SI-209902-10003');
    });
  });

  it('ignores -REV, -CXL and other non-numeric suffixes', async () => {
    await inRollback(async (tx) => {
      const fy = await openFiscalYear(tx);
      await journal(tx, fy.id, 'JV-209903-0002');
      await journal(tx, fy.id, 'JV-209903-0002-REV');
      await journal(tx, fy.id, 'JV-209903-0050-CXL');
      await journal(tx, fy.id, 'JV-209903-0060R');
      await journal(tx, fy.id, 'JV-STT-209903-0040-CXL');

      expect(await generateDocumentNumber(tx, 'JV', MAR_2099, fy.id)).toBe('JV-209903-0003');
      expect(await generateDocumentNumber(tx, 'STT', MAR_2099, fy.id)).toBe('STT-209903-0001');
    });
  });

  it.each([
    'SI', 'PI', 'PAY', 'SM', 'PR', 'SO', 'QO', 'PRO', 'INQ', 'ST', 'DO', 'STT', 'PO', 'PSN', 'RN', 'UJ', 'PP', 'DPR', 'DKB', 'JV', 'OB',
  ] as const)('reads the %s series from its real table', async (prefix) => {
    await inRollback(async (tx) => {
      const fy = await openFiscalYear(tx);
      expect(await generateDocumentNumber(tx, prefix, new Date('2099-12-15T12:00:00Z'), fy.id)).toBe(`${prefix}-209912-0001`);
    });
  });
});

d('cancelJournalsByPrefix dash boundary', () => {
  it('cancels JV-PR-209901-1000 and its revisions but not JV-PR-209901-10000', async () => {
    await inRollback(async (tx) => {
      const fy = await openFiscalYear(tx);
      await journal(tx, fy.id, 'JV-PR-209901-1000');
      await journal(tx, fy.id, 'JV-PR-209901-1000-R1');
      const other = await journal(tx, fy.id, 'JV-PR-209901-10000');

      expect(await cancelJournalsByPrefix(tx, 'JV-PR-209901-1000')).toBe(2);

      const after = await tx.journalEntry.findMany({
        where: { entryNumber: { startsWith: 'JV-PR-209901-1000' } },
        select: { id: true, status: true },
      });
      expect(after.find((j) => j.id === other.id)?.status).toBe('Submitted');
      expect(after.filter((j) => j.status === 'Cancelled')).toHaveLength(2);
    });
  });
});
