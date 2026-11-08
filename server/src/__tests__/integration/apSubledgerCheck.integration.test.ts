/**
 * Integration test: payable, ledger vs subledger per Supplier, and the party type change guard
 * (PR-5.10, owner decision #9; services/ledger/arSubledgerCheck.ts findApSubledgerDiffs,
 * services/ledger/partySides.ts assertPartyTypeChangeAllowed).
 *
 * Fixture year 2155 (unique to this file). Everything runs in a rollback transaction with its own
 * fiscal year, user, parties and contra account; the payable account is the seed's AP mapping.
 * Fixture journals write balanced ledger rows. Assertions only look at this file's parties or year.
 * - An AP journal without an invoice is a difference; invoice + part payment is none.
 * - A party typed Both: its payable side (invoice, opening payable) is checked here, its receivable
 *   side stays in the AR check; a Supplier's undirected opening counts on the payable side.
 * - GET /health-check lists "AP vs Subledger" as detection only.
 * - Close checklist: ap-subledger blocks; a captured baseline holds the old difference, a larger
 *   one blocks again; the bucket without a party is labelled "(tanpa Supplier)".
 * - PUT /parties/:id refuses a type change that drops a side still in use (PARTY_TYPE_HAS_BALANCE)
 *   and allows one that only adds a side or drops an unused one; a gained side is recalculated.
 * - Writers posting to a side the party type does not have are refused (PARTY_TYPE_MISMATCH,
 *   assertPartySideLocked): purchase invoice and Pay for a Customer, Receive for a Supplier.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import '../../services/closeCheckPlugins';
import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { captureCloseBaseline, runCloseChecklist, type CloseChecklist, type CloseCheckResult } from '../../services/fiscalYearClose';
import { findApSubledgerDiffs, findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import healthCheckRouter from '../../routes/healthCheck';
import partiesRouter from '../../routes/parties';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let cashAccountId: string;
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
      systemAccounts.invalidateCache();
      try {
        actor = await createCapUser(tx, ['doc.cancel']);
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2155;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books {
  fy: FiscalYear;
  apId: string;
  arId: string;
  contraId: string;
}

async function books(tx: Tx): Promise<Books> {
  const contra = await tx.account.create({
    data: { name: 'IT-AP Lawan', accountNumber: `IT-AP-${tag()}`, accountType: 'EQUITY', rootType: 'EQUITY' },
  });
  return {
    fy: await createFiscalYear(tx, { year: Y }),
    apId: (await systemAccounts.getAccount('AP')).id,
    arId: (await systemAccounts.getAccount('AR')).id,
    contraId: contra.id,
  };
}

type PartyKind = 'Customer' | 'Supplier' | 'Both';
const party = async (tx: Tx, partyType: PartyKind, data: Record<string, number> = {}) =>
  (await tx.party.create({ data: { name: `IT-AP ${partyType} ${tag()}`, partyType, ...data } })).id;

/**
 * A submitted journal of `amount`: debit `debitId`, credit `creditId`, with its ledger rows; the
 * line on `partyAccountId` carries `partyId`. `date` is an instant (ISO).
 */
