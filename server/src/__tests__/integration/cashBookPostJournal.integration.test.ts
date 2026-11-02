/**
 * Integration test: postJournalInTx is a thin wrapper of postJournal, and the cash book follows the
 * control-account rule of manual journals (E2-R3/R4, PR-4.5b).
 *
 * Fixture year 2180 (unique to this file). Everything runs in a rollback transaction and every
 * fixture is created in it: a fiscal year, a cash account, an expense account, an account mapped
 * as AR, one mapped as CUSTOMER_DEPOSIT, a Supplier, users holding (or not) journal.control.
 * Route handlers through the route harness.
 * - postJournalInTx: one journal (Submitted, SYSTEM_DOC) with items carrying the party, ledger rows
 *   without it, Decimal balances; the passed fiscal year is only verified (JOURNAL_FY_MISMATCH);
 *   group accounts are refused (ACCOUNT_GROUP); by default (PAYMENT_REQUEST_RULE, the payment
 *   request and settlement journals whose expense accounts people pick) AR and customer deposit
 *   accounts are refused, also by the check made when the expense account is chosen; an explicit
 *   DOCUMENT_RULE still allows them.
 * - Cash book post without journal.control: a Cr Piutang row fails ACCOUNT_CONTROL on its own, the
 *   other row is posted (partial); without partial nothing is posted and the 400 carries
 *   code ACCOUNT_CONTROL plus the per-row failures.
 * - With journal.control the Cr Piutang row is posted; a customer deposit row is refused even then.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, Prisma, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import cashBookDraftsRouter from '../../routes/cashBookDrafts';
import { assertExpenseAccount, postJournalInTx } from '../../services/paymentRequestService';
import { DOCUMENT_RULE } from '../../services/ledger/accountGuard';
import { JOURNAL_FY_MISMATCH } from '../../services/ledger/postJournal';

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
  state.tx = null;
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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  } finally {
    state.tx = null;
  }
}

const Y = 2180;
const DAY = new Date(`${Y}-03-10T00:00:00.000Z`);
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type Kind = 'ASSET' | 'LIABILITY' | 'EXPENSE';
async function account(tx: Tx, rootType: Kind, opts: { prefix?: string; role?: string; isGroup?: boolean } = {}) {
  const acc = await tx.account.create({
    data: {
      name: `IT-CB ${opts.role ?? rootType}`,
      accountNumber: `${opts.prefix ?? 'IT-CB-'}${tag()}`,
      accountType: rootType,
      rootType,
      isGroup: opts.isGroup ?? false,
    },
  });
  if (opts.role) await tx.systemAccountMapping.create({ data: { role: opts.role, accountId: acc.id, sortOrder: 99 } });
  return acc;
}

interface Books { fy: FiscalYear; cashId: string; expenseId: string; arId: string; depositId: string }

async function books(tx: Tx): Promise<Books> {
  return {
    fy: await createFiscalYear(tx, { year: Y }),
    // assertCashAccount: an ASSET numbered 1.1.x.
    cashId: (await account(tx, 'ASSET', { prefix: '1.1.IT-CB-' })).id,
    expenseId: (await account(tx, 'EXPENSE')).id,
    arId: (await account(tx, 'ASSET', { role: 'AR' })).id,
    depositId: (await account(tx, 'LIABILITY', { role: 'CUSTOMER_DEPOSIT' })).id,
  };
}

const balance = async (tx: Tx, id: string) => (await tx.account.findUniqueOrThrow({ where: { id } })).balance.toString();

/** Row 1: Dr expense / Cr cash 125.000. Row 2: Dr cash / Cr `counterId` 300.000. */
async function draft(tx: Tx, b: Books, userId: string, counterId: string) {
  const d = await tx.cashBookDraft.create({
    data: { draftNumber: `IT-DKB-${tag()}`, title: 'IT-CB', entryDate: DAY, cashAccountId: b.cashId, createdById: userId },
  });
  await tx.cashBookDraftRow.createMany({
    data: [
      { draftId: d.id, idx: 1, rowDate: DAY, description: 'Beli ATK', amount: '125000', direction: 'keluar', txnType: 'pengeluaran', accountId: b.expenseId },
      { draftId: d.id, idx: 2, rowDate: DAY, description: 'Terima pelunasan', amount: '300000', direction: 'masuk', txnType: 'pemasukan', accountId: counterId },
    ],
  });
  return d.id;
}

