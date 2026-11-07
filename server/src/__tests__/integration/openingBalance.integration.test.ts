/**
 * Integration test: account opening balances through the one opening balance service (E2-R11,
 * PR-5.7a), called through PATCH /coa/:id/balance.
 *
 * Fixture: fiscal year 2150 open and 2151 closed (this file's years, plan §6.3), each with fresh
 * asset accounts; the global company_settings.cutover_date is set inside the rollback transaction.
 * - Cut-over 1 Jan, entered on 15 Mar: the journal is dated 1 Jan, keyed, and the balance sheet of
 *   31 Jan holds the amount; another asOfDate is refused.
 * - 600 jt replaces 500 jt: the keyed journal and its ledger rows are cancelled, accounts.balance
 *   equals the ledger; 600 jt again is 'unchanged' with no new journal.
 * - An account with ledger rows before the cut-over posts only the difference; a "Setoran modal
 *   awal" against opening equity on the cut-over day counts as opening already ('unchanged').
 * - Unkeyed old opening journals (old PATCH in March, OB- with source NULL) refuse with
 *   OPENING_LEGACY_REVIEW and change nothing.
 * - In the closed year the same amount is 'unchanged', another one PERIOD_CLOSED.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Prisma, PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { mappedAccount } from '../../services/systemAccounts';
import { updateAccountBalance } from '../../utils/accountBalance';
import { computeBalanceSheet, type BsNode } from '../../services/reports/balanceSheet';
import { asOfBound } from '../../utils/businessDate';
import { openingJournalInstant, OPENING_DATE_MISMATCH, OPENING_LEGACY_REVIEW } from '../../services/ledger/openingBalance';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import { sourceKeys } from '../../services/ledger/journalSource';
import coaRouter from '../../routes/coa';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let actor: { userId: string; role: string };

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

afterEach(() => {
  vi.useRealTimers();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        actor = await createCapUser(tx, []);
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2150;
const CLOSED = 2151;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;

function asset(tx: Tx) {
  return tx.account.create({
    data: { name: `IT-OB ${tag()}`, accountNumber: `1.98${Date.now() % 100000}${++seq}`, accountType: 'ASSET', rootType: 'ASSET' },
  });
}

async function setCutover(tx: Tx, day: string) {
  await tx.companySettings.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', companyName: '' } });
  await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${day}::date WHERE slug = 'default'`;
}

/** A two-line journal with ledger rows and balances, written directly (a legacy or other-path journal). */
async function post(
  tx: Tx,
  fy: FiscalYear,
  date: Date,
  debitId: string,
  creditId: string,
  amount: number,
  extra: { entryNumber?: string; narration?: string; sourceType?: 'OPENING' | 'MANUAL' | 'IMPORT' | null; sourceKey?: string | null } = {},
) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: extra.entryNumber ?? `IT-OB-${tag()}`,
      date,
      narration: extra.narration ?? 'IT-OB fixture',
      status: 'Submitted',
      fiscalYearId: fy.id,
      createdBy: actor.userId,
      submittedAt: new Date(),
      sourceType: extra.sourceType === undefined ? 'MANUAL' : extra.sourceType,
      sourceKey: extra.sourceKey ?? null,
      items: { create: [{ accountId: debitId, debit: amount, credit: 0 }, { accountId: creditId, debit: 0, credit: amount }] },
    },
  });
  const row = { date, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id };
  await tx.accountingLedgerEntry.createMany({
    data: [{ ...row, accountId: debitId, debit: amount, credit: 0 }, { ...row, accountId: creditId, debit: 0, credit: amount }],
  });
  await updateAccountBalance(tx, debitId, amount, 0);
  await updateAccountBalance(tx, creditId, 0, amount);
  return je;
}

function setBalance(accountId: string, body: Record<string, unknown>) {
  return callRoute(coaRouter, 'patch', '/:id/balance', { userId: actor.userId, role: actor.role, params: { id: accountId }, body });
}

const journalsOf = (tx: Tx, accountId: string) =>
  tx.journalEntry.findMany({ where: { items: { some: { accountId } } }, include: { items: true }, orderBy: { createdAt: 'asc' } });

