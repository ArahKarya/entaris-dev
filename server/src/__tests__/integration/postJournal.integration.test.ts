/**
 * Integration test: the one posting function services/ledger/postJournal.ts (E2-R3, PR-4.4a).
 *
 * Fixture year 2178 (unique to this file). Rollback tests create every fixture in the transaction:
 * a fiscal year, accounts, a Customer, a user. The party role accounts are the mapped AR account of
 * the seed.
 * - One call writes the journal (Submitted, source), its items, the ledger rows (party copied), the
 *   Decimal balances and the party recalculation together.
 * - Group and inactive accounts are refused; a control account needs a rule that allows it.
 * - The fiscal year comes from the date: expectFiscalYearId that differs -> JOURNAL_FY_MISMATCH.
 * - A locked month refuses the posting unless periodOptions.ignoreLock (year-end close only).
 * - Two real transactions (committed fixtures, cleaned up): while a posting holds its account rows,
 *   a concurrent deactivation waits and afterwards sees the posting's ledger row; a deactivation
 *   that got there first makes the posting wait and then refuse the account (ACCOUNT_INACTIVE), so
 *   nothing posts to an account deactivated between the check and the write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { postJournal, JOURNAL_FY_MISMATCH, type PostJournalInput } from '../../services/ledger/postJournal';
import { DOCUMENT_RULE, manualJournalRule } from '../../services/ledger/accountGuard';

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

const Y = 2178;
const JT = 1_000_000;
const DAY = new Date(`${Y}-03-10T00:00:00+07:00`);
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** true once `p` has settled, false while it is still pending after `ms`. */
const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

type AccountKind = 'EXPENSE' | 'REVENUE' | 'EQUITY';
async function account(db: Tx | PrismaClient, rootType: AccountKind, extra: { isGroup?: boolean; isActive?: boolean } = {}) {
  return db.account.create({
    data: { name: `IT-PJ ${rootType}`, accountNumber: `IT-PJ-${tag()}`, accountType: rootType, rootType, ...extra },
  });
}

interface Books { fy: FiscalYear; userId: string; arId: string; revenueId: string; expenseId: string }

async function books(tx: Tx): Promise<Books> {
  const ar = await tx.systemAccountMapping.findFirst({ where: { role: 'AR' }, select: { accountId: true } });
  if (!ar) throw new Error('AR is not mapped (seed).');
  return {
    fy: await createFiscalYear(tx, { year: Y }),
    userId: (await createCapUser(tx, [])).userId,
    arId: ar.accountId,
    revenueId: (await account(tx, 'REVENUE')).id,
    expenseId: (await account(tx, 'EXPENSE')).id,
  };
}

const input = (b: Pick<Books, 'userId'>, over: Partial<PostJournalInput>): PostJournalInput => ({
  date: DAY,
  narration: 'IT-PJ',
  lines: [],
  sourceType: 'MANUAL',
  createdBy: b.userId,
  accountRule: manualJournalRule(false),
  partyRule: 'strict',
  ...over,
});

const balance = async (tx: Tx, id: string) => (await tx.account.findUniqueOrThrow({ where: { id } })).balance;

