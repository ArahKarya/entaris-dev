/**
 * Integration test: the Journal menu cancels only hand-made journals (E1 PR-5a, G-7).
 *
 * - PATCH /journals/:id/cancel needs doc.cancel (403 without it).
 * - MANUAL, IMPORT, RECURRING and CASH_BOOK journals cancel (200): status Cancelled, ledger rows
 *   cancelled, account balances back to what they were before the journal.
 * - Every other source type, and a NULL (unknown legacy) source, gets 400 JOURNAL_NOT_MANUAL and
 *   stays as it was: CLOSE-, DEP-, JV-STT-, deposit offsets (customer and supplier, made by the
 *   deposit refund route), opening and system journals. A hand-made source type on a journal
 *   that belongs to a module (JV-STT- number, deposit application link) is stopped by the second
 *   layer with the same code.
 * - A closed year still answers PERIOD_CLOSED first.
 * - Cancelling a deposit application whose journal is already cancelled gets 400
 *   DEPOSIT_APPLICATION_JOURNAL_CANCELLED and restores nothing a second time.
 *
 * Route handlers run through the route harness, whose `$transaction` is a savepoint; everything
 * runs in a rollback transaction in a far-future year with fixtures made here.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, type JournalSourceType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { JOURNAL_NOT_MANUAL } from '../../services/journalCancelGuard';
import { DEPOSIT_APPLICATION_JOURNAL_CANCELLED } from '../../services/depositApplicationCancel';
import { voidJournalByIdInTx } from '../../utils/journalCancel';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import journalsRouter from '../../routes/journals';
import customerDepositsRouter from '../../routes/customerDeposits';
import vendorDepositsRouter from '../../routes/vendorDeposits';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let cashAccountId: string;
/** The acting user (doc.cancel) of the current test. */
let actor: { userId: string; role: string };

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const cash = await prisma.account.findFirst({ where: { accountNumber: { startsWith: '1.1.' }, isGroup: false } });
  if (!cash) throw new Error('No cash account (1.1.x) configured.');
  cashAccountId = cash.id;
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
        actor = await createCapUser(tx, ['doc.cancel']);
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

const Y = 2096;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const short = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** Only the Date clock moves; timers stay real so the transaction timeout keeps working. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

async function accountBalances(tx: Tx, ids: string[]): Promise<Record<string, string>> {
  const rows = await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, balance: true } });
  return Object.fromEntries(rows.map((r) => [r.id, r.balance.toString()]));
}

/** Journal, its ledger rows and the balances of the accounts it touches, for a before/after compare. */
async function journalState(tx: Tx, journalId: string) {
  const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalId }, include: { items: true } });
  const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: journalId }, select: { id: true, isCancelled: true }, orderBy: { id: 'asc' } });
  return { status: je.status, ale, balances: await accountBalances(tx, je.items.map((i) => i.accountId)) };
}

interface PostedJournal {
  id: string;
  accountIds: string[];
  /** Balances of both accounts right before the journal was posted. */
  balancesBefore: Record<string, string>;
}

/**
 * A 1.5 jt journal posted through POST /journals (MANUAL), then given the source type and number
 * under test, the way another writer would have stored it.
 */
