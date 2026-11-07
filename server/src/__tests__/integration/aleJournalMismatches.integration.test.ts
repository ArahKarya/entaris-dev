/**
 * Integration test: findAleJournalMismatches over the whole book with a cause per journal (E2-R14,
 * PR-5.1), and its one-year form used by the year-close check ale-vs-journal.
 *
 * Fixture year 2141 (unique to this file), open, and a closed copy of it where a case needs one;
 * two accounts of its own. Ledger rows are written straight to the table and every group balances
 * (debit = credit). Every query is scoped to the fixture's journals, so data elsewhere in the
 * database does not matter. Everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type DocumentStatus, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { findAleJournalMismatches } from '../../services/ledger/aleSyncCheck';

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

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books { fy: FiscalYear; userId: string; debitId: string; creditId: string }

async function books(tx: Tx, isClosed = false): Promise<Books> {
  const account = async (name: string) =>
    (await tx.account.create({ data: { name: `IT2141 ${name}`, accountNumber: `IT2141-${tag()}`, accountType: 'ASSET', rootType: 'ASSET' } })).id;
  return {
    fy: await createFiscalYear(tx, { year: 2141, isClosed }),
    userId: (await createCapUser(tx, [])).userId,
    debitId: await account('debit'),
    creditId: await account('credit'),
  };
}

/** A two-line journal of `amount`; `ledger` writes balanced ledger rows of that amount (null: none). */
async function journal(
  tx: Tx,
  b: Books,
  opts: { amount?: number; ledger?: number | null; status?: DocumentStatus; number?: string; reverse?: boolean; ledgerCancelled?: boolean } = {},
) {
  const amount = opts.amount ?? 1000;
  const [dr, cr] = opts.reverse ? [b.creditId, b.debitId] : [b.debitId, b.creditId];
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: opts.number ?? `IT2141-${tag()}`,
      date: new Date('2141-04-10T03:00:00Z'),
      status: opts.status ?? 'Submitted',
      fiscalYearId: b.fy.id,
      createdBy: b.userId,
      items: { create: [{ accountId: dr, debit: amount, credit: 0 }, { accountId: cr, debit: 0, credit: amount }] },
    },
  });
  const ledger = opts.ledger === undefined ? amount : opts.ledger;
  if (ledger !== null) await ledgerRows(tx, b, je.id, ledger, { reverse: opts.reverse, cancelled: opts.ledgerCancelled });
  return je;
}

async function ledgerRows(tx: Tx, b: Books, referenceId: string, amount: number, opts: { reverse?: boolean; cancelled?: boolean } = {}) {
  const [dr, cr] = opts.reverse ? [b.creditId, b.debitId] : [b.debitId, b.creditId];
  const row = { date: new Date('2141-04-10T03:00:00Z'), referenceType: 'JournalEntry', referenceId, fiscalYearId: b.fy.id, isCancelled: opts.cancelled ?? false };
  await tx.accountingLedgerEntry.createMany({
    data: [{ ...row, accountId: dr, debit: amount, credit: 0 }, { ...row, accountId: cr, debit: 0, credit: amount }],
  });
}