async function ledgerNet(tx: Tx, accountId: string): Promise<Prisma.Decimal> {
  const agg = await tx.accountingLedgerEntry.aggregate({ where: { accountId, isCancelled: false }, _sum: { debit: true, credit: true } });
  return new Prisma.Decimal(agg._sum.debit ?? 0).sub(agg._sum.credit ?? 0);
}

async function storedBalance(tx: Tx, accountId: string): Promise<string> {
  return new Prisma.Decimal((await tx.account.findUniqueOrThrow({ where: { id: accountId } })).balance).toFixed(2);
}

const findNode = (nodes: BsNode[], accountId: string): BsNode | null => {
  for (const n of nodes) {
    if (n.accountId === accountId && n.kind === 'account') return n;
    const hit = findNode(n.children, accountId);
    if (hit) return hit;
  }
  return null;
};

/** Only the Date clock moves; timers stay real so the transaction timeout keeps working. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

d('account opening balance at the cut-over date', () => {
  it('posts on the cut-over day, replaces a keyed journal, and is unchanged on the same amount', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      await setCutover(tx, `${Y}-01-01`);
      const kas = await asset(tx);
      clockAt(`${Y}-03-15T10:00:00+07:00`);

      const wrongDay = await setBalance(kas.id, { balance: 500 * JT, asOfDate: `${Y}-03-15` });
      expect(wrongDay.status).toBe(400);
      expect(wrongDay.body.code).toBe(OPENING_DATE_MISMATCH);

      const first = await setBalance(kas.id, { balance: 500 * JT });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.opening).toMatchObject({ asOfDate: `${Y}-01-01`, action: 'posted', cancelled: [] });
      const [j1] = await journalsOf(tx, kas.id);
      expect(j1.date.getTime()).toBe(openingJournalInstant(`${Y}-01-01`).getTime());
      expect(j1.sourceType).toBe('OPENING');
      expect(j1.sourceKey).toBe(sourceKeys.openingAccount(kas.id));
      expect(j1.narration).toBe(`Saldo awal akun: ${kas.accountNumber} - ${kas.name}`);
      const equity = await mappedAccount(tx, 'OPENING_EQUITY');
      expect(j1.items.map((i) => [i.accountId, Number(i.debit), Number(i.credit)]).sort()).toEqual(
        [[kas.id, 500 * JT, 0], [equity.id, 0, 500 * JT]].sort(),
      );

      const bound = asOfBound(`${Y}-01-31`);
      if (!bound.ok) throw new Error(bound.error);
      const bs = await computeBalanceSheet(tx, bound);
      expect(findNode(bs.assets, kas.id)?.balance).toBe(500 * JT);

      const second = await setBalance(kas.id, { balance: '600000000' });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.opening).toMatchObject({ action: 'replaced', cancelled: [j1.entryNumber] });
      const after = await journalsOf(tx, kas.id);
      expect(after.map((j) => j.status)).toEqual(['Cancelled', 'Submitted']);
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: j1.id, isCancelled: false } })).toBe(0);
      expect((await ledgerNet(tx, kas.id)).toFixed(2)).toBe('600000000.00');
      expect(await storedBalance(tx, kas.id)).toBe('600000000.00');

      const third = await setBalance(kas.id, { balance: 600 * JT });
      expect(third.status).toBe(200);
      expect(third.body.opening).toMatchObject({ action: 'unchanged', journalNumber: after[1].entryNumber, cancelled: [] });
      expect(await journalsOf(tx, kas.id)).toHaveLength(2);
    });
  });

  it('posts only the difference to the ledger before the cut-over day', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      await setCutover(tx, `${Y}-07-01`);
      const kas = await asset(tx);
      const other = await asset(tx);
      await post(tx, fy, new Date(`${Y}-03-10T09:00:00+07:00`), kas.id, other.id, 100 * JT);

      const r = await setBalance(kas.id, { balance: 500 * JT });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const opening = (await journalsOf(tx, kas.id)).find((j) => j.sourceType === 'OPENING')!;
      expect(Number(opening.items.find((i) => i.accountId === kas.id)!.debit)).toBe(400 * JT);
      expect((await ledgerNet(tx, kas.id)).toFixed(2)).toBe('500000000.00');
    });
  });

  it('counts a "Setoran modal awal" against opening equity on the cut-over day as opening already', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      await setCutover(tx, `${Y}-01-01`);
      const kas = await asset(tx);
      const equity = await mappedAccount(tx, 'OPENING_EQUITY');
      await post(tx, fy, new Date(`${Y}-01-01`), kas.id, equity.id, 500 * JT, { narration: 'Setoran modal awal', sourceType: null });

      const r = await setBalance(kas.id, { balance: 500 * JT });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.opening).toMatchObject({ action: 'unchanged', journalNumber: null });
      expect(await journalsOf(tx, kas.id)).toHaveLength(1);
      expect((await ledgerNet(tx, kas.id)).toFixed(2)).toBe('500000000.00');
    });
  });

  it('counts an imported journal against opening equity on the cut-over day as opening already', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      await setCutover(tx, `${Y}-01-01`);
      const kas = await asset(tx);
      const equity = await mappedAccount(tx, 'OPENING_EQUITY');
      await post(tx, fy, new Date(`${Y}-01-01`), kas.id, equity.id, 500 * JT, {
        narration: 'Neraca awal', sourceType: 'IMPORT', sourceKey: sourceKeys.importGroup('a'.repeat(64), 1),
      });

      const r = await setBalance(kas.id, { balance: 500 * JT });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.opening).toMatchObject({ action: 'unchanged', journalNumber: null });
      expect(await journalsOf(tx, kas.id)).toHaveLength(1);
      expect((await ledgerNet(tx, kas.id)).toFixed(2)).toBe('500000000.00');
    });
  });

  it('refuses while an unkeyed old opening journal exists and changes nothing', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      await setCutover(tx, `${Y}-01-01`);
      const equity = await mappedAccount(tx, 'OPENING_EQUITY');
      const cases = [
        { entryNumber: `OB-${Y}03-${tag()}`, narration: 'Saldo Awal: 1.1 - Kas', sourceType: 'OPENING' as const },
        { entryNumber: `OB-${Y}03-${tag()}`, narration: 'Saldo Awal: 1.1 - Kas', sourceType: null },
      ];
      for (const legacy of cases) {
        const kas = await asset(tx);
        const old = await post(tx, fy, new Date(`${Y}-03-20T11:00:00+07:00`), kas.id, equity.id, 300 * JT, legacy);
        const before = await storedBalance(tx, kas.id);

        const r = await setBalance(kas.id, { balance: 500 * JT });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe(OPENING_LEGACY_REVIEW);
        expect(r.body.error).toContain(old.entryNumber);
        expect(await storedBalance(tx, kas.id)).toBe(before);
        expect((await journalsOf(tx, kas.id)).map((j) => j.status)).toEqual(['Submitted']);
      }
    });
  });

  it('is unchanged in a closed year on the same amount and refuses another with PERIOD_CLOSED', async () => {
    await inRollback(async (tx) => {
      const closed = await createFiscalYear(tx, { year: CLOSED, isClosed: true });
      await setCutover(tx, `${CLOSED}-01-01`);
      const kas = await asset(tx);
      const equity = await mappedAccount(tx, 'OPENING_EQUITY');
      await post(tx, closed, openingJournalInstant(`${CLOSED}-01-01`), kas.id, equity.id, 300 * JT, {
        entryNumber: `JV-${CLOSED}01-${tag()}`, narration: 'Saldo awal akun', sourceType: 'OPENING', sourceKey: sourceKeys.openingAccount(kas.id),
      });

      const same = await setBalance(kas.id, { balance: 300 * JT });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(same.body.opening.action).toBe('unchanged');

      const other = await setBalance(kas.id, { balance: 400 * JT });
      expect(other.status).toBe(400);
      expect(other.body.code).toBe(PERIOD_CLOSED);
      expect(await storedBalance(tx, kas.id)).toBe('300000000.00');
    });
  });
});
