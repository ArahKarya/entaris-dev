/**
 * Integration test: cancelling a customer or supplier deposit refund from its own route (E1-R5,
 * owner decision 2).
 *
 * - A deposit of 10 jt with 4 jt refunded: cancelling the refund voids its journal (cancelledById,
 *   reason), sets refundedAmount back to 0, the party deposit balance back to 10 jt and the
 *   deposit and cash account balances back to what they were before the refund.
 * - A second cancel gets STALE_STATUS, a closed year PERIOD_CLOSED, another deposit's refund
 *   journal DEPOSIT_REFUND_MISMATCH, a role without doc.cancel 403.
 * - The Journal menu rejects refund journals with JOURNAL_USE_DEPOSIT_REFUND_CANCEL.
 * - Legacy refunds without a source key are matched by the exact deposit number in the narration.
 *
 * Route handlers run through the route harness, whose `$transaction` is a savepoint; everything
 * runs in a rollback transaction in a far-future year with fixtures made here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { submitPaymentInTx } from '../../services/paymentSubmit';
import { invalidatePermissionCache } from '../../services/permissionService';
import {
  DEPOSIT_REFUND_MISMATCH,
  DEPOSIT_REFUND_OVER_CANCEL,
  JOURNAL_USE_DEPOSIT_REFUND_CANCEL,
  depositRefundSourceKey,
} from '../../services/depositRefundCancel';
import { STALE_STATUS } from '../../utils/cancelClaim';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import customerDepositsRouter from '../../routes/customerDeposits';
import vendorDepositsRouter from '../../routes/vendorDeposits';
import journalsRouter from '../../routes/journals';

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

const Y = 2095;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type Side = 'customer' | 'vendor';
const SIDE = {
  customer: { router: customerDepositsRouter, partyType: 'Customer', paymentType: 'CustomerDeposit', balance: 'customerDepositBalance' },
  vendor: { router: vendorDepositsRouter, partyType: 'Supplier', paymentType: 'VendorDeposit', balance: 'depositBalance' },
} as const;

interface Fixture {
  side: Side;
  partyId: string;
  depositId: string;
  depositNumber: string;
  refundJournalId: string;
  /** Account balances (deposit and cash account) right before the refund. */
  balancesBeforeRefund: Record<string, number>;
  depositAccountId: string;
}

async function accountBalances(tx: Tx, ids: string[]): Promise<Record<string, number>> {
  const rows = await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, balance: true } });
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.balance)]));
}

async function partyBalance(tx: Tx, side: Side, partyId: string): Promise<number> {
  const p = await tx.party.findUniqueOrThrow({ where: { id: partyId } });
  return Number(side === 'customer' ? p.customerDepositBalance : p.depositBalance);
}

/** A 10 jt deposit with a 4 jt cash refund, both in year Y. */
async function depositWithRefund(tx: Tx, side: Side): Promise<Fixture> {
  const s = SIDE[side];
  const party = await tx.party.create({ data: { name: `IT-RFC-${s.partyType}-${tag()}`, partyType: s.partyType, isActive: true } });
  const { payment } = await submitPaymentInTx(
    tx,
    { date: `${Y}-04-01`, partyId: party.id, amount: 10_000_000, paymentType: s.paymentType, accountId: cashAccountId } as any,
    actor.userId,
  );
  const { journalEntryId } = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
  const createJournal = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId! }, include: { items: true } });
  const depositAccountId = createJournal.items.find((i) => i.partyId === party.id)!.accountId;
  const balancesBeforeRefund = await accountBalances(tx, [depositAccountId, cashAccountId]);

  const refund = await callRoute(s.router, 'post', '/:id/refund', {
    params: { id: payment.id },
    body: { date: `${Y}-04-05`, cashAmount: 4_000_000, cashAccountId },
    ...actor,
  });
  expect(refund.status, JSON.stringify(refund.body)).toBe(200);
  return {
    side, partyId: party.id, depositId: payment.id, depositNumber: payment.paymentNumber,
    refundJournalId: refund.body.cashJournalId, balancesBeforeRefund, depositAccountId,
  };
}

