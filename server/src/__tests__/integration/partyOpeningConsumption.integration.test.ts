/**
 * Integration test: what a Receive/Pay remainder takes from the party opening, per side, and how a
 * payment cancel and a refund put it back (E2-R13 acceptance "opening A 50 jt, A pays 10 jt:
 * outstanding 40 jt = GL", also after the cancel; PR-5.13), plus the party opening audit core
 * (services/ledger/partyOpeningAudit.ts, scripts/repair/e2-party-opening-audit.ts).
 *
 * Fixture: fiscal year 2158 (this file's year, plan §6.3) with the global company_settings.cutover_date
 * set to 2158-01-01 inside the rollback transaction; fresh parties per case, openings through the
 * opening balance service, so every ledger row is balanced.
 * - Customer 50 jt, Receive 10 jt without an Invoice: opening_receivable 40 jt = AR ledger, one
 *   OpeningReceivable allocation; cancel through POST /payments/:id/cancel: 50 jt = AR ledger.
 * - CustomerRefund 4 jt against that payment: the opening is back to 44 jt = AR ledger, allocation 6 jt.
 * - Both with a receivable opening: a Pay remainder leaves opening_receivable alone; with a payable
 *   opening it takes the payable one.
 * - GET /payments/:id shows the allocation type with no invoice number.
 * - Audit: consumed-opening-not-restored (a Cancelled Receive whose remainder was not put back) and
 *   opening-from-single-journal (an imported opening left undirected) are corrected by --apply,
 *   one audit row each, then match; a second run changes nothing. Both stays a report.
 * - Committed rows: two remainders at once on one party take at most the opening.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient, type FiscalYear, type PartyType } from '@prisma/client';
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
import { setOpeningBalanceInTx } from '../../services/ledger/openingBalance';
import { adjustPartyOpening } from '../../services/ledger/partySides';
import { findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { consumePartyOpening } from '../../services/ledger/partyOpeningConsumption';
import {
  PARTY_OPENING_AUDIT_ACTION,
  applyPartyOpeningAudit,
  planPartyOpeningAudit,
} from '../../services/ledger/partyOpeningAudit';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import paymentsRouter from '../../routes/payments';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let actor: { userId: string; role: string };
let cashAccountId: string;

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

const Y = 2158;
const DAY = `${Y}-01-01`;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function inRollback(fn: (tx: Tx, fy: FiscalYear) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        actor = await createCapUser(tx, ['doc.cancel']);
        const fy = await createFiscalYear(tx, { year: Y });
        await tx.companySettings.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', companyName: '' } });
        await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${DAY}::date WHERE slug = 'default'`;
        await fn(tx, fy);
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

const party = (tx: Tx, partyType: PartyType, data: Prisma.PartyCreateInput | object = {}) =>
  tx.party.create({ data: { name: `IT2158 ${partyType} ${tag()}`, partyType, ...data } });

const setOpening = (tx: Tx, partyId: string, subledger: 'AR' | 'AP', amount: number) =>
  setOpeningBalanceInTx(tx, { target: { kind: 'PARTY', partyId, subledger }, amount: String(amount), userId: actor.userId });

const pay = (tx: Tx, partyId: string, paymentType: 'Receive' | 'Pay' | 'CustomerRefund', amount: number, refundSourcePaymentId?: string) =>
  submitPaymentInTx(tx, { date: `${Y}-02-01`, partyId, paymentType, accountId: cashAccountId, amount, refundSourcePaymentId }, actor.userId);

/** Normal-side ledger of a party on AR (debit) or AP (credit). */
async function partyLedger(tx: Tx, partyId: string, role: 'AR' | 'AP'): Promise<string> {
  const account = await mappedAccount(tx, role);
  const agg = await tx.accountingLedgerEntry.aggregate({ where: { accountId: account.id, partyId, isCancelled: false }, _sum: { debit: true, credit: true } });
  const debit = agg._sum.debit ?? new Prisma.Decimal(0);
  const credit = agg._sum.credit ?? new Prisma.Decimal(0);
  return (role === 'AR' ? debit.sub(credit) : credit.sub(debit)).toFixed(2);
}

