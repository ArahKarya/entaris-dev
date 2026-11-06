/**
 * Integration test: recurring templates post through the one execution path,
 * services/recurringExecute.ts, and with it through postJournal (E2-R3, PR-4.5a).
 * - A balanced template posts one Submitted RECURRING journal dated on the run's business day with
 *   sourceKey RECURRING:<template id>:<day>, its ledger rows and balances; the schedule moves one
 *   period and lastError stays empty.
 * - A stored template that breaks the rules (written straight to the table, as legacy rows are):
 *   out of balance, three decimals, a party on a line, a control account. Nothing posts, the schedule
 *   does not move, lastError carries the reason, and Admin/Accountant get one notification per
 *   template per business day (a second failure the same day adds none).
 * - The next successful run clears lastError.
 * - The due run posts only due journal templates and reports other types as skipped.
 *
 * Fixture year 2187 (unique to this file). Everything runs in one rollback transaction; lib/prisma
 * is the route harness proxy, so each run's own `$transaction` is a savepoint that a failure rolls
 * back while the failure record written after it stays visible to the test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, Prisma, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../services/telegramService', () => ({
  isPersonalTelegramOn: vi.fn(async () => false),
  pushTelegram: vi.fn(async () => undefined),
  pushTelegramToUser: vi.fn(async () => undefined),
}));

import { runDueTemplates, runRecurringTemplate, RECURRING_FAILED_NOTIFICATION } from '../../services/recurringExecute';

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
      state.tx = tx;
      try {
        await fn(tx);
      } finally {
        state.tx = null;
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2187;
const DAY = `${Y}-03-10`;
/** 10:00 WIB on DAY. */
const NOW = new Date(`${DAY}T03:00:00.000Z`);
const NEXT = new Date(`${DAY}T00:00:00.000Z`);
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books { fy: FiscalYear; userId: string; accountantId: string; expenseId: string; cashId: string }

async function books(tx: Tx): Promise<Books> {
  const account = async (rootType: 'ASSET' | 'EXPENSE') => (await tx.account.create({
    data: { name: `IT-RX ${rootType}`, accountNumber: `IT-RX-${tag()}`, accountType: rootType, rootType },
  })).id;
  const accountant = await tx.user.create({
    data: { username: `it-rx-${tag()}`, fullName: 'IT-RX Akuntan', email: `it-rx-${tag()}@test.invalid`, passwordHash: '-', role: 'Accountant' },
  });
  return {
    fy: await createFiscalYear(tx, { year: Y }),
    userId: (await createCapUser(tx, [])).userId,
    accountantId: accountant.id,
    expenseId: await account('EXPENSE'),
    cashId: await account('ASSET'),
  };
}

type Item = { accountId: string; debit: number | string; credit: number | string; partyId?: string | null };

/** A template written straight to the table (no save-time rules), due on DAY. */
async function template(tx: Tx, b: Books, items: Item[], over: Partial<Prisma.RecurringTemplateUncheckedCreateInput> = {}) {
  return tx.recurringTemplate.create({
    data: {
      name: `IT-RX ${tag()}`,
      templateType: 'journal',
      frequency: 'monthly',
      nextRunDate: NEXT,
      templateData: { narration: 'Sewa gudang bulanan', items } as Prisma.InputJsonValue,
      createdBy: b.userId,
      ...over,
    },
  });
}

const rent = (b: Books, debit: number | string = 7_500_000, credit: number | string = debit): Item[] => [
  { accountId: b.expenseId, debit, credit: 0 },
  { accountId: b.cashId, debit: 0, credit },
];

const balance = async (tx: Tx, id: string) => Number((await tx.account.findUniqueOrThrow({ where: { id } })).balance);
const recurringJournals = (tx: Tx, templateId: string) =>
  tx.journalEntry.findMany({ where: { sourceKey: { startsWith: `RECURRING:${templateId}:` } }, include: { items: true } });
const failureNotices = (tx: Tx, templateId: string) =>
  tx.notification.findMany({ where: { type: RECURRING_FAILED_NOTIFICATION, metadata: { path: ['templateId'], equals: templateId } } });