d('postJournal (E2-R3)', () => {
  it('writes journal, items, ledger rows with the party, balances, source and party recalc in one call', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await tx.party.create({ data: { name: `IT-PJ Customer ${tag()}`, partyType: 'Customer' } });
      const arBefore = await balance(tx, b.arId);

      const { journal, fiscalYear } = await postJournal(tx, input(b, {
        sourceKey: `IT-PJ:${tag()}`,
        accountRule: manualJournalRule(true),
        partyEffect: 'recalc',
        lines: [
          { accountId: b.arId, debit: '5000000.01', partyId: customer.id, description: 'Koreksi piutang' },
          { accountId: b.revenueId, credit: '5000000.01' },
        ],
      }));

      expect(fiscalYear.id).toBe(b.fy.id);
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: journal.id }, include: { items: true } });
      expect(je).toMatchObject({ status: 'Submitted', sourceType: 'MANUAL', fiscalYearId: b.fy.id, createdBy: b.userId });
      expect(je.sourceKey).toMatch(/^IT-PJ:/);
      expect(je.submittedAt).not.toBeNull();
      expect(je.entryNumber).toMatch(new RegExp(`^JV-${Y}03-`));
      expect(je.items).toHaveLength(2);

      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: journal.id }, orderBy: { debit: 'desc' } });
      expect(ale.map((r) => [r.accountId, r.partyId, r.debit.toFixed(2), r.credit.toFixed(2), r.referenceType, r.fiscalYearId, r.description])).toEqual([
        [b.arId, customer.id, '5000000.01', '0.00', 'JournalEntry', b.fy.id, 'Koreksi piutang'],
        [b.revenueId, null, '0.00', '5000000.01', 'JournalEntry', b.fy.id, 'IT-PJ'],
      ]);

      expect((await balance(tx, b.arId)).minus(arBefore).toFixed(2)).toBe('5000000.01');
      expect((await balance(tx, b.revenueId)).toFixed(2)).toBe('5000000.01');
      const party = await tx.party.findUniqueOrThrow({ where: { id: customer.id } });
      expect(party.outstandingAmount.toFixed(2)).toBe('5000000.01');
    });
  });

  it('refuses group and inactive accounts, and a control account without a rule that allows it', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const group = await account(tx, 'EXPENSE', { isGroup: true });
      const inactive = await account(tx, 'EXPENSE', { isActive: false });
      const lines = (accountId: string) => [{ accountId, debit: JT }, { accountId: b.revenueId, credit: JT }];

      await expect(postJournal(tx, input(b, { lines: lines(group.id) }))).rejects.toMatchObject({ code: 'ACCOUNT_GROUP' });
      await expect(postJournal(tx, input(b, { lines: lines(inactive.id) }))).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
      const customer = await tx.party.create({ data: { name: `IT-PJ Customer ${tag()}`, partyType: 'Customer' } });
      await expect(postJournal(tx, input(b, {
        lines: [{ accountId: b.arId, debit: JT, partyId: customer.id }, { accountId: b.revenueId, credit: JT }],
      }))).rejects.toMatchObject({ code: 'ACCOUNT_CONTROL' });
      expect(await tx.journalEntry.count({ where: { fiscalYearId: b.fy.id } })).toBe(0);
    });
  });

  it('takes the fiscal year from the date: a different expected year is JOURNAL_FY_MISMATCH', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const lines = [{ accountId: b.expenseId, debit: JT }, { accountId: b.revenueId, credit: JT }];
      await expect(postJournal(tx, input(b, { lines, expectFiscalYearId: 'not-this-year' }))).rejects.toMatchObject({ code: JOURNAL_FY_MISMATCH });
      const ok = await postJournal(tx, input(b, { lines, expectFiscalYearId: b.fy.id }));
      expect(ok.journal.fiscalYearId).toBe(b.fy.id);
    });
  });

  it('refuses a locked month unless ignoreLock', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${Y}-03-31`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      const lines = [{ accountId: b.expenseId, debit: JT }, { accountId: b.revenueId, credit: JT }];
      await expect(postJournal(tx, input(b, { lines }))).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
      const ok = await postJournal(tx, input(b, {
        lines, sourceType: 'FY_CLOSE', accountRule: DOCUMENT_RULE, partyRule: 'off', periodOptions: { ignoreLock: true },
      }));
      expect(ok.journal.sourceType).toBe('FY_CLOSE');
    });
  });

  it('holds the account rows: a concurrent deactivation waits for the posting, a posting waits for a deactivation', async () => {
    const suffix = tag();
    const user = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
    if (!user) throw new Error('No active user to attribute the posting to.');
    const fy = await prisma.fiscalYear.create({
      data: { name: `IT-PJ-${Y}-${suffix}`, startDate: new Date(`${Y}-01-01`), endDate: new Date(`${Y}-12-31`) },
    });
    const expense = await account(prisma, 'EXPENSE');
    const expense2 = await account(prisma, 'EXPENSE');
    const equity = await account(prisma, 'EQUITY');
    const entryNumber = `IT-PJ-${suffix}`;
    const post = (accountId: string, number: string) => (tx: Prisma.TransactionClient) => postJournal(tx, {
      date: DAY, narration: 'IT-PJ lock', createdBy: user.id, entryNumber: number,
      sourceType: 'SYSTEM_DOC', accountRule: DOCUMENT_RULE, partyRule: 'off',
      lines: [{ accountId, debit: JT }, { accountId: equity.id, credit: JT }],
    });
    try {
      // A: the posting holds its rows until it commits.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let posted!: () => void;
      const postedSignal = new Promise<void>((r) => { posted = r; });
      const posting = prisma.$transaction(async (tx) => {
        await post(expense.id, entryNumber)(tx);
        posted();
        await gate;
      }, { timeout: 20000 });
      await postedSignal;

      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query(`SET LOCAL lock_timeout = '300ms'`);
        await expect(probe.query('UPDATE accounts SET "isActive" = false WHERE id = $1', [expense.id])).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }

      const deactivator = await pool.connect();
      try {
        await deactivator.query('BEGIN');
        const deactivate = deactivator.query('UPDATE accounts SET "isActive" = false WHERE id = $1', [expense.id]);
        expect(await settledWithin(deactivate, 300)).toBe(false);
        release();
        await posting;
        await deactivate;
        const seen = await deactivator.query('SELECT count(*)::int AS n FROM accounting_ledger_entries WHERE account_id = $1 AND is_cancelled = false', [expense.id]);
        expect(seen.rows[0].n).toBe(1);
        await deactivator.query('COMMIT');
      } finally {
        deactivator.release();
      }

      // B: a deactivation that holds the row first makes the posting wait, then refuse the account.
      const first = await pool.connect();
      try {
        await first.query('BEGIN');
        await first.query('UPDATE accounts SET "isActive" = false WHERE id = $1', [expense2.id]);
        const late = prisma.$transaction((tx) => post(expense2.id, `${entryNumber}-B`)(tx), { timeout: 20000 });
        late.catch(() => undefined);
        expect(await settledWithin(late, 300)).toBe(false);
        await first.query('COMMIT');
        await expect(late).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
      } finally {
        first.release();
      }
      expect(await prisma.journalEntry.count({ where: { entryNumber: `${entryNumber}-B` } })).toBe(0);
    } finally {
      const jes = await prisma.journalEntry.findMany({ where: { entryNumber: { startsWith: entryNumber } }, select: { id: true } });
      await prisma.accountingLedgerEntry.deleteMany({ where: { referenceId: { in: jes.map((j) => j.id) } } });
      await prisma.journalEntry.deleteMany({ where: { id: { in: jes.map((j) => j.id) } } });
      await prisma.account.deleteMany({ where: { id: { in: [expense.id, expense2.id, equity.id] } } });
      await prisma.fiscalYear.delete({ where: { id: fy.id } });
    }
  });
});