d('findAleJournalMismatches: cause per journal', () => {
  it('names each of the six causes and leaves a consistent journal alone', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const clean = await journal(tx, b);
      const noLedger = await journal(tx, b, { ledger: null });
      const differs = await journal(tx, b, { amount: 1000, ledger: 900 });
      const cancelled = await journal(tx, b, { status: 'Cancelled' });
      const draft = await journal(tx, b, { status: 'Draft' });
      const legacy = await journal(tx, b, { status: 'Cancelled', number: `IT2141-STT-${tag()}` });
      const cxl = await journal(tx, b, { number: `${legacy.entryNumber}-CXL`, reverse: true });
      const goneId = randomUUID();
      await ledgerRows(tx, b, goneId, 500);

      const ids = [clean.id, noLedger.id, differs.id, cancelled.id, draft.id, legacy.id, cxl.id, goneId];
      const res = await findAleJournalMismatches(tx, { journalIds: ids });
      const causes = Object.fromEntries(res.rows.map((r) => [r.journalId, r.cause]));
      expect(causes).toEqual({
        [noLedger.id]: 'no-ledger',
        [differs.id]: 'amount-differs',
        [cancelled.id]: 'cancelled-active-ale',
        [draft.id]: 'draft-with-ale',
        [legacy.id]: 'legacy-stt-pair',
        [goneId]: 'ledger-without-journal',
      });
      expect(res.total).toBe(6);
      expect(res.closedTotal).toBe(0);
      expect(res.byCause).toEqual({
        'no-ledger': 1, 'ledger-without-journal': 1, 'cancelled-active-ale': 1, 'legacy-stt-pair': 1, 'draft-with-ale': 1, 'amount-differs': 1,
      });
      const gone = res.rows.find((r) => r.journalId === goneId)!;
      expect(gone).toMatchObject({ entryNumber: null, status: null, fiscalYearId: b.fy.id, fiscalYearName: b.fy.name, yearClosed: false });
      expect(res.rows.find((r) => r.journalId === differs.id)!.difference.toFixed(2)).toBe('200.00');
    });
  });

  it('a legacy pair is clean once the original is Submitted and marked reversed by its -CXL', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const legacy = await journal(tx, b, { status: 'Cancelled', number: `IT2141-STT-${tag()}` });
      const cxl = await journal(tx, b, { number: `${legacy.entryNumber}-CXL`, reverse: true });
      expect((await findAleJournalMismatches(tx, { journalIds: [legacy.id, cxl.id] })).rows.map((r) => r.cause)).toEqual(['legacy-stt-pair']);

      // Marked reversed but still Cancelled: no longer a legacy pair.
      await tx.journalEntry.update({ where: { id: legacy.id }, data: { reversedById: cxl.id } });
      expect((await findAleJournalMismatches(tx, { journalIds: [legacy.id, cxl.id] })).rows.map((r) => r.cause)).toEqual(['cancelled-active-ale']);

      await tx.journalEntry.update({ where: { id: legacy.id }, data: { status: 'Submitted' } });
      expect(await findAleJournalMismatches(tx, { journalIds: [legacy.id, cxl.id] })).toMatchObject({ total: 0, rows: [] });
    });
  });

  it('a -CXL journal that is not Submitted does not make a legacy pair', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const legacy = await journal(tx, b, { status: 'Cancelled', number: `IT2141-STT-${tag()}` });
      await journal(tx, b, { number: `${legacy.entryNumber}-CXL`, reverse: true, status: 'Cancelled', ledgerCancelled: true });
      expect((await findAleJournalMismatches(tx, { journalIds: [legacy.id] })).rows.map((r) => r.cause)).toEqual(['cancelled-active-ale']);
    });
  });

  it('counts findings in a closed year, and the full count before the limit', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx, true);
      const big = await journal(tx, b, { amount: 5000, ledger: null });
      const small = await journal(tx, b, { amount: 100, ledger: null });
      const res = await findAleJournalMismatches(tx, { journalIds: [big.id, small.id] }, { limit: 1 });
      expect(res).toMatchObject({ total: 2, closedTotal: 2, byCause: { 'no-ledger': 2 } });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ journalId: big.id, yearClosed: true, cause: 'no-ledger' });
      expect(await findAleJournalMismatches(tx, { journalIds: [] })).toMatchObject({ total: 0, rows: [] });
    });
  });

  it('the one-year form keeps its old shape and keys for the year-close check', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const differs = await journal(tx, b, { amount: 1000, ledger: 900 });
      const cancelled = await journal(tx, b, { status: 'Cancelled', amount: 300 });
      const old = await findAleJournalMismatches(tx, b.fy.id);
      // Largest difference first: the cancelled journal's 300/300 ledger rows (600), then 1000 vs 900 per side (200).
      expect(old.map((r) => ({ ...r, difference: r.difference.toFixed(2) }))).toEqual([
        { journalId: cancelled.id, entryNumber: cancelled.entryNumber, date: cancelled.date, status: 'Cancelled', otherYear: false, difference: '600.00' },
        { journalId: differs.id, entryNumber: differs.entryNumber, date: differs.date, status: 'Submitted', otherYear: false, difference: '200.00' },
      ]);
      // The year scope of the new form reports the same journals.
      const scoped = await findAleJournalMismatches(tx, { fiscalYearId: b.fy.id });
      expect(scoped.rows.map((r) => r.journalId)).toEqual(old.map((r) => r.journalId));
    });
  });
});