async function columns(tx: Tx, id: string) {
  const p = await tx.party.findUniqueOrThrow({
    where: { id },
    select: { openingReceivable: true, openingPayable: true, openingOutstanding: true, receivableOutstanding: true, payableOutstanding: true },
  });
  return {
    openingReceivable: p.openingReceivable.toFixed(2), openingPayable: p.openingPayable.toFixed(2), openingOutstanding: p.openingOutstanding.toFixed(2),
    receivable: p.receivableOutstanding.toFixed(2), payable: p.payableOutstanding.toFixed(2),
  };
}

const allocations = async (tx: Tx, paymentId: string) =>
  (await tx.paymentAllocation.findMany({ where: { paymentId }, orderBy: { invoiceType: 'asc' } }))
    .map((a) => [a.invoiceType, a.invoiceId, a.allocatedAmount.toFixed(2)]);

/** An opening journal of the old party import: Dr AR (party) / Cr opening equity, sourceType OPENING, no key. */
async function importedOpening(tx: Tx, fy: FiscalYear, partyId: string, amount: number) {
  const ar = await mappedAccount(tx, 'AR');
  const eq = await mappedAccount(tx, 'OPENING_EQUITY');
  const date = new Date(`${Y}-01-01T05:00:00.000Z`);
  const description = 'Saldo awal piutang: IT2158';
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `OB-IT2158-${tag()}`, date, narration: description, status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId, sourceType: 'OPENING',
      items: { create: [{ accountId: ar.id, partyId, debit: amount, credit: 0, description }, { accountId: eq.id, debit: 0, credit: amount, description }] },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: [
      { date, accountId: ar.id, partyId, debit: amount, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, description, fiscalYearId: fy.id },
      { date, accountId: eq.id, debit: 0, credit: amount, referenceType: 'JournalEntry', referenceId: je.id, description, fiscalYearId: fy.id },
    ],
  });
  await updateAccountBalance(tx, ar.id, amount, 0);
  await updateAccountBalance(tx, eq.id, 0, amount);
}