async function postedJournal(
  tx: Tx,
  over: { sourceType?: JournalSourceType | null; entryNumber?: string } = {},
): Promise<PostedJournal> {
  const [a, b] = await tx.account.findMany({ where: { isGroup: false, isActive: true }, take: 2, orderBy: { accountNumber: 'asc' } });
  if (!a || !b) throw new Error('Need two detail accounts.');
  const accountIds = [a.id, b.id];
  const balancesBefore = await accountBalances(tx, accountIds);
  const created = await callRoute(journalsRouter, 'post', '/', {
    body: {
      date: `${Y}-03-10`,
      narration: `Jurnal uji menu ${tag()}`,
      items: [
        { accountId: a.id, debit: 1_500_000, credit: 0 },
        { accountId: b.id, debit: 0, credit: 1_500_000 },
      ],
    },
    ...actor,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  if ('sourceType' in over || over.entryNumber) {
    await tx.journalEntry.update({
      where: { id },
      data: {
        ...('sourceType' in over ? { sourceType: over.sourceType } : {}),
        ...(over.entryNumber ? { entryNumber: over.entryNumber } : {}),
      },
    });
  }
  return { id, accountIds, balancesBefore };
}

function cancelFromMenu(journalId: string, who: { userId: string; role: string } = actor) {
  return callRoute(journalsRouter, 'patch', '/:id/cancel', { params: { id: journalId }, body: { reason: 'Uji menu jurnal' }, ...who });
}

function expectCode(r: RouteResult, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(code);
}

/** The menu refuses the journal and leaves it, its ledger rows and the balances untouched. */
async function expectMenuRefuses(tx: Tx, journalId: string) {
  const before = await journalState(tx, journalId);
  expectCode(await cancelFromMenu(journalId), JOURNAL_NOT_MANUAL);
  expect(await journalState(tx, journalId)).toEqual(before);
  expect(before.status).toBe('Submitted');
}

d('Journal menu cancel: capability', () => {
  it('a role without doc.cancel gets 403 and the journal stays', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const je = await postedJournal(tx);
      const before = await journalState(tx, je.id);
      const r = await cancelFromMenu(je.id, await createCapUser(tx, []));
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(await journalState(tx, je.id)).toEqual(before);
    });
  });
});

d('Journal menu cancel: hand-made journals', () => {
  it.each(['MANUAL', 'IMPORT', 'RECURRING', 'CASH_BOOK'] as const)('cancels a %s journal and reverses its balances', async (sourceType) => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const je = await postedJournal(tx, { sourceType });
      expect(await accountBalances(tx, je.accountIds)).not.toEqual(je.balancesBefore);

      const r = await cancelFromMenu(je.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const after = await tx.journalEntry.findUniqueOrThrow({ where: { id: je.id } });
      expect(after.status).toBe('Cancelled');
      expect(after.cancelledById).toBe(actor.userId);
      expect(after.cancelReason).toBe('Uji menu jurnal');
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: je.id, isCancelled: false } })).toBe(0);
      expect(await accountBalances(tx, je.accountIds)).toEqual(je.balancesBefore);
    });
  });

  it('a closed year answers PERIOD_CLOSED before the source check', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: Y });
      const je = await postedJournal(tx, { sourceType: null });
      await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
      const before = await journalState(tx, je.id);
      expectCode(await cancelFromMenu(je.id), PERIOD_CLOSED);
      expect(await journalState(tx, je.id)).toEqual(before);
    });
  });
});

d('Journal menu cancel: module and unknown journals', () => {
  it.each([
    ['an unknown legacy journal (NULL source)', null, undefined],
    ['a closing journal', 'FY_CLOSE', 'CLOSE-'],
    ['a depreciation journal', 'DEPRECIATION', 'DEP-'],
    ['a goods receipt journal without a source tag', null, 'JV-STT-'],
    ['an opening balance journal', 'OPENING', undefined],
    ['a source document journal', 'SYSTEM_DOC', undefined],
    ['a deposit offset journal', 'DEPOSIT_OFFSET', undefined],
  ] as const)('refuses %s with JOURNAL_NOT_MANUAL', async (_label, sourceType, prefix) => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const je = await postedJournal(tx, { sourceType, ...(prefix ? { entryNumber: `${prefix}${Y}-${short()}` } : {}) });
      await expectMenuRefuses(tx, je.id);
    });
  });

  it('the second layer stops a MANUAL-tagged journal with a goods receipt number', async () => {
    await inRollback(async (tx) => {
      await createFiscalYear(tx, { year: Y });
      const je = await postedJournal(tx, { sourceType: 'MANUAL', entryNumber: `JV-STT-${Y}03-${short()}` });
      await expectMenuRefuses(tx, je.id);
    });
  });
});