function cancelRefund(fx: Fixture, journalId = fx.refundJournalId, who: { userId: string; role: string } = actor, reason?: string) {
  return callRoute(SIDE[fx.side].router, 'post', '/:id/refunds/:journalId/cancel', {
    params: { id: fx.depositId, journalId },
    body: reason === undefined ? {} : { reason },
    ...who,
  });
}

function expectCode(r: RouteResult, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(code);
}

/** The refund still stands: journal active, 4 jt refunded, 6 jt left on the party. */
async function expectRefundIntact(tx: Tx, fx: Fixture) {
  expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: fx.refundJournalId } })).status).toBe('Submitted');
  expect(Number((await tx.payment.findUniqueOrThrow({ where: { id: fx.depositId } })).refundedAmount)).toBe(4_000_000);
  expect(await partyBalance(tx, fx.side, fx.partyId)).toBe(6_000_000);
}

for (const side of ['customer', 'vendor'] as const) {
  d(`cancel a ${side} deposit refund`, () => {
    it('restores refundedAmount, the deposit balance and the ledger; records who and why', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        const tagged = await tx.journalEntry.findUniqueOrThrow({ where: { id: fx.refundJournalId } });
        expect(tagged.sourceType).toBe('DEPOSIT_REFUND');
        expect(tagged.sourceKey).toBe(depositRefundSourceKey(fx.depositId));

        const listed = await callRoute(SIDE[side].router, 'get', '/:id/refunds', { params: { id: fx.depositId }, ...actor });
        expect(listed.status).toBe(200);
        expect(listed.body.data).toHaveLength(1);
        expect(listed.body.data[0]).toMatchObject({ journalEntryId: fx.refundJournalId, amount: 4_000_000, status: 'Submitted' });
        expect(listed.body.data[0].cashAccount.id).toBe(cashAccountId);

        const r = await cancelRefund(fx, fx.refundJournalId, actor, 'Salah input');
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ amount: 4_000_000, refundedAmount: 0 });

        expect(Number((await tx.payment.findUniqueOrThrow({ where: { id: fx.depositId } })).refundedAmount)).toBe(0);
        expect(await partyBalance(tx, side, fx.partyId)).toBe(10_000_000);
        expect(await accountBalances(tx, [fx.depositAccountId, cashAccountId])).toEqual(fx.balancesBeforeRefund);

        const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: fx.refundJournalId } });
        expect(je.status).toBe('Cancelled');
        expect(je.cancelledById).toBe(actor.userId);
        expect(je.cancelReason).toBe('Salah input');
        expect(await tx.accountingLedgerEntry.count({ where: { referenceId: je.id, isCancelled: false } })).toBe(0);
        // Live ledger rows of the party on the deposit account: the 10 jt deposit only.
        const live = await tx.accountingLedgerEntry.aggregate({
          where: { accountId: fx.depositAccountId, partyId: fx.partyId, isCancelled: false },
          _sum: { debit: true, credit: true },
        });
        expect(Math.abs(Number(live._sum.debit ?? 0) - Number(live._sum.credit ?? 0))).toBe(10_000_000);

        const after = await callRoute(SIDE[side].router, 'get', '/:id/refunds', { params: { id: fx.depositId }, ...actor });
        expect(after.body.data[0]).toMatchObject({ status: 'Cancelled', cancelledById: actor.userId, cancelReason: 'Salah input' });
      });
    });

    it('lets the deposit itself be cancelled once its refund is cancelled', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        expect((await cancelRefund(fx)).status).toBe(200);

        const r = await callRoute(SIDE[side].router, 'patch', '/:id/cancel', { params: { id: fx.depositId }, ...actor });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect((await tx.payment.findUniqueOrThrow({ where: { id: fx.depositId } })).status).toBe('Cancelled');
        expect(await partyBalance(tx, side, fx.partyId)).toBe(0);
      });
    });

    it('rejects a second cancel with STALE_STATUS and changes nothing more', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        expect((await cancelRefund(fx)).status).toBe(200);

        expectCode(await cancelRefund(fx), STALE_STATUS);
        expect(Number((await tx.payment.findUniqueOrThrow({ where: { id: fx.depositId } })).refundedAmount)).toBe(0);
        expect(await partyBalance(tx, side, fx.partyId)).toBe(10_000_000);
        expect(await accountBalances(tx, [fx.depositAccountId, cashAccountId])).toEqual(fx.balancesBeforeRefund);
      });
    });

    it('rejects a refund in a closed fiscal year with PERIOD_CLOSED', async () => {
      await inRollback(async (tx) => {
        const fy = await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });

        expectCode(await cancelRefund(fx), PERIOD_CLOSED);
        await expectRefundIntact(tx, fx);
      });
    });

    it("rejects another deposit's refund journal", async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const a = await depositWithRefund(tx, side);
        const b = await depositWithRefund(tx, side);

        expectCode(await cancelRefund(a, b.refundJournalId), DEPOSIT_REFUND_MISMATCH);
        await expectRefundIntact(tx, a);
        await expectRefundIntact(tx, b);
      });
    });

    it('returns 403 for a role without doc.cancel', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        const noCancel = await createCapUser(tx, []);

        const r = await cancelRefund(fx, fx.refundJournalId, noCancel);
        expect(r.status).toBe(403);
        await expectRefundIntact(tx, fx);
      });
    });

    it('is rejected by the Journal menu with JOURNAL_USE_DEPOSIT_REFUND_CANCEL', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);

        expectCode(await callRoute(journalsRouter, 'patch', '/:id/cancel', { params: { id: fx.refundJournalId }, ...actor }), JOURNAL_USE_DEPOSIT_REFUND_CANCEL);
        await expectRefundIntact(tx, fx);
      });
    });

    it('cancels a legacy refund without a source key, matched by the exact deposit number', async () => {
      await inRollback(async (tx) => {
        const fy = await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        await tx.journalEntry.update({ where: { id: fx.refundJournalId }, data: { sourceType: null, sourceKey: null } });
        // A deposit whose number extends this one's (PAY-1 vs PAY-10) must not see the refund.
        const longer = await tx.payment.create({
          data: {
            paymentNumber: `${fx.depositNumber}0`, date: new Date(`${Y}-04-01`), partyId: fx.partyId, amount: 1,
            paymentType: SIDE[side].paymentType, accountId: cashAccountId, status: 'Submitted', createdBy: actor.userId,
            fiscalYearId: fy.id,
          },
        });
        const listedOther = await callRoute(SIDE[side].router, 'get', '/:id/refunds', { params: { id: longer.id }, ...actor });
        expect(listedOther.body.data).toEqual([]);
        expectCode(await cancelRefund({ ...fx, depositId: longer.id }), DEPOSIT_REFUND_MISMATCH);

        const r = await cancelRefund(fx);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(Number((await tx.payment.findUniqueOrThrow({ where: { id: fx.depositId } })).refundedAmount)).toBe(0);
        expect(await partyBalance(tx, side, fx.partyId)).toBe(10_000_000);
      });
    });

    it('rejects a refund larger than refundedAmount instead of going negative', async () => {
      await inRollback(async (tx) => {
        await createFiscalYear(tx, { year: Y });
        const fx = await depositWithRefund(tx, side);
        await tx.payment.update({ where: { id: fx.depositId }, data: { refundedAmount: 1_000_000 } });

        expectCode(await cancelRefund(fx), DEPOSIT_REFUND_OVER_CANCEL);
        expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: fx.refundJournalId } })).status).toBe('Submitted');
        expect(Number((await tx.payment.findUniqueOrThrow({ where: { id: fx.depositId } })).refundedAmount)).toBe(1_000_000);
      });
    });
  });
}