d('recurring template execution (E2-R3)', () => {
  it('posts a balanced template as RECURRING with its sourceKey, ledger rows and balances, and moves the schedule', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const t = await template(tx, b, rent(b));

      const run = await runRecurringTemplate(t.id, { userId: b.userId, now: NOW });
      expect(run.outcome).toBe('posted');

      const [j, ...more] = await recurringJournals(tx, t.id);
      expect(more).toHaveLength(0);
      expect(j).toMatchObject({
        status: 'Submitted',
        sourceType: 'RECURRING',
        sourceKey: `RECURRING:${t.id}:${DAY}`,
        fiscalYearId: b.fy.id,
        narration: 'Sewa gudang bulanan',
        createdBy: b.userId,
      });
      expect(j!.date).toEqual(new Date(`${DAY}T00:00:00.000Z`));
      expect(j!.entryNumber).toMatch(/^JV/);
      expect(j!.items.map((i) => [i.accountId, Number(i.debit), Number(i.credit), i.partyId, i.description]).sort()).toEqual([
        [b.cashId, 0, 7_500_000, null, 'Sewa gudang bulanan'],
        [b.expenseId, 7_500_000, 0, null, 'Sewa gudang bulanan'],
      ].sort());
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceType: 'JournalEntry', referenceId: j!.id } });
      expect(ale).toHaveLength(2);
      expect(ale.every((r) => r.fiscalYearId === b.fy.id && r.partyId === null)).toBe(true);
      expect(await balance(tx, b.expenseId)).toBe(7_500_000);
      expect(await balance(tx, b.cashId)).toBe(-7_500_000);

      const after = await tx.recurringTemplate.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.lastRunDate).toEqual(NOW);
      expect(after.nextRunDate.getTime()).toBeGreaterThan(NOW.getTime());
      expect(after.lastError).toBeNull();
      expect(await failureNotices(tx, t.id)).toHaveLength(0);
    });
  });

  const broken: Array<[string, (b: Books) => Item[], string]> = [
    ['out of balance (Dr 10 jt / Cr 9 jt)', (b) => rent(b, 10_000_000, 9_000_000), 'JOURNAL_UNBALANCED'],
    ['three decimals', (b) => rent(b, '100.005'), 'LINE_AMOUNT_PRECISION'],
    ['a party on a line', (b) => [{ ...rent(b)[0], partyId: '00000000-0000-4000-8000-000000000001' }, rent(b)[1]], 'PARTY_NOT_ALLOWED'],
  ];
  for (const [label, items, code] of broken) {
    it(`a stored template with ${label} posts nothing, keeps its schedule and records ${code}`, async () => {
      await inRollback(async (tx) => {
        const b = await books(tx);
        const t = await template(tx, b, items(b));

        const run = await runRecurringTemplate(t.id, { userId: b.userId, now: NOW });
        expect(run).toMatchObject({ outcome: 'failed', code });
        expect(await recurringJournals(tx, t.id)).toHaveLength(0);
        expect(await balance(tx, b.expenseId)).toBe(0);

        const after = await tx.recurringTemplate.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.nextRunDate).toEqual(NEXT);
        expect(after.lastRunDate).toBeNull();
        expect(after.lastError).toBe(run.outcome === 'failed' ? run.message : 'unreachable');
        expect(after.lastError).toBeTruthy();
        expect(after.lastErrorAt).toEqual(NOW);

        const notices = await failureNotices(tx, t.id);
        expect(notices.map((n) => n.userId)).toContain(b.accountantId);
        expect(notices.every((n) => n.message.includes(t.name))).toBe(true);
      });
    });
  }

  it('refuses a control account (receivable) on a stored template with ACCOUNT_CONTROL', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const ar = await tx.systemAccountMapping.findFirst({ where: { role: 'AR' }, select: { accountId: true } });
      if (!ar) throw new Error('AR is not mapped (seed).');
      const t = await template(tx, b, [{ accountId: ar.accountId, debit: 100, credit: 0 }, { accountId: b.cashId, debit: 0, credit: 100 }]);
      expect(await runRecurringTemplate(t.id, { userId: b.userId, now: NOW })).toMatchObject({ outcome: 'failed', code: 'ACCOUNT_CONTROL' });
      expect(await recurringJournals(tx, t.id)).toHaveLength(0);
    });
  });

  it('notifies once per template per day, and the next successful run clears lastError', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const t = await template(tx, b, rent(b, 10_000_000, 9_000_000));

      await runRecurringTemplate(t.id, { userId: b.userId, now: NOW });
      const first = await failureNotices(tx, t.id);
      expect(first.length).toBeGreaterThan(0);
      await runRecurringTemplate(t.id, { userId: b.userId, now: new Date(NOW.getTime() + 60 * 60 * 1000) });
      expect(await failureNotices(tx, t.id)).toHaveLength(first.length);

      // The accountant fixes the template; the next run posts and clears the reason.
      await tx.recurringTemplate.update({
        where: { id: t.id },
        data: { templateData: { narration: 'Sewa gudang bulanan', items: rent(b, 10_000_000) } as Prisma.InputJsonValue },
      });
      const ok = await runRecurringTemplate(t.id, { userId: b.userId, now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) });
      expect(ok.outcome).toBe('posted');
      const after = await tx.recurringTemplate.findUniqueOrThrow({ where: { id: t.id } });
      expect(after).toMatchObject({ lastError: null, lastErrorAt: null });
      expect(await recurringJournals(tx, t.id)).toHaveLength(1);
    });
  });

  it('the due run posts due journal templates only and skips other types', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // Only this test's templates are due at NOW (rolled back with everything else).
      await tx.recurringTemplate.updateMany({ where: { isActive: true }, data: { isActive: false } });
      const due = await template(tx, b, rent(b));
      const later = await template(tx, b, rent(b), { nextRunDate: new Date(`${Y}-04-10T00:00:00.000Z`) });
      const invoice = await template(tx, b, [], {
        templateType: 'sales_invoice',
        templateData: { items: [{ itemName: 'Beras', quantity: 1, rate: 1000 }] },
      });

      const results = await runDueTemplates(b.userId, NOW);
      expect(results.map((r) => [r.templateId, r.outcome]).sort()).toEqual([
        [due.id, 'posted'],
        [invoice.id, 'skipped'],
      ].sort());
      expect(results.find((r) => r.templateId === invoice.id)?.code).toBe('RECURRING_TYPE_UNSUPPORTED');
      expect(await recurringJournals(tx, due.id)).toHaveLength(1);
      expect(await recurringJournals(tx, later.id)).toHaveLength(0);
      const inv = await tx.recurringTemplate.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv).toMatchObject({ nextRunDate: NEXT, lastError: null });
    });
  });
});