const SIDES = {
  customer: {
    router: customerDepositsRouter,
    partyType: 'Customer',
    paymentType: 'CustomerDeposit',
    balanceField: 'customerDepositBalance',
  },
  vendor: {
    router: vendorDepositsRouter,
    partyType: 'Supplier',
    paymentType: 'VendorDeposit',
    balanceField: 'depositBalance',
  },
} as const;
type Side = keyof typeof SIDES;

/** A 4 jt service invoice of the party, outstanding in full. */
async function invoiceOf(tx: Tx, side: Side, partyId: string): Promise<string> {
  const items = [{ itemName: 'Jasa uji menu jurnal', itemType: 'service', quantity: 1, rate: 4_000_000 }];
  const inv = side === 'customer'
    ? await submitSalesInvoiceInTx(tx, { date: `${Y}-03-01`, partyId, items } as any, actor.userId)
    : await submitPurchaseInvoiceInTx(tx, { date: `${Y}-03-01`, partyId, items } as any, actor.userId);
  return inv.id;
}

async function outstanding(tx: Tx, side: Side, invoiceId: string): Promise<number> {
  const inv = side === 'customer'
    ? await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } })
    : await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  return Number(inv.outstanding);
}

async function depositBalance(tx: Tx, side: Side, partyId: string): Promise<number> {
  const p = await tx.party.findUniqueOrThrow({ where: { id: partyId } });
  return Number(side === 'customer' ? p.customerDepositBalance : p.depositBalance);
}

async function applicationOf(tx: Tx, side: Side, depositId: string) {
  return side === 'customer'
    ? tx.customerDepositApplication.findFirstOrThrow({ where: { depositPaymentId: depositId } })
    : tx.vendorDepositApplication.findFirstOrThrow({ where: { depositPaymentId: depositId } });
}

/** A 10 jt deposit of a new party with a 4 jt invoice. */
async function depositAndInvoice(tx: Tx, side: Side) {
  const s = SIDES[side];
  const party = await tx.party.create({ data: { name: `IT-JMS-${s.partyType}-${tag()}`, partyType: s.partyType, isActive: true } });
  const invoiceId = await invoiceOf(tx, side, party.id);
  const { payment } = await submitPaymentInTx(
    tx,
    { date: `${Y}-03-02`, partyId: party.id, amount: 10_000_000, paymentType: s.paymentType, accountId: cashAccountId } as any,
    actor.userId,
  );
  return { partyId: party.id, invoiceId, depositId: payment.id };
}

