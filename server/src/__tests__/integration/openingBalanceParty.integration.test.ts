/**
 * Integration test: party opening balances through the one opening balance service (E2-R11/R12/R13,
 * PR-5.11): receivable, payable and the two opening deposits, also through POST /payments
 * isOpeningBalance, and the deposit cancel route moved to services/depositCancel.ts.
 *
 * Fixture: fiscal year 2156 (this file's year, plan §6.3) with the global company_settings.cutover_date
 * set to 2156-01-01 inside the rollback transaction; fresh parties per case.
 * - AR 50 jt: keyed OPENING:PARTY:<id>:AR on the cut-over day, opening_receivable and the receivable
 *   side 50 jt, the AR ledger of the party 50 jt; 60 jt replaces it (old journal Cancelled, not deleted);
 *   60 jt again is 'unchanged'.
 * - Both payable 20 jt: AP +20 jt, AR unchanged, payable_outstanding 20 jt.
 * - Ledger rows before the cut-over: OPENING_PARTY_HAS_HISTORY. A consumed opening: OPENING_IN_USE, also
 *   after a real Receive payment of 10 jt with no Invoice (it takes the receivable opening), and for
 *   an opening Customer deposit applied to an Invoice through POST /customer-deposits/apply.
 * - POST /payments isOpeningBalance: another date OPENING_DATE_MISMATCH; the cut-over date posts a keyed
 *   deposit payment; a second one replaces it (old payment Cancelled), the deposit balance is the new
 *   amount, with the reference and notes typed; an old unkeyed opening deposit from the deposit screen is
 *   replaced the same way, also one without any journal (counter account opening equity) and ones posted
 *   before the payment-to-journal link (journal JV-<paymentNumber>, unkeyed or keyed by the audit).
 * - A refunded opening deposit: OPENING_IN_USE. The deposit cancel route still cancels a deposit.
 * - After the year is closed: PERIOD_CLOSED.
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
import {
  OPENING_DATE_MISMATCH,
  OPENING_IN_USE,
  OPENING_PARTY_HAS_HISTORY,
  openingJournalInstant,
  recordedOpening,
  setOpeningBalanceInTx,
} from '../../services/ledger/openingBalance';
import { adjustPartyOpening } from '../../services/ledger/partySides';
import { sourceKeys, type OpeningPartyKind } from '../../services/ledger/journalSource';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import { businessDayOf } from '../../utils/businessDate';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import paymentsRouter from '../../routes/payments';
import customerDepositsRouter from '../../routes/customerDeposits';

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

const Y = 2156;
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

const party = (tx: Tx, partyType: PartyType) =>
  tx.party.create({ data: { name: `IT2156 ${partyType} ${tag()}`, partyType } });

const setParty = (tx: Tx, partyId: string, subledger: OpeningPartyKind, amount: number, asOfDate?: string) =>
  setOpeningBalanceInTx(tx, { target: { kind: 'PARTY', partyId, subledger }, amount: String(amount), userId: actor.userId, asOfDate });

/** Normal-side ledger of a party on one system account role (debit-normal for AR and vendor deposit). */
async function partyLedger(tx: Tx, partyId: string, role: 'AR' | 'AP' | 'CUSTOMER_DEPOSIT' | 'VENDOR_DEPOSIT'): Promise<string> {
  const account = await mappedAccount(tx, role);
  const agg = await tx.accountingLedgerEntry.aggregate({ where: { accountId: account.id, partyId, isCancelled: false }, _sum: { debit: true, credit: true } });
  const debit = agg._sum.debit ?? new Prisma.Decimal(0);
  const credit = agg._sum.credit ?? new Prisma.Decimal(0);
  return (role === 'AR' || role === 'VENDOR_DEPOSIT' ? debit.sub(credit) : credit.sub(debit)).toFixed(2);
}

const columns = (tx: Tx, id: string) =>
  tx.party.findUniqueOrThrow({
    where: { id },
    select: { openingReceivable: true, openingPayable: true, openingOutstanding: true, receivableOutstanding: true, payableOutstanding: true, customerDepositBalance: true, depositBalance: true },
  });