const post = (id: string, user: { userId: string; role: string }, partial?: boolean) =>
  callRoute(cashBookDraftsRouter, 'post', '/:id/post', { ...user, params: { id }, body: partial === undefined ? {} : { partial } });

const lineFixture = (b: Books, debitId: string, creditId: string, amount = '1000.10') => [
  { accountId: debitId, debit: Number(amount), credit: 0, description: 'uji' },
  { accountId: creditId, debit: 0, credit: Number(amount), description: '' },
];

d('postJournalInTx wraps postJournal', () => {
  it('writes a SYSTEM_DOC journal: party on the items, not on the ledger rows, Decimal balances', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, []);
      const supplier = await tx.party.create({ data: { name: `IT-CB Supplier ${tag()}`, partyType: 'Supplier' } });
      const now = new Date();
      const je = await postJournalInTx(tx, {
        date: DAY, narration: 'IT-CB bayar', fiscalYearId: b.fy.id, actorId: user.userId, now,
        lines: lineFixture(b, b.expenseId, b.cashId), partyId: supplier.id,
      });
      const row = await tx.journalEntry.findUniqueOrThrow({ where: { id: je.id }, include: { items: true } });
      expect(row).toMatchObject({ status: 'Submitted', sourceType: 'SYSTEM_DOC', sourceKey: null, fiscalYearId: b.fy.id, createdBy: user.userId });
      expect(row.entryNumber).toMatch(/^JV-/);
      expect(row.items.map((i) => i.partyId)).toEqual([supplier.id, supplier.id]);
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceType: 'JournalEntry', referenceId: je.id }, orderBy: { debit: 'desc' } });
      expect(ale.map((r) => [r.accountId, r.debit.toString(), r.credit.toString(), r.partyId, r.fiscalYearId])).toEqual([
        [b.expenseId, '1000.1', '0', null, b.fy.id],
        [b.cashId, '0', '1000.1', null, b.fy.id],
      ]);
      // An empty item description falls back to the narration on the ledger row.
      expect(ale[1]!.description).toBe('IT-CB bayar');
      expect(await balance(tx, b.expenseId)).toBe('1000.1');
      expect(await balance(tx, b.cashId)).toBe('-1000.1');
    });
  });

  it('verifies the passed fiscal year against the date (JOURNAL_FY_MISMATCH) and refuses group accounts', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, []);
      const other = { id: randomUUID() }; // any year other than the one of the date
      const base = { date: DAY, narration: 'IT-CB', actorId: user.userId, now: new Date() };
      await expect(
        postJournalInTx(tx, { ...base, fiscalYearId: other.id, lines: lineFixture(b, b.expenseId, b.cashId) }),
      ).rejects.toMatchObject({ code: JOURNAL_FY_MISMATCH });
      const group = await account(tx, 'EXPENSE', { isGroup: true });
      await expect(
        postJournalInTx(tx, { ...base, fiscalYearId: b.fy.id, lines: lineFixture(b, group.id, b.cashId) }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_GROUP' });
      expect(await tx.journalEntry.count({ where: { fiscalYearId: b.fy.id } })).toBe(0);
    });
  });

  it('refuses AR and customer deposit accounts by default (payment request lines) and allows them under DOCUMENT_RULE', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, []);
      const base = { date: DAY, narration: 'IT-CB', fiscalYearId: b.fy.id, actorId: user.userId, now: new Date() };
      await expect(postJournalInTx(tx, { ...base, lines: lineFixture(b, b.arId, b.cashId) }))
        .rejects.toMatchObject({ code: 'ACCOUNT_CONTROL', message: expect.stringContaining('Pengajuan dana') });
      await expect(postJournalInTx(tx, { ...base, lines: lineFixture(b, b.depositId, b.cashId) }))
        .rejects.toMatchObject({ code: 'ACCOUNT_CONTROL' });
      // The same rule when the requester or finance picks the expense account.
      await expect(assertExpenseAccount(tx, b.depositId, 'Akun biaya baris 1')).rejects.toMatchObject({ code: 'ACCOUNT_CONTROL' });
      await expect(assertExpenseAccount(tx, b.expenseId, 'Akun biaya baris 1')).resolves.toBeUndefined();
      expect(await tx.journalEntry.count({ where: { fiscalYearId: b.fy.id } })).toBe(0);

      const je = await postJournalInTx(tx, { ...base, lines: lineFixture(b, b.cashId, b.arId), accountRule: DOCUMENT_RULE });
      expect(je.items).toHaveLength(2);
      expect(await balance(tx, b.arId)).toBe('-1000.1');
    });
  });
});