d('party opening consumption (2158)', () => {
  it('Customer 50 jt pays 10 jt: 40 jt = AR ledger; cancelling the payment: 50 jt = AR ledger', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      await setOpening(tx, c.id, 'AR', 50 * JT);
      const paid = await pay(tx, c.id, 'Receive', 10 * JT);
      expect(paid.unallocatedAmount).toBe(10 * JT);
      expect(await columns(tx, c.id)).toMatchObject({ openingReceivable: '40000000.00', openingOutstanding: '40000000.00', receivable: '40000000.00' });
      expect(await partyLedger(tx, c.id, 'AR')).toBe('40000000.00');
      expect(await allocations(tx, paid.payment.id)).toEqual([['OpeningReceivable', c.id, '10000000.00']]);
      expect(await findArSubledgerDiffs(tx, { partyIds: [c.id] })).toEqual([]);

      const detail = await callRoute(paymentsRouter, 'get', '/:id', { params: { id: paid.payment.id }, userId: actor.userId, role: actor.role });
      expect(detail.status).toBe(200);
      expect(detail.body.allocations).toEqual([expect.objectContaining({ invoiceType: 'OpeningReceivable', invoiceId: c.id, invoiceNumber: null })]);

      const cancel = await callRoute(paymentsRouter, 'post', '/:id/cancel', { params: { id: paid.payment.id }, body: { reason: 'IT2158' }, userId: actor.userId, role: actor.role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect(await columns(tx, c.id)).toMatchObject({ openingReceivable: '50000000.00', openingOutstanding: '50000000.00', receivable: '50000000.00' });
      expect(await partyLedger(tx, c.id, 'AR')).toBe('50000000.00');
      expect(await allocations(tx, paid.payment.id)).toEqual([]);
      expect(await findArSubledgerDiffs(tx, { partyIds: [c.id] })).toEqual([]);
    });
  });

  it('a refund against that payment puts the opening back: 44 jt = AR ledger', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      await setOpening(tx, c.id, 'AR', 50 * JT);
      const paid = await pay(tx, c.id, 'Receive', 10 * JT);
      await pay(tx, c.id, 'CustomerRefund', 4 * JT, paid.payment.id);
      expect(await columns(tx, c.id)).toMatchObject({ openingReceivable: '44000000.00', openingOutstanding: '44000000.00', receivable: '44000000.00' });
      expect(await partyLedger(tx, c.id, 'AR')).toBe('44000000.00');
      expect(await allocations(tx, paid.payment.id)).toEqual([['OpeningReceivable', c.id, '6000000.00']]);
      expect(await findArSubledgerDiffs(tx, { partyIds: [c.id] })).toEqual([]);
      // More than the source payment took is still refused.
      await expect(pay(tx, c.id, 'CustomerRefund', 7 * JT, paid.payment.id)).rejects.toThrow(/melebihi/);
    });
  });

  it('a Both Pay remainder takes the payable opening, never the receivable one', async () => {
    await inRollback(async (tx) => {
      const b = await party(tx, 'Both');
      await setOpening(tx, b.id, 'AR', 30 * JT);
      const first = await pay(tx, b.id, 'Pay', 5 * JT);
      expect(await allocations(tx, first.payment.id)).toEqual([]);
      expect(await columns(tx, b.id)).toMatchObject({ openingReceivable: '30000000.00', openingPayable: '0.00', openingOutstanding: '30000000.00' });

      await setOpening(tx, b.id, 'AP', 20 * JT);
      const second = await pay(tx, b.id, 'Pay', 5 * JT);
      expect(await allocations(tx, second.payment.id)).toEqual([['OpeningPayable', b.id, '5000000.00']]);
      expect(await columns(tx, b.id)).toMatchObject({ openingReceivable: '30000000.00', openingPayable: '15000000.00', receivable: '30000000.00', payable: '15000000.00' });
      // The first Pay took no opening: it stays an overpayment (logged) on the AP ledger, 20 − 5 − 5.
      expect(await partyLedger(tx, b.id, 'AP')).toBe('10000000.00');
      expect(await partyLedger(tx, b.id, 'AR')).toBe('30000000.00');
    });
  });

  it('a Customer remainder takes an undirected opening and the cancel puts it back undirected', async () => {
    await inRollback(async (tx, fy) => {
      const c = await party(tx, 'Customer', { openingOutstanding: 20 * JT });
      await importedOpening(tx, fy, c.id, 20 * JT);
      const paid = await pay(tx, c.id, 'Receive', 8 * JT);
      expect(await allocations(tx, paid.payment.id)).toEqual([['OpeningUnassigned', c.id, '8000000.00']]);
      expect(await columns(tx, c.id)).toMatchObject({ openingReceivable: '0.00', openingOutstanding: '12000000.00', receivable: '12000000.00' });
      expect(await partyLedger(tx, c.id, 'AR')).toBe('12000000.00');
      const cancel = await callRoute(paymentsRouter, 'post', '/:id/cancel', { params: { id: paid.payment.id }, body: {}, userId: actor.userId, role: actor.role });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect(await columns(tx, c.id)).toMatchObject({ openingReceivable: '0.00', openingOutstanding: '20000000.00', receivable: '20000000.00' });
    });
  });
});