const postPayment = (body: Record<string, unknown>) =>
  callRoute(paymentsRouter, 'post', '/', { userId: actor.userId, role: actor.role, body });

/** The deposit apply route dates its journal today. */
async function ensureOpenToday(tx: Tx) {
  const today = new Date();
  const open = await tx.fiscalYear.findFirst({ where: { startDate: { lte: today }, endDate: { gte: today }, isClosed: false } });
  if (!open) await createFiscalYear(tx, { year: Number(businessDayOf(today).slice(0, 4)) });
}

/**
 * A supplier deposit of the deposit screen's opening branch posted before the payment-to-journal
 * link: journal JV-<paymentNumber> (Dr vendor deposit / Cr opening equity), payment journalEntryId
 * null. `keyed` stores this service's key on the journal, as an accountant keying it would.
 */
async function unlinkedOpeningDeposit(tx: Tx, fy: FiscalYear, partyId: string, partyName: string, amount: number, keyed = false) {
  const dep = await mappedAccount(tx, 'VENDOR_DEPOSIT');
  const eq = await mappedAccount(tx, 'OPENING_EQUITY');
  const date = new Date(`${Y}-02-10T05:00:00.000Z`);
  const number = `PAY-IT2156-${tag()}`;
  const description = `Saldo Awal Uang Muka Vendor: ${number}`;
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `JV-${number}`, date, narration: `${description} - ${partyName}`, status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId,
      ...(keyed ? { sourceType: 'OPENING' as const, sourceKey: sourceKeys.openingParty(partyId, 'VDEP') } : {}),
      items: { create: [{ accountId: dep.id, partyId, debit: amount, credit: 0, description }, { accountId: eq.id, debit: 0, credit: amount, description }] },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: [
      { date, accountId: dep.id, partyId, debit: amount, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, description, fiscalYearId: fy.id },
      { date, accountId: eq.id, debit: 0, credit: amount, referenceType: 'JournalEntry', referenceId: je.id, description, fiscalYearId: fy.id },
    ],
  });
  await updateAccountBalance(tx, dep.id, amount, 0);
  await updateAccountBalance(tx, eq.id, 0, amount);
  const payment = await tx.payment.create({
    data: { paymentNumber: number, date, partyId, paymentType: 'VendorDeposit', accountId: cashAccountId, amount, status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId },
  });
  await tx.party.update({ where: { id: partyId }, data: { depositBalance: { increment: amount } } });
  return { payment, journal: je };
}

