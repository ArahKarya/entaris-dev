/**
 * Integration test: POST /journals posts through createManualJournalInTx -> postJournal (E2-R3,
 * E2-R4, PR-4.4b) and the Journal menu cancel recalculates party balances.
 *
 * Fixture year 2179 (unique to this file). Everything runs in a rollback transaction with its own
 * fiscal year, users, parties and accounts; the receivable, inventory and customer deposit
 * accounts are the seed's AR, INVENTORY and CUSTOMER_DEPOSIT mappings.
 * - Dr 100.000,01 / Cr 100.000,00 -> 400 JOURNAL_UNBALANCED (no tolerance); a 0/0 line -> 400 LINE_EMPTY.
 * - A Supplier on an expense line -> 400 PARTY_NOT_ALLOWED.
 * - Dr inventory 50 jt without journal.control -> 400 ACCOUNT_CONTROL; with it -> 201 MANUAL.
 * - Dr Piutang 5 jt for Customer B with journal.control -> outstanding B 5 jt, still 5 jt after
 *   recalcPartyOutstanding, AR check green for B; the menu cancel brings it back to 0.
 * - Dr Piutang for a Supplier -> 400 PARTY_TYPE_MISMATCH; without a party -> 400 PARTY_REQUIRED.
 * - Cr Uang Muka Customer with journal.control -> 400 ACCOUNT_CONTROL.
 * - Cancelling an old RECURRING journal with a Customer on AR does not push the outstanding below
 *   the recalculated value; cancelling an old MANUAL deposit line reverses the deposit balance.
 * - The menu cancel of a journal on a control or deposit account needs journal.control
 *   (ACCOUNT_CONTROL before any balance moves); a journal without one stays cancellable.
 * - GET /coa/flat gives each account its partyRole (AR, CUSTOMER_DEPOSIT, ...) or null.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type JournalSourceType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import journalsRouter from '../../routes/journals';
import coaRouter from '../../routes/coa';

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
      invalidatePermissionCache();
      try {
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

const Y = 2179;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const short = () => Math.random().toString(36).slice(2, 8).toUpperCase();

type Actor = { userId: string; role: string };

interface Books {
  fyId: string;
  plain: Actor;
  control: Actor;
  arId: string;
  inventoryId: string;
  depositId: string;
  expenseId: string;
  cashId: string;
}

async function mapped(tx: Tx, role: string): Promise<string> {
  const m = await tx.systemAccountMapping.findFirst({ where: { role }, select: { accountId: true } });
  if (!m) throw new Error(`${role} is not mapped (seed).`);
  return m.accountId;
}

async function books(tx: Tx): Promise<Books> {
  const account = (name: string, rootType: 'EXPENSE' | 'ASSET') =>
    tx.account.create({ data: { name: `IT-JMN ${name}`, accountNumber: `IT-JMN-${tag()}`, accountType: rootType, rootType } });
  return {
    fyId: (await createFiscalYear(tx, { year: Y })).id,
    plain: await createCapUser(tx, ['doc.cancel']),
    control: await createCapUser(tx, ['doc.cancel', 'journal.control']),
    arId: await mapped(tx, 'AR'),
    inventoryId: await mapped(tx, 'INVENTORY'),
    depositId: await mapped(tx, 'CUSTOMER_DEPOSIT'),
    expenseId: (await account('Beban', 'EXPENSE')).id,
    cashId: (await account('Kas', 'ASSET')).id,
  };
}

const party = async (tx: Tx, partyType: 'Customer' | 'Supplier') =>
  (await tx.party.create({ data: { name: `IT-JMN ${partyType} ${tag()}`, partyType } })).id;

type Item = { accountId: string; debit?: number | string; credit?: number | string; partyId?: string | null };

function post(who: Actor, items: Item[], narration = `IT-JMN ${tag()}`) {
  return callRoute(journalsRouter, 'post', '/', {
    body: { date: `${Y}-03-10`, narration, items: items.map((i) => ({ debit: 0, credit: 0, ...i })) },
    ...who,
  });
}

function cancel(who: Actor, id: string) {
  return callRoute(journalsRouter, 'patch', '/:id/cancel', { params: { id }, body: { reason: 'Uji jurnal manual' }, ...who });
}

function expectCode(r: RouteResult, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(code);
}

async function outstanding(tx: Tx, partyId: string): Promise<string> {
  return (await tx.party.findUniqueOrThrow({ where: { id: partyId } })).outstandingAmount.toFixed(2);
}

/** A journal stored the way an older writer left it: items and ledger rows with their party. */
async function legacyJournal(tx: Tx, b: Books, sourceType: JournalSourceType, lines: Item[]): Promise<string> {
  const date = new Date(`${Y}-03-05T00:00:00+07:00`);
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-JMN-${short()}`, date, narration: 'Jurnal lama', status: 'Submitted', fiscalYearId: b.fyId,
      createdBy: b.control.userId, submittedAt: date, sourceType,
      items: { create: lines.map((l) => ({ accountId: l.accountId, partyId: l.partyId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0 })) },
    },
    include: { items: true },
  });
  await tx.accountingLedgerEntry.createMany({
    data: je.items.map((i) => ({
      date, accountId: i.accountId, partyId: i.partyId, debit: i.debit, credit: i.credit,
      referenceType: 'JournalEntry', referenceId: je.id, description: 'Jurnal lama', fiscalYearId: b.fyId,
    })),
  });
  return je.id;
}

d('manual journal: one validator, no tolerance', () => {
  it('Dr 100.000,01 / Cr 100.000,00 is refused with JOURNAL_UNBALANCED and writes nothing', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const narration = `IT-JMN unbalanced ${tag()}`;
      expectCode(await post(b.plain, [
        { accountId: b.expenseId, debit: 100_000.01 },
        { accountId: b.cashId, credit: 100_000 },
      ], narration), 'JOURNAL_UNBALANCED');
      expect(await tx.journalEntry.count({ where: { narration } })).toBe(0);
    });
  });

  it('a 0/0 line is refused with LINE_EMPTY', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      expectCode(await post(b.plain, [
        { accountId: b.expenseId, debit: 10_000 },
        { accountId: b.cashId, credit: 10_000 },
        { accountId: b.expenseId, debit: 0, credit: 0 },
      ]), 'LINE_EMPTY');
    });
  });
});

d('manual journal: accounts and parties (E2-R4)', () => {
  it('a Supplier on an expense line is refused with PARTY_NOT_ALLOWED', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const supplierA = await party(tx, 'Supplier');
      expectCode(await post(b.control, [
        { accountId: b.expenseId, debit: 250_000, partyId: supplierA },
        { accountId: b.cashId, credit: 250_000 },
      ]), 'PARTY_NOT_ALLOWED');
    });
  });

  it('Dr inventory 50 jt needs journal.control: ACCOUNT_CONTROL without it, 201 MANUAL with it', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const lines = [{ accountId: b.inventoryId, debit: 50 * JT }, { accountId: b.cashId, credit: 50 * JT }];
      const before = (await tx.account.findUniqueOrThrow({ where: { id: b.inventoryId } })).balance;
      expectCode(await post(b.plain, lines), 'ACCOUNT_CONTROL');
      expect((await tx.account.findUniqueOrThrow({ where: { id: b.inventoryId } })).balance.toFixed(2)).toBe(before.toFixed(2));

      const ok = await post(b.control, lines);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.sourceType).toBe('MANUAL');
      expect(ok.body.entryNumber).toMatch(/^JV-/);
      expect(ok.body.items).toHaveLength(2);
      expect(ok.body.items[0].account).toEqual(expect.objectContaining({ accountNumber: expect.any(String), rootType: 'ASSET' }));
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: ok.body.id, isCancelled: false } })).toBe(2);
      expect((await tx.account.findUniqueOrThrow({ where: { id: b.inventoryId } })).balance.toFixed(2)).toBe(before.plus(50 * JT).toFixed(2));
    });
  });

  it('Dr Piutang 5 jt for Customer B: outstanding 5 jt, still after recalc, AR check green; the menu cancel takes it back', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customerB = await party(tx, 'Customer');
      const r = await post(b.control, [
        { accountId: b.arId, debit: 5 * JT, partyId: customerB },
        { accountId: b.cashId, credit: 5 * JT },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await outstanding(tx, customerB)).toBe('5000000.00');
      const ale = await tx.accountingLedgerEntry.findFirstOrThrow({ where: { referenceId: r.body.id, accountId: b.arId } });
      expect(ale.partyId).toBe(customerB);

      await recalcPartyOutstanding(tx, customerB);
      expect(await outstanding(tx, customerB)).toBe('5000000.00');
      expect(await findArSubledgerDiffs(tx, { partyIds: [customerB] })).toEqual([]);

      const c = await cancel(b.control, r.body.id);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      expect(await outstanding(tx, customerB)).toBe('0.00');
      expect(await findArSubledgerDiffs(tx, { partyIds: [customerB] })).toEqual([]);
    });
  });

  it('Dr Piutang for a Supplier is PARTY_TYPE_MISMATCH; without a party PARTY_REQUIRED', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const supplier = await party(tx, 'Supplier');
      expectCode(await post(b.control, [
        { accountId: b.arId, debit: JT, partyId: supplier },
        { accountId: b.cashId, credit: JT },
      ]), 'PARTY_TYPE_MISMATCH');
      expectCode(await post(b.control, [
        { accountId: b.arId, debit: JT },
        { accountId: b.cashId, credit: JT },
      ]), 'PARTY_REQUIRED');
    });
  });

  it('Cr Uang Muka Customer is refused with ACCOUNT_CONTROL even with journal.control', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx, 'Customer');
      expectCode(await post(b.control, [
        { accountId: b.cashId, debit: JT },
        { accountId: b.depositId, credit: JT, partyId: customer },
      ]), 'ACCOUNT_CONTROL');
    });
  });
});

d('Journal menu cancel: party balances (R2 S-3)', () => {
  it('cancelling an old RECURRING journal with a Customer on AR leaves the outstanding at the recalculated value', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customerB = await party(tx, 'Customer');
      const manual = await post(b.control, [
        { accountId: b.arId, debit: 5 * JT, partyId: customerB },
        { accountId: b.cashId, credit: 5 * JT },
      ]);
      expect(manual.status, JSON.stringify(manual.body)).toBe(201);
      // The old recurring runner never moved the party balance, so the outstanding stayed at 5 jt.
      const recurring = await legacyJournal(tx, b, 'RECURRING', [
        { accountId: b.arId, debit: 2 * JT, partyId: customerB },
        { accountId: b.cashId, credit: 2 * JT },
      ]);
      expect(await outstanding(tx, customerB)).toBe('5000000.00');

      const c = await cancel(b.control, recurring);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const afterCancel = await outstanding(tx, customerB);
      await recalcPartyOutstanding(tx, customerB);
      expect(afterCancel).toBe(await outstanding(tx, customerB));
      expect(afterCancel).toBe('5000000.00');
    });
  });

  it('cancelling an old MANUAL journal with a customer deposit line reverses the deposit balance', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx, 'Customer');
      const old = await legacyJournal(tx, b, 'MANUAL', [
        { accountId: b.cashId, debit: JT },
        { accountId: b.depositId, credit: JT, partyId: customer },
      ]);
      // What the old POST applied for the deposit line.
      await tx.party.update({ where: { id: customer }, data: { customerDepositBalance: JT } });

      const c = await cancel(b.control, old);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const p = await tx.party.findUniqueOrThrow({ where: { id: customer } });
      expect(p.customerDepositBalance.toFixed(2)).toBe('0.00');
      expect(p.outstandingAmount.toFixed(2)).toBe('0.00');
    });
  });

  it('cancelling an old CASH_BOOK journal with a customer deposit line leaves the deposit balance alone', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx, 'Customer');
      const old = await legacyJournal(tx, b, 'CASH_BOOK', [
        { accountId: b.cashId, debit: JT },
        { accountId: b.depositId, credit: JT, partyId: customer },
      ]);
      await tx.party.update({ where: { id: customer }, data: { customerDepositBalance: 3 * JT } });

      const c = await cancel(b.control, old);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      expect((await tx.party.findUniqueOrThrow({ where: { id: customer } })).customerDepositBalance.toFixed(2)).toBe('3000000.00');
    });
  });
});

d('Journal menu cancel: control accounts need journal.control (owner decision #1)', () => {
  it('without journal.control an inventory journal cannot be cancelled and no balance moves; with it, it can', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const r = await post(b.control, [
        { accountId: b.inventoryId, debit: 50 * JT },
        { accountId: b.cashId, credit: 50 * JT },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const before = (await tx.account.findUniqueOrThrow({ where: { id: b.inventoryId } })).balance.toFixed(2);

      expectCode(await cancel(b.plain, r.body.id), 'ACCOUNT_CONTROL');
      expect((await tx.account.findUniqueOrThrow({ where: { id: b.inventoryId } })).balance.toFixed(2)).toBe(before);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: r.body.id } })).status).not.toBe('Cancelled');
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: r.body.id, isCancelled: true } })).toBe(0);

      const c = await cancel(b.control, r.body.id);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
    });
  });

  it('without journal.control an old MANUAL deposit line cannot be reversed; the deposit balance stays', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx, 'Customer');
      const old = await legacyJournal(tx, b, 'MANUAL', [
        { accountId: b.cashId, debit: JT },
        { accountId: b.depositId, credit: JT, partyId: customer },
      ]);
      await tx.party.update({ where: { id: customer }, data: { customerDepositBalance: JT } });

      expectCode(await cancel(b.plain, old), 'ACCOUNT_CONTROL');
      expect((await tx.party.findUniqueOrThrow({ where: { id: customer } })).customerDepositBalance.toFixed(2)).toBe('1000000.00');
    });
  });

  it('a journal without control accounts is still cancelled by a doc.cancel holder without journal.control', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const r = await post(b.plain, [
        { accountId: b.expenseId, debit: JT },
        { accountId: b.cashId, credit: JT },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const c = await cancel(b.plain, r.body.id);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
    });
  });
});

d('GET /coa/flat partyRole (the expense forms send a party only on a party-role account)', () => {
  it('marks the receivable and deposit accounts with their role and other accounts with null', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const r = await callRoute(coaRouter, 'get', '/flat', { ...b.plain });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const role = (id: string) => (r.body as { id: string; partyRole: string | null }[]).find((a) => a.id === id)?.partyRole;
      expect(role(b.arId)).toBe('AR');
      expect(role(b.depositId)).toBe('CUSTOMER_DEPOSIT');
      expect(role(b.expenseId)).toBeNull();
      expect(role(b.inventoryId)).toBeNull();
    });
  });
});