async function post(
  tx: Tx, b: Books, debitId: string, creditId: string, amount: number, partyId: string | null, partyAccountId: string,
  opts: { sourceType?: 'MANUAL' } = {},
) {
  const date = `${Y}-06-10T03:00:00Z`;
  const at = new Date(date);
  const lines = [
    { accountId: debitId, debit: amount, credit: 0, partyId: debitId === partyAccountId ? partyId : null },
    { accountId: creditId, debit: 0, credit: amount, partyId: creditId === partyAccountId ? partyId : null },
  ];
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-AP-${tag()}`,
      date: at,
      narration: 'IT-AP fixture',
      status: 'Submitted',
      fiscalYearId: b.fy.id,
      createdBy: actor.userId,
      submittedAt: new Date(),
      sourceType: opts.sourceType ?? null,
      items: { create: lines },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: lines.map((l) => ({ ...l, date: at, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: b.fy.id })),
  });
}

/** DR contra / CR AP (party). */
const apJournal = (tx: Tx, b: Books, partyId: string | null, amount: number) => post(tx, b, b.contraId, b.apId, amount, partyId, b.apId);
/** DR AR (party) / CR contra; MANUAL makes it a manual party adjustment (partyAdjustments.ts). */
const arJournal = (tx: Tx, b: Books, partyId: string, amount: number, sourceType?: 'MANUAL') =>
  post(tx, b, b.arId, b.contraId, amount, partyId, b.arId, { sourceType });

const invoice = (tx: Tx, partyId: string, amount: number, date = `${Y}-03-01`) =>
  submitPurchaseInvoiceInTx(tx, { date, partyId, items: [{ itemName: 'IT-AP jasa', itemType: 'service', quantity: 1, rate: amount, timbanganDiterima: 1 }] }, actor.userId);

const checklist = (tx: Tx, fy: FiscalYear): Promise<CloseChecklist> => runCloseChecklist(tx, fy);
function check(list: CloseChecklist, id: string): CloseCheckResult {
  const found = list.checks.find((c) => c.id === id);
  if (!found) throw new Error(`check ${id} missing from ${JSON.stringify(list.checks.map((c) => c.id))}`);
  return found;
}

const putType = (id: string, partyType: PartyKind) =>
  callRoute(partiesRouter, 'put', '/:id', { params: { id }, body: { partyType }, ...actor });

function expectRefused(r: RouteResult, side: 'Piutang' | 'Hutang', hold: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe('PARTY_TYPE_HAS_BALANCE');
  expect(r.body.error).toContain(`sisi ${side} masih punya ${hold}`);
}

d('AP vs subledger per Supplier (PR-5.10)', () => {
  it('reports an AP journal without an invoice and none after invoice and part payment', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const loose = await party(tx, 'Supplier');
      await apJournal(tx, b, loose, 3 * JT);
      const rows = await findApSubledgerDiffs(tx, { partyIds: [loose] });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ partyId: loose, partyType: 'Supplier' });
      expect(rows[0]!.gl.toFixed(2)).toBe('3000000.00');
      expect(rows[0]!.subledger.toFixed(2)).toBe('0.00');
      expect(rows[0]!.difference.toFixed(2)).toBe('3000000.00');

      const s = await party(tx, 'Supplier');
      const pi = await invoice(tx, s, 10 * JT);
      await submitPaymentInTx(tx, { date: `${Y}-03-05`, partyId: s, paymentType: 'Pay', accountId: cashAccountId, amount: 4 * JT }, actor.userId);
      const after = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pi.id } });
      expect(after.outstanding.toFixed(2)).toBe('6000000.00');
      expect(await findApSubledgerDiffs(tx, { partyIds: [s] })).toEqual([]);
    });
  });

  it('checks the payable side of a Both party and of a Supplier opening, apart from the receivable side', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // Both: purchase invoice 30 jt (payable), manual AR journal 20 jt (receivable).
      const both = await party(tx, 'Both');
      await invoice(tx, both, 30 * JT);
      await arJournal(tx, b, both, 20 * JT, 'MANUAL');
      await recalcPartyOutstanding(tx, both);
      const stored = await tx.party.findUniqueOrThrow({ where: { id: both } });
      expect([stored.receivableOutstanding.toFixed(2), stored.payableOutstanding.toFixed(2)]).toEqual(['20000000.00', '30000000.00']);
      expect(await findApSubledgerDiffs(tx, { partyIds: [both] })).toEqual([]);
      expect(await findArSubledgerDiffs(tx, { partyIds: [both] })).toEqual([]);
      // An AR row that is not an adjustment shows up in the AR check only.
      await arJournal(tx, b, both, JT);
      expect((await findArSubledgerDiffs(tx, { partyIds: [both] }))[0]!.difference.toFixed(2)).toBe('1000000.00');
      expect(await findApSubledgerDiffs(tx, { partyIds: [both] })).toEqual([]);

      // Openings: Both 7 jt payable (5 jt receivable, not AP's); Supplier 4 jt undirected.
      const bothOpening = await party(tx, 'Both', { openingOutstanding: 12 * JT, openingReceivable: 5 * JT, openingPayable: 7 * JT });
      const supplierLegacy = await party(tx, 'Supplier', { openingOutstanding: 4 * JT });
      const customer = await party(tx, 'Customer', { openingOutstanding: 9 * JT, openingReceivable: 9 * JT });
      const rows = new Map((await findApSubledgerDiffs(tx, { partyIds: [bothOpening, supplierLegacy, customer] })).map((r) => [r.partyId, r]));
      expect(rows.get(bothOpening)!.subledger.toFixed(2)).toBe('7000000.00');
      expect(rows.get(supplierLegacy)!.subledger.toFixed(2)).toBe('4000000.00');
      expect(rows.has(customer)).toBe(false);

      // Opening journals bring the ledger in line.
      await apJournal(tx, b, bothOpening, 7 * JT);
      await apJournal(tx, b, supplierLegacy, 4 * JT);
      expect(await findApSubledgerDiffs(tx, { partyIds: [bothOpening, supplierLegacy, customer] })).toEqual([]);
    });
  });

  it('lists AP vs Subledger in GET /health-check as detection only', async () => {
    await inRollback(async () => {
      const r = await callRoute(healthCheckRouter, 'get', '/', actor);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const found = (r.body.data.checks as Array<{ name: string; status: string; fixable: boolean; details: unknown[] }>)
        .find((c) => c.name === 'AP vs Subledger');
      expect(found).toBeDefined();
      expect(found!.status).not.toBe('error');
      expect(found!.fixable).toBe(false);
      expect(found!.details.length).toBeLessThanOrEqual(20);
    });
  });

  it('blocks the close with ap-subledger; a baseline holds the old difference, a larger one blocks', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const s = await party(tx, 'Supplier');
      await apJournal(tx, b, s, 2 * JT);
      await apJournal(tx, b, null, 500_000);

      let ap = check(await checklist(tx, b.fy), 'ap-subledger');
      expect(ap).toMatchObject({ severity: 'block', status: 'fail', count: 2, baselinedCount: 0 });
      expect(ap.items).toEqual(expect.arrayContaining([
        { key: `Party:${s}`, kind: 'Party', label: expect.stringContaining('IT-AP'), amount: '2000000.00' },
        { key: `Party:none:${b.fy.id}`, kind: 'Party', label: '(tanpa Supplier)', amount: '500000.00' },
      ]));

      await captureCloseBaseline(tx, b.fy, true, ['ap-subledger']);
      let list = await checklist(tx, b.fy);
      ap = check(list, 'ap-subledger');
      expect(ap).toMatchObject({ status: 'ok', count: 0, baselinedCount: 2 });

      await apJournal(tx, b, s, 1 * JT);
      list = await checklist(tx, b.fy);
      ap = check(list, 'ap-subledger');
      expect(ap).toMatchObject({ status: 'fail', count: 1, baselinedCount: 1 });
      expect(list.canClose).toBe(false);
      expect(ap.items.find((i) => i.key === `Party:${s}`)).toMatchObject({ amount: '3000000.00' });
    });
  });
});

d('party type change guard (PR-5.10)', () => {
  it('refuses dropping a side that still has an invoice, a balance, an opening or ledger rows', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const withInvoice = await party(tx, 'Supplier');
      await invoice(tx, withInvoice, 5 * JT);
      await recalcPartyOutstanding(tx, withInvoice);
      expectRefused(await putType(withInvoice, 'Customer'), 'Hutang', 'saldo terutang');

      const withOpening = await party(tx, 'Customer', { openingOutstanding: 2 * JT, openingReceivable: 2 * JT, receivableOutstanding: 2 * JT, outstandingAmount: 2 * JT });
      expectRefused(await putType(withOpening, 'Supplier'), 'Piutang', 'saldo terutang');

      // A Both party whose receivable journal was paid off nets to zero but keeps its ledger rows.
      const both = await party(tx, 'Both');
      await arJournal(tx, b, both, JT);
      await post(tx, b, b.contraId, b.arId, JT, both, b.arId);
      await recalcPartyOutstanding(tx, both);
      expectRefused(await putType(both, 'Supplier'), 'Piutang', 'baris Buku Besar');

      // A Supplier's undirected opening would move to the receivable side as Both.
      const legacy = await party(tx, 'Supplier', { openingOutstanding: 3 * JT, payableOutstanding: 3 * JT, outstandingAmount: 3 * JT });
      expectRefused(await putType(legacy, 'Both'), 'Hutang', 'saldo awal yang belum diarahkan');

      for (const id of [withInvoice, withOpening, both, legacy]) {
        const p = await tx.party.findUniqueOrThrow({ where: { id } });
        expect(p.partyType).toBe(id === withOpening ? 'Customer' : id === both ? 'Both' : 'Supplier');
      }
    });
  });

  it('allows adding a side, dropping an unused side, and edits that keep the type', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const supplier = await party(tx, 'Supplier');
      await invoice(tx, supplier, 5 * JT);
      const added = await putType(supplier, 'Both');
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body.partyType).toBe('Both');

      // Both with only payable activity drops its unused receivable side.
      const dropped = await putType(supplier, 'Supplier');
      expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);

      const fresh = await party(tx, 'Customer');
      expect((await putType(fresh, 'Supplier')).status).toBe(200);

      const named = await callRoute(partiesRouter, 'put', '/:id', { params: { id: supplier }, body: { name: `IT-AP renamed ${tag()}`, partyType: 'Supplier' }, ...actor });
      expect(named.status, JSON.stringify(named.body)).toBe(200);

      // The payable side of the Supplier is in use, so Customer is still refused.
      await apJournal(tx, b, supplier, JT);
      expectRefused(await putType(supplier, 'Customer'), 'Hutang', 'saldo terutang');

      expect((await callRoute(partiesRouter, 'put', '/:id', { params: { id: '00000000-0000-0000-0000-000000000000' }, body: { partyType: 'Customer' }, ...actor })).status).toBe(404);
    });
  });

  it('recalculates the side columns when a type change gains a side', async () => {
    await inRollback(async (tx) => {
      await books(tx);
      // Older data: a Customer holding a purchase invoice its type does not count.
      const p = await party(tx, 'Supplier');
      await invoice(tx, p, 5 * JT);
      await tx.party.update({ where: { id: p }, data: { partyType: 'Customer' } });
      await recalcPartyOutstanding(tx, p);
      expect((await tx.party.findUniqueOrThrow({ where: { id: p } })).payableOutstanding.toFixed(2)).toBe('0.00');

      const r = await putType(p, 'Both');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(Number(r.body.payableOutstanding)).toBe(5 * JT);
      const stored = await tx.party.findUniqueOrThrow({ where: { id: p } });
      expect([stored.payableOutstanding.toFixed(2), stored.outstandingAmount.toFixed(2)]).toEqual(['5000000.00', '5000000.00']);
    });
  });
});

d('posting to a side the party type does not have (PR-5.10)', () => {
  async function expectMismatch(run: Promise<unknown>, side: 'Piutang' | 'Hutang') {
    const err = await run.then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err, 'expected the posting to be refused').not.toBeNull();
    expect(err!.code).toBe('PARTY_TYPE_MISMATCH');
    expect(err!.message).toContain(`tidak punya sisi ${side}`);
  }

  it('refuses a purchase invoice and a Pay for a Customer and a Receive for a Supplier', async () => {
    await inRollback(async (tx) => {
      await books(tx);
      const customer = await party(tx, 'Customer');
      const supplier = await party(tx, 'Supplier');
      await expectMismatch(invoice(tx, customer, JT), 'Hutang');
      await expectMismatch(
        submitPaymentInTx(tx, { date: `${Y}-03-05`, partyId: customer, paymentType: 'Pay', accountId: cashAccountId, amount: JT }, actor.userId),
        'Hutang',
      );
      await expectMismatch(
        submitPaymentInTx(tx, { date: `${Y}-03-05`, partyId: supplier, paymentType: 'Receive', accountId: cashAccountId, amount: JT }, actor.userId),
        'Piutang',
      );
      // A Both party has both sides.
      const both = await party(tx, 'Both');
      await invoice(tx, both, JT);
      expect((await tx.party.findUniqueOrThrow({ where: { id: both } })).payableOutstanding.toFixed(2)).toBe('1000000.00');
    });
  });
});