d('party opening balance (2156)', () => {
  it('AR: keyed on the cut-over day, replaced (not deleted), then unchanged', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      const first = await setParty(tx, c.id, 'AR', 50 * JT);
      expect(first.action).toBe('posted');
      expect(first.journal).toMatchObject({ sourceType: 'OPENING', sourceKey: sourceKeys.openingParty(c.id, 'AR') });
      expect(first.journal!.date.getTime()).toBe(openingJournalInstant(DAY).getTime());
      expect(await partyLedger(tx, c.id, 'AR')).toBe('50000000.00');
      expect(await columns(tx, c.id)).toMatchObject({ openingReceivable: new Prisma.Decimal(50 * JT), openingOutstanding: new Prisma.Decimal(50 * JT), receivableOutstanding: new Prisma.Decimal(50 * JT) });

      const second = await setParty(tx, c.id, 'AR', 60 * JT);
      expect(second).toMatchObject({ action: 'replaced', cancelled: [first.journal!.entryNumber] });
      const old = await tx.journalEntry.findUniqueOrThrow({ where: { id: first.journal!.id } });
      expect(old.status).toBe('Cancelled');
      expect(await partyLedger(tx, c.id, 'AR')).toBe('60000000.00');
      expect((await columns(tx, c.id)).receivableOutstanding.toFixed(2)).toBe('60000000.00');
      expect((await recordedOpening(tx, { kind: 'PARTY', partyId: c.id, subledger: 'AR' }))?.toFixed(2)).toBe('60000000.00');

      const count = await tx.journalEntry.count({ where: { items: { some: { partyId: c.id } } } });
      await expect(setParty(tx, c.id, 'AR', 60 * JT)).resolves.toMatchObject({ action: 'unchanged' });
      expect(await tx.journalEntry.count({ where: { items: { some: { partyId: c.id } } } })).toBe(count);
    });
  });

  it('Both payable 20 jt: AP up 20 jt, AR unchanged', async () => {
    await inRollback(async (tx) => {
      const b = await party(tx, 'Both');
      await setParty(tx, b.id, 'AP', 20 * JT);
      expect(await partyLedger(tx, b.id, 'AP')).toBe('20000000.00');
      expect(await partyLedger(tx, b.id, 'AR')).toBe('0.00');
      const cols = await columns(tx, b.id);
      expect([cols.openingPayable.toFixed(2), cols.openingReceivable.toFixed(2), cols.payableOutstanding.toFixed(2), cols.receivableOutstanding.toFixed(2)])
        .toEqual(['20000000.00', '0.00', '20000000.00', '0.00']);
    });
  });

  it('refuses a party with receivable rows before the cut-over, and an opening a payment consumed', async () => {
    await inRollback(async (tx, fy) => {
      // A mid-year cut-over, so the history row sits in the same fixture year before it.
      await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${`${Y}-07-01`}::date WHERE slug = 'default'`;
      const ar = await mappedAccount(tx, 'AR');
      const eq = await mappedAccount(tx, 'OPENING_EQUITY');
      const old = await party(tx, 'Customer');
      const date = new Date(`${Y}-03-15T05:00:00.000Z`);
      const je = await tx.journalEntry.create({
        data: {
          entryNumber: `IT2156-${tag()}`, date, narration: 'IT2156 history', status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId, sourceType: 'MANUAL',
          items: { create: [{ accountId: ar.id, partyId: old.id, debit: 1000, credit: 0 }, { accountId: eq.id, debit: 0, credit: 1000 }] },
        },
      });
      await tx.accountingLedgerEntry.createMany({
        data: [
          { date, accountId: ar.id, partyId: old.id, debit: 1000, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
          { date, accountId: eq.id, debit: 0, credit: 1000, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
        ],
      });
      await updateAccountBalance(tx, ar.id, 1000, 0);
      await updateAccountBalance(tx, eq.id, 0, 1000);
      await expect(setParty(tx, old.id, 'AR', 5 * JT)).rejects.toMatchObject({ code: OPENING_PARTY_HAS_HISTORY });

      const used = await party(tx, 'Customer');
      await setParty(tx, used.id, 'AR', 50 * JT);
      await adjustPartyOpening(tx, used.id, 'RECEIVABLE', -10 * JT);
      await expect(setParty(tx, used.id, 'AR', 70 * JT)).rejects.toMatchObject({ code: OPENING_IN_USE });
    });
  });

  it('refuses OPENING_IN_USE after a real Receive payment took part of the receivable opening', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      await setParty(tx, c.id, 'AR', 50 * JT);
      // No Invoice: the whole payment is a remainder, which takes the receivable opening (PR-5.13).
      const paid = await submitPaymentInTx(tx, { date: `${Y}-02-01`, partyId: c.id, paymentType: 'Receive', accountId: cashAccountId, amount: 10 * JT }, actor.userId);
      expect(paid.unallocatedAmount).toBe(10 * JT);
      const cols = await columns(tx, c.id);
      expect([cols.openingReceivable.toFixed(2), cols.openingOutstanding.toFixed(2)]).toEqual(['40000000.00', '40000000.00']);
      await expect(setParty(tx, c.id, 'AR', 60 * JT)).rejects.toMatchObject({ code: OPENING_IN_USE });
    });
  });

  it('refuses OPENING_IN_USE for an opening Customer deposit applied to an Invoice', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      const out = await setParty(tx, c.id, 'CDEP', 10 * JT);
      const si = await submitSalesInvoiceInTx(
        tx,
        { date: `${Y}-03-01`, partyId: c.id, items: [{ itemName: 'IT2156 jasa', itemType: 'service', quantity: 1, rate: 10 * JT }] } as any,
        actor.userId,
      );
      await ensureOpenToday(tx);
      const applied = await callRoute(customerDepositsRouter, 'post', '/apply', {
        userId: actor.userId, role: actor.role, body: { depositPaymentId: out.payment!.id, salesInvoiceId: si.id, amount: 4 * JT },
      });
      expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
      await expect(setParty(tx, c.id, 'CDEP', 12 * JT)).rejects.toMatchObject({ code: OPENING_IN_USE });
      expect((await tx.payment.findUniqueOrThrow({ where: { id: out.payment!.id } })).status).toBe('Submitted');
    });
  });

  it('opening deposit through POST /payments: cut-over date only, keyed, a second one replaces', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      const body = { partyId: c.id, paymentType: 'CustomerDeposit', accountId: 'opening-equity', isOpeningBalance: true };
      const wrong = await postPayment({ ...body, date: `${Y}-03-15`, amount: 5 * JT });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe(OPENING_DATE_MISMATCH);

      const first = await postPayment({ ...body, date: DAY, amount: 5 * JT, referenceNo: 'KW-123', notes: 'sisa DP 2155' });
      expect(first.status).toBe(201);
      const p1 = await tx.payment.findUniqueOrThrow({ where: { id: first.body.id }, include: { journalEntry: true } });
      expect(p1.journalEntry).toMatchObject({ sourceType: 'OPENING', sourceKey: `OPENING:PARTY:${c.id}:CDEP` });
      expect(p1).toMatchObject({ referenceNo: 'KW-123', notes: 'sisa DP 2155' });
      expect((await columns(tx, c.id)).customerDepositBalance.toFixed(2)).toBe('5000000.00');

      const second = await postPayment({ ...body, date: DAY, amount: 7 * JT });
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(p1.id);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: p1.id } })).status).toBe('Cancelled');
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: p1.journalEntryId! } })).status).toBe('Cancelled');
      expect((await columns(tx, c.id)).customerDepositBalance.toFixed(2)).toBe('7000000.00');
      expect(await partyLedger(tx, c.id, 'CUSTOMER_DEPOSIT')).toBe('7000000.00');

      const again = await postPayment({ ...body, date: DAY, amount: 7 * JT });
      expect(again.body.id).toBe(second.body.id);
    });
  });

  it('replaces an old unkeyed opening deposit of the deposit screen; refuses a refunded one', async () => {
    await inRollback(async (tx, fy) => {
      const s = await party(tx, 'Supplier');
      const dep = await mappedAccount(tx, 'VENDOR_DEPOSIT');
      const eq = await mappedAccount(tx, 'OPENING_EQUITY');
      const date = new Date(`${Y}-02-10T05:00:00.000Z`);
      const number = `PAY-IT2156-${tag()}`;
      const je = await tx.journalEntry.create({
        data: {
          entryNumber: `JV-${number}`, date, narration: `Saldo Awal Uang Muka Vendor: ${number} - ${s.name}`, status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId,
          items: { create: [{ accountId: dep.id, partyId: s.id, debit: 3 * JT, credit: 0 }, { accountId: eq.id, debit: 0, credit: 3 * JT }] },
        },
      });
      await tx.accountingLedgerEntry.createMany({
        data: [
          { date, accountId: dep.id, partyId: s.id, debit: 3 * JT, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
          { date, accountId: eq.id, debit: 0, credit: 3 * JT, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
        ],
      });
      await updateAccountBalance(tx, dep.id, 3 * JT, 0);
      await updateAccountBalance(tx, eq.id, 0, 3 * JT);
      const legacy = await tx.payment.create({
        data: {
          paymentNumber: number, date, partyId: s.id, paymentType: 'VendorDeposit', accountId: eq.id, amount: 3 * JT, status: 'Submitted',
          fiscalYearId: fy.id, createdBy: actor.userId, journalEntryId: je.id,
        },
      });
      await tx.party.update({ where: { id: s.id }, data: { depositBalance: 3 * JT } });

      const out = await setParty(tx, s.id, 'VDEP', 4 * JT, DAY);
      expect(out).toMatchObject({ action: 'replaced', cancelled: [`JV-${number}`] });
      expect((await tx.payment.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('Cancelled');
      expect((await columns(tx, s.id)).depositBalance.toFixed(2)).toBe('4000000.00');
      expect(await partyLedger(tx, s.id, 'VENDOR_DEPOSIT')).toBe('4000000.00');

      await tx.payment.update({ where: { id: out.payment!.id }, data: { refundedAmount: 1 } });
      await expect(setParty(tx, s.id, 'VDEP', 5 * JT)).rejects.toMatchObject({ code: OPENING_IN_USE });
    });
  });

  it('replaces a journal-less opening deposit of the old deposit screen instead of adding to it', async () => {
    await inRollback(async (tx, fy) => {
      const s = await party(tx, 'Supplier');
      const dep = await mappedAccount(tx, 'VENDOR_DEPOSIT');
      const eq = await mappedAccount(tx, 'OPENING_EQUITY');
      // A legacy deposit with stored balances only: no journal and no ledger rows.
      await updateAccountBalance(tx, dep.id, 10 * JT, 0);
      await updateAccountBalance(tx, eq.id, 0, 10 * JT);
      const legacy = await tx.payment.create({
        data: {
          paymentNumber: `PAY-IT2156-${tag()}`, date: new Date(`${Y}-01-15T05:00:00.000Z`), partyId: s.id, paymentType: 'VendorDeposit', accountId: eq.id,
          amount: 10 * JT, status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId,
        },
      });
      await tx.party.update({ where: { id: s.id }, data: { depositBalance: 10 * JT } });

      const res = await postPayment({ partyId: s.id, paymentType: 'VendorDeposit', accountId: 'opening-equity', isOpeningBalance: true, date: DAY, amount: 10 * JT });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.id).not.toBe(legacy.id);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('Cancelled');
      expect((await columns(tx, s.id)).depositBalance.toFixed(2)).toBe('10000000.00');
      expect(await partyLedger(tx, s.id, 'VENDOR_DEPOSIT')).toBe('10000000.00');
    });
  });

  it.each([
    ['unkeyed', false],
    ['keyed by the audit', true],
  ])('replaces an %s opening deposit posted before the payment-to-journal link through its payment', async (_name, keyed) => {
    await inRollback(async (tx, fy) => {
      const s = await party(tx, 'Supplier');
      const old = await unlinkedOpeningDeposit(tx, fy, s.id, s.name, 3 * JT, keyed);
      const out = await setParty(tx, s.id, 'VDEP', 4 * JT);
      expect(out).toMatchObject({ action: 'replaced', cancelled: [old.journal.entryNumber] });
      expect((await tx.payment.findUniqueOrThrow({ where: { id: old.payment.id } })).status).toBe('Cancelled');
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: old.journal.id } })).status).toBe('Cancelled');
      expect((await columns(tx, s.id)).depositBalance.toFixed(2)).toBe('4000000.00');
      expect(await partyLedger(tx, s.id, 'VENDOR_DEPOSIT')).toBe('4000000.00');
    });
  });

  it('the deposit cancel route cancels an opening deposit (payment and journal Cancelled, balance back)', async () => {
    await inRollback(async (tx) => {
      const c = await party(tx, 'Customer');
      const out = await setParty(tx, c.id, 'CDEP', 2 * JT);
      const res = await callRoute(customerDepositsRouter, 'patch', '/:id/cancel', {
        userId: actor.userId, role: actor.role, params: { id: out.payment!.id }, body: { reason: 'Uji batal uang muka' },
      });
      expect(res.status).toBe(200);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: out.payment!.id } })).status).toBe('Cancelled');
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: out.journal!.id } })).status).toBe('Cancelled');
      expect((await columns(tx, c.id)).customerDepositBalance.toFixed(2)).toBe('0.00');
      expect(await partyLedger(tx, c.id, 'CUSTOMER_DEPOSIT')).toBe('0.00');
    });
  });

  it('refuses to replace an opening balance once its year is closed', async () => {
    await inRollback(async (tx, fy) => {
      const c = await party(tx, 'Customer');
      await setParty(tx, c.id, 'AR', 5 * JT);
      await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
      await expect(setParty(tx, c.id, 'AR', 6 * JT)).rejects.toMatchObject({ code: PERIOD_CLOSED });
    });
  });
});