for (const side of ['customer', 'vendor'] as const) {
  d(`${side} deposit offsets and applications`, () => {
    it('the Journal menu refuses an offset journal made by the refund route, tagged, legacy or mis-tagged MANUAL', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositAndInvoice(tx, side);
        const offset = await callRoute(SIDES[side].router, 'post', '/:id/refund', {
          params: { id: fx.depositId },
          body: { date: `${Y}-03-05`, offsetAmount: 4_000_000 },
          ...actor,
        });
        expect(offset.status, JSON.stringify(offset.body)).toBe(200);
        const app = await applicationOf(tx, side, fx.depositId);
        const journalId = app.journalEntryId!;
        expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: journalId } })).sourceType).toBe('DEPOSIT_OFFSET');

        await expectMenuRefuses(tx, journalId);
        await tx.journalEntry.update({ where: { id: journalId }, data: { sourceType: null } });
        await expectMenuRefuses(tx, journalId);
        // Second layer: the application link (and the offset narration) still say "deposit module".
        await tx.journalEntry.update({ where: { id: journalId }, data: { sourceType: 'MANUAL' } });
        await expectMenuRefuses(tx, journalId);

        expect(await outstanding(tx, side, fx.invoiceId)).toBe(0);
        expect(await depositBalance(tx, side, fx.partyId)).toBe(6_000_000);
        expect((await applicationOf(tx, side, fx.depositId)).isCancelled).toBe(false);
      });
    });

    it('the second layer catches the application link even without a module narration', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositAndInvoice(tx, side);
        clockAt(`${Y}-03-06T03:00:00.000Z`);
        const body = side === 'customer'
          ? { depositPaymentId: fx.depositId, salesInvoiceId: fx.invoiceId, amount: 4_000_000 }
          : { depositPaymentId: fx.depositId, purchaseInvoiceId: fx.invoiceId, amount: 4_000_000 };
        const applied = await callRoute(SIDES[side].router, 'post', '/apply', { body, ...actor });
        expect(applied.status, JSON.stringify(applied.body)).toBe(201);
        vi.useRealTimers();
        const app = await applicationOf(tx, side, fx.depositId);
        await tx.journalEntry.update({ where: { id: app.journalEntryId! }, data: { sourceType: 'MANUAL', narration: 'Koreksi' } });
        await expectMenuRefuses(tx, app.journalEntryId!);
      });
    });

    it('cancelling an application whose journal is already cancelled gets DEPOSIT_APPLICATION_JOURNAL_CANCELLED and restores nothing twice', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositAndInvoice(tx, side);
        clockAt(`${Y}-03-06T03:00:00.000Z`);
        const body = side === 'customer'
          ? { depositPaymentId: fx.depositId, salesInvoiceId: fx.invoiceId, amount: 4_000_000 }
          : { depositPaymentId: fx.depositId, purchaseInvoiceId: fx.invoiceId, amount: 4_000_000 };
        const applied = await callRoute(SIDES[side].router, 'post', '/apply', { body, ...actor });
        expect(applied.status, JSON.stringify(applied.body)).toBe(201);
        vi.useRealTimers();
        const app = await applicationOf(tx, side, fx.depositId);
        expect(app.journalEntryId).not.toBeNull();

        // The journal was cancelled elsewhere (the old Journal-menu path), the application not.
        expect(await voidJournalByIdInTx(tx, app.journalEntryId!)).toBe(true);
        const invoiceBefore = await outstanding(tx, side, fx.invoiceId);
        const balanceBefore = await depositBalance(tx, side, fx.partyId);
        const journalBefore = await journalState(tx, app.journalEntryId!);

        expectCode(
          await callRoute(SIDES[side].router, 'post', '/apply/:id/cancel', { params: { id: app.id }, ...actor }),
          DEPOSIT_APPLICATION_JOURNAL_CANCELLED,
        );

        expect((await applicationOf(tx, side, fx.depositId)).isCancelled).toBe(false);
        expect(await outstanding(tx, side, fx.invoiceId)).toBe(invoiceBefore);
        expect(await depositBalance(tx, side, fx.partyId)).toBe(balanceBefore);
        expect(await journalState(tx, app.journalEntryId!)).toEqual(journalBefore);
      });
    });

    it('still cancels an application whose journal is active', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositAndInvoice(tx, side);
        clockAt(`${Y}-03-06T03:00:00.000Z`);
        const body = side === 'customer'
          ? { depositPaymentId: fx.depositId, salesInvoiceId: fx.invoiceId, amount: 4_000_000 }
          : { depositPaymentId: fx.depositId, purchaseInvoiceId: fx.invoiceId, amount: 4_000_000 };
        const applied = await callRoute(SIDES[side].router, 'post', '/apply', { body, ...actor });
        expect(applied.status, JSON.stringify(applied.body)).toBe(201);
        vi.useRealTimers();
        const app = await applicationOf(tx, side, fx.depositId);
        expect(await outstanding(tx, side, fx.invoiceId)).toBe(0);
        expect(await depositBalance(tx, side, fx.partyId)).toBe(6_000_000);

        const r = await callRoute(SIDES[side].router, 'post', '/apply/:id/cancel', { params: { id: app.id }, ...actor });
        expect(r.status, JSON.stringify(r.body)).toBe(200);

        expect((await applicationOf(tx, side, fx.depositId)).isCancelled).toBe(true);
        expect(await outstanding(tx, side, fx.invoiceId)).toBe(4_000_000);
        expect(await depositBalance(tx, side, fx.partyId)).toBe(10_000_000);
        expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: app.journalEntryId! } })).status).toBe('Cancelled');
      });
    });
  });
}