d('cash book post follows the control-account rule (journal.control)', () => {
  it('without journal.control, partial: the Cr Piutang row fails ACCOUNT_CONTROL, the expense row is posted', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, []);
      const id = await draft(tx, b, user.userId, b.arId);
      const res = await post(id, user, true);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'PartiallyPosted', postedCount: 1, totalAmount: 125000 });
      expect(res.body.failed).toEqual([{ idx: 2, code: 'ACCOUNT_CONTROL', error: expect.stringContaining('adalah akun kontrol Piutang Usaha') }]);
      expect(res.body.failed[0].error).toContain('journal.control');

      const rows = await tx.cashBookDraftRow.findMany({ where: { draftId: id }, orderBy: { idx: 'asc' } });
      expect(rows[0]!.journalEntryId).not.toBeNull();
      expect(rows[1]).toMatchObject({ journalEntryId: null, error: expect.stringContaining('akun kontrol') });
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: rows[0]!.journalEntryId! } });
      expect(je).toMatchObject({ sourceType: 'CASH_BOOK', createdBy: user.userId, fiscalYearId: b.fy.id });
      expect(await balance(tx, b.arId)).toBe('0');
      expect(await balance(tx, b.cashId)).toBe('-125000');
    });
  });

  it('without journal.control and without partial: nothing is posted', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, []);
      const id = await draft(tx, b, user.userId, b.arId);
      const res = await post(id, user);
      expect(res.status).toBe(400);
      // The code reaches the client (and an approved AIRA call) in all-or-nothing mode too.
      expect(res.body).toMatchObject({ code: 'ACCOUNT_CONTROL', rowErrors: [expect.stringMatching(/^Baris 2: .*akun kontrol Piutang Usaha/)] });
      expect(res.body.failed).toEqual([{ idx: 2, code: 'ACCOUNT_CONTROL', error: expect.stringContaining('journal.control') }]);
      expect(await tx.journalEntry.count({ where: { fiscalYearId: b.fy.id } })).toBe(0);
      const rows = await tx.cashBookDraftRow.findMany({ where: { draftId: id }, orderBy: { idx: 'asc' } });
      expect(rows.map((r) => r.journalEntryId)).toEqual([null, null]);
      expect((await tx.cashBookDraft.findUniqueOrThrow({ where: { id } })).status).toBe('Draft');
    });
  });

  it('with journal.control: the Cr Piutang row is posted', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, ['journal.control']);
      const id = await draft(tx, b, user.userId, b.arId);
      const res = await post(id, user);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'Posted', postedCount: 2, failed: [] });
      expect(await balance(tx, b.arId)).toBe('-300000');
      expect(await balance(tx, b.cashId)).toBe('175000');
      const ale = await tx.accountingLedgerEntry.findMany({ where: { accountId: b.arId } });
      expect(ale.map((r) => [r.credit.toString(), r.partyId])).toEqual([['300000', null]]);
    });
  });

  it('a customer deposit row is refused even with journal.control', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await createCapUser(tx, ['journal.control']);
      const id = await draft(tx, b, user.userId, b.depositId);
      const res = await post(id, user, true);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'PartiallyPosted', postedCount: 1 });
      expect(res.body.failed).toEqual([{ idx: 2, code: 'ACCOUNT_CONTROL', error: expect.stringContaining('modul Uang Muka') }]);
      expect(await balance(tx, b.depositId)).toBe('0');
      expect(new Prisma.Decimal(await balance(tx, b.cashId)).eq(-125000)).toBe(true);
    });
  });
});