d('party opening audit (2158)', () => {
  it('corrects consumed-opening-not-restored and opening-from-single-journal, once; Both is a report', async () => {
    await inRollback(async (tx, fy) => {
      // A cancel before PR-5.13: the payment is Cancelled, its journal void, the opening still 10 jt short.
      const short = await party(tx, 'Customer');
      await setOpening(tx, short.id, 'AR', 50 * JT);
      const paid = await pay(tx, short.id, 'Receive', 10 * JT);
      const cancel = await callRoute(paymentsRouter, 'post', '/:id/cancel', { params: { id: paid.payment.id }, body: {}, userId: actor.userId, role: actor.role });
      expect(cancel.status).toBe(200);
      await adjustPartyOpening(tx, short.id, 'RECEIVABLE', -10 * JT);

      const imported = await party(tx, 'Customer', { openingOutstanding: 25 * JT, receivableOutstanding: 25 * JT, outstandingAmount: 25 * JT });
      await importedOpening(tx, fy, imported.id, 25 * JT);

      const both = await party(tx, 'Both', { openingOutstanding: 9 * JT });
      await importedOpening(tx, fy, both.id, 6 * JT);

      const ids = [short.id, imported.id, both.id];
      const plan = await planPartyOpeningAudit(tx, ids);
      const cls = Object.fromEntries(plan.map((r) => [r.figures.partyId, r.verdict.cls]));
      expect(cls).toEqual({ [short.id]: 'consumed-opening-not-restored', [imported.id]: 'opening-from-single-journal', [both.id]: 'both-needs-accountant' });

      await expect(applyPartyOpeningAudit(tx, ids, { approvedBy: null })).rejects.toThrow(/approved-by/);
      const applied = await applyPartyOpeningAudit(tx, ids, { approvedBy: 'IT Akuntan' });
      expect(applied.map((a) => a.partyId).sort()).toEqual([short.id, imported.id].sort());
      expect(await columns(tx, short.id)).toMatchObject({ openingReceivable: '50000000.00', openingOutstanding: '50000000.00', receivable: '50000000.00' });
      expect(await columns(tx, imported.id)).toMatchObject({ openingReceivable: '25000000.00', openingOutstanding: '25000000.00', receivable: '25000000.00' });
      expect(await columns(tx, both.id)).toMatchObject({ openingReceivable: '0.00', openingOutstanding: '9000000.00' });
      expect(await findArSubledgerDiffs(tx, { partyIds: [short.id, imported.id] })).toEqual([]);

      const audits = await tx.auditLog.findMany({ where: { action: PARTY_OPENING_AUDIT_ACTION, entityId: { in: ids } } });
      expect(audits).toHaveLength(2);
      expect(audits.every((a) => a.via === 'repair' && (a.viaMeta as { approvedBy?: string }).approvedBy === 'IT Akuntan')).toBe(true);

      const again = await planPartyOpeningAudit(tx, ids);
      expect(Object.fromEntries(again.map((r) => [r.figures.partyId, r.verdict.cls])))
        .toEqual({ [short.id]: 'match', [imported.id]: 'match', [both.id]: 'both-needs-accountant' });
      expect(await applyPartyOpeningAudit(tx, ids, { approvedBy: 'IT Akuntan' })).toEqual([]);
    });
  });
});

d('party opening consumption (committed rows)', () => {
  const created: { partyId?: string; paymentIds: string[]; fyId?: string } = { paymentIds: [] };

  afterAll(async () => {
    if (!hasDb) return;
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: created.paymentIds } } });
    await prisma.payment.deleteMany({ where: { id: { in: created.paymentIds } } });
    if (created.partyId) await prisma.party.delete({ where: { id: created.partyId } });
    if (created.fyId) await prisma.fiscalYear.delete({ where: { id: created.fyId } });
  });

  it('two remainders at once take at most the opening; the allocations add up to what was taken', async () => {
    const admin = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
    if (!admin) throw new Error('No active Admin user in the database.');
    const fy = await createFiscalYear(prisma as unknown as Tx, { year: Y });
    created.fyId = fy.id;
    const p = await prisma.party.create({ data: { name: `IT2158 Race ${tag()}`, partyType: 'Customer', openingOutstanding: 100, openingReceivable: 100 } });
    created.partyId = p.id;
    for (const n of [1, 2]) {
      const payment = await prisma.payment.create({
        data: {
          paymentNumber: `PAY-IT2158-${n}-${tag()}`, date: new Date(`${Y}-02-01T05:00:00.000Z`), partyId: p.id, paymentType: 'Receive',
          accountId: cashAccountId, amount: 70, status: 'Submitted', fiscalYearId: fy.id, createdBy: admin.id,
        },
      });
      created.paymentIds.push(payment.id);
    }
    const [a, b] = created.paymentIds;
    let second: Promise<Prisma.Decimal> | null = null;
    const first = await prisma.$transaction(async (tx) => {
      const taken = await consumePartyOpening(tx, a, p.id, 'RECEIVABLE', 70);
      second = prisma.$transaction((t) => consumePartyOpening(t, b, p.id, 'RECEIVABLE', 70));
      await new Promise((r) => setTimeout(r, 300));
      return taken;
    }, { timeout: 20000 });
    expect(first.toFixed(2)).toBe('70.00');
    expect((await second!).toFixed(2)).toBe('30.00');
    const after = await prisma.party.findUniqueOrThrow({ where: { id: p.id }, select: { openingReceivable: true, openingOutstanding: true } });
    expect([after.openingReceivable.toFixed(2), after.openingOutstanding.toFixed(2)]).toEqual(['0.00', '0.00']);
    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: { in: created.paymentIds } } });
    expect(allocs.reduce((s, x) => s.plus(x.allocatedAmount), new Prisma.Decimal(0)).toFixed(2)).toBe('100.00');
    expect(allocs.every((x) => x.invoiceType === 'OpeningReceivable')).toBe(true);
  });
});
