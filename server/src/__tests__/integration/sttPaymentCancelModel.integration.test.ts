/**
 * Integration test: STT and payment cancels void their journals per line (E1-R6).
 *
 * - Cancelling a 50 jt STT posts no `JV-<stt>-CXL`; the original journal is Cancelled with all its
 *   ledger entries, Persediaan and Hutang Belum Tagih return to their pre-STT balances and the
 *   ALE-vs-JournalItem health query shows no new difference on those accounts (G-15).
 * - An STT with two lines billed by PI A (30 jt) and PI B (20 jt): after PI A is cancelled the
 *   header link is empty, but the STT cancel still returns 400 GR_LINE_INVOICED naming PI B (G-19).
 * - A 10 jt receipt cancelled after AR was remapped: the original AR account gets its 10 jt back
 *   and the new AR account does not move (P-11). A legacy payment without a journal keeps the
 *   nominal reversal.
 * - cancelJournalsInTx rejects a journal that already has a reversal with JOURNAL_ALREADY_REVERSED.
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

import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { GR_LINE_INVOICED } from '../../services/goodsReceiptCancel';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { cancelPurchaseInvoiceInTx } from '../../services/invoiceCancellation';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { systemAccounts } from '../../services/systemAccounts';
import { invalidatePermissionCache } from '../../services/permissionService';
import { cancelJournalsInTx, JOURNAL_ALREADY_REVERSED } from '../../services/ledger/cancelJournals';
import { BusinessError } from '../../utils/errors';
import goodsReceiptsRouter from '../../routes/goodsReceipts';
import paymentsRouter from '../../routes/payments';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
/** The acting user (doc.cancel) of the current test. */
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
        await createFiscalYear(tx, { year: Y });
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

function party(tx: Tx, partyType: 'Customer' | 'Supplier') {
  return tx.party.create({ data: { name: `IT-E1R6-${partyType}-${tag()}`, partyType, isActive: true } });
}

function warehouse(tx: Tx) {
  const t = tag();
  return tx.warehouse.create({ data: { code: `IT-E1R6-${t}`, name: `Gudang uji ${t}` } });
}

function item(tx: Tx) {
  const t = tag();
  return tx.inventoryItem.create({
    data: { code: `IT-E1R6-${t}`, name: `Barang uji ${t}`, unit: 'kg', currentStock: 0, averageCost: 0, isActive: true },
  });
}

function assetAccount(tx: Tx, name: string, numberPrefix = 'IT-E1R6') {
  const t = tag();
  return tx.account.create({
    data: { accountNumber: `${numberPrefix}-${t}`, name: `${name} ${t}`, accountType: 'ASSET', rootType: 'ASSET' },
  });
}

/** A cash account of its own: payments accept accounts numbered under a CASH-mapped account. */
async function cashAccount(tx: Tx) {
  const [cash] = await systemAccounts.getAccounts('CASH');
  if (!cash) throw new Error('No CASH system account mapped.');
  return assetAccount(tx, 'Kas uji', `${cash.accountNumber}.IT`);
}

async function balances(tx: Tx, ids: string[]): Promise<Record<string, number>> {
  const rows = await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, balance: true } });
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.balance)]));
}

/** checkAleSync (routes/health/checks.ts) restricted to `accountIds`: JI of live journals vs live ALE. */
async function aleVsJournalItems(tx: Tx, accountIds: string[]) {
  const rows = await tx.$queryRaw<Array<{ account_id: string; ji_debit: unknown; ji_credit: unknown; ale_debit: unknown; ale_credit: unknown }>>`
    WITH ji_totals AS (
      SELECT jea.account_id, SUM(jea.debit) AS total_debit, SUM(jea.credit) AS total_credit
        FROM journal_entry_accounts jea
        JOIN journal_entries je ON je.id = jea.journal_entry_id
       WHERE je.status != 'Cancelled' AND jea.account_id = ANY(${accountIds})
       GROUP BY jea.account_id
    ),
    ale_totals AS (
      SELECT ale.account_id, SUM(ale.debit) AS total_debit, SUM(ale.credit) AS total_credit
        FROM accounting_ledger_entries ale
       WHERE ale.reference_type = 'JournalEntry' AND ale.is_cancelled = false AND ale.account_id = ANY(${accountIds})
       GROUP BY ale.account_id
    )
    SELECT COALESCE(ji.account_id, ale.account_id) AS account_id,
           COALESCE(ji.total_debit, 0) AS ji_debit, COALESCE(ji.total_credit, 0) AS ji_credit,
           COALESCE(ale.total_debit, 0) AS ale_debit, COALESCE(ale.total_credit, 0) AS ale_credit
      FROM ji_totals ji
      FULL OUTER JOIN ale_totals ale ON ji.account_id = ale.account_id
     WHERE COALESCE(ji.total_debit, 0) != COALESCE(ale.total_debit, 0)
        OR COALESCE(ji.total_credit, 0) != COALESCE(ale.total_credit, 0)
     ORDER BY 1`;
  return rows.map((r) => ({
    accountId: r.account_id,
    ji: [Number(r.ji_debit), Number(r.ji_credit)],
    ale: [Number(r.ale_debit), Number(r.ale_credit)],
  }));
}

function expectCode(r: RouteResult, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(code);
}

function cancelStt(id: string, reason?: string) {
  return callRoute(goodsReceiptsRouter, 'post', '/:id/cancel', { params: { id }, body: reason ? { reason } : {}, ...actor });
}

function cancelPayment(id: string) {
  return callRoute(paymentsRouter, 'post', '/:id/cancel', { params: { id }, ...actor });
}

d('STT cancel voids its journal', () => {
  it('cancels the original journal and its ledger entries, posts no -CXL and restores the balances', async () => {
    await inRollback(async (tx) => {
      const supplier = await party(tx, 'Supplier');
      const wh = await warehouse(tx);
      const it1 = await item(tx);
      const inventoryAccountId = (await systemAccounts.getAccount('INVENTORY')).id;
      const accruedAccountId = (await systemAccounts.getAccount('ACCRUED_PAYABLE')).id;
      const accountIds = [inventoryAccountId, accruedAccountId];
      const balancesBefore = await balances(tx, accountIds);
      const healthBefore = await aleVsJournalItems(tx, accountIds);

      const stt = await submitGoodsReceiptInTx(
        tx,
        {
          date: `${Y}-03-10`,
          partyId: supplier.id,
          items: [{ inventoryItemId: it1.id, warehouseId: wh.id, itemName: it1.name, quantity: 1_000, unit: 'kg', lockedUnitCost: 50_000 }],
        },
        actor.userId,
      );
      const original = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${stt.sttNumber}` }, include: { items: true } });
      expect(original.items.reduce((s, i) => s + Number(i.debit), 0)).toBe(50_000_000);
      expect(original.items.map((i) => i.accountId).sort()).toEqual([...accountIds].sort());
      expect(await balances(tx, accountIds)).not.toEqual(balancesBefore);

      const r = await cancelStt(stt.id, 'Salah supplier');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.status).toBe('Cancelled');

      expect(await tx.journalEntry.count({ where: { entryNumber: { startsWith: `JV-${stt.sttNumber}-` } } })).toBe(0);
      const voided = await tx.journalEntry.findUniqueOrThrow({ where: { id: original.id } });
      expect(voided.status).toBe('Cancelled');
      expect(voided.cancelledById).toBe(actor.userId);
      expect(voided.cancelReason).toBe('Salah supplier');
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: original.id } });
      expect(ale.length).toBe(original.items.length);
      expect(ale.every((e) => e.isCancelled)).toBe(true);

      expect(await balances(tx, accountIds)).toEqual(balancesBefore);
      expect(await aleVsJournalItems(tx, accountIds)).toEqual(healthBefore);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: it1.id } })).currentStock)).toBe(0);
    });
  });

  it('refuses while another purchase invoice still bills one of its lines, even after the header PI is cancelled', async () => {
    await inRollback(async (tx) => {
      const supplier = await party(tx, 'Supplier');
      const wh = await warehouse(tx);
      const a = await item(tx);
      const b = await item(tx);
      const stt = await submitGoodsReceiptInTx(
        tx,
        {
          date: `${Y}-03-10`,
          partyId: supplier.id,
          items: [
            { inventoryItemId: a.id, warehouseId: wh.id, itemName: a.name, quantity: 300, unit: 'kg', lockedUnitCost: 100_000 },
            { inventoryItemId: b.id, warehouseId: wh.id, itemName: b.name, quantity: 200, unit: 'kg', lockedUnitCost: 100_000 },
          ],
        },
        actor.userId,
      );
      const lines = await tx.goodsReceiptItem.findMany({ where: { goodsReceiptId: stt.id } });
      const lineOf = (itemId: string) => lines.find((l) => l.inventoryItemId === itemId)!;
      const bill = (it: { id: string; name: string }, qty: number) => submitPurchaseInvoiceInTx(
        tx,
        {
          date: `${Y}-03-12`,
          partyId: supplier.id,
          items: [{
            itemName: it.name, inventoryItemId: it.id, warehouseId: wh.id, quantity: qty, unit: 'kg',
            rate: 100_000, taxPct: 0, pphPct: 0, goodsReceiptItemId: lineOf(it.id).id,
          }],
        },
        actor.userId,
      );
      const piA = await bill(a, 300);
      const piB = await bill(b, 200);
      expect(Number(piA.grandTotal)).toBe(30_000_000);
      expect(Number(piB.grandTotal)).toBe(20_000_000);
      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } })).invoiceId).toBe(piA.id);

      await cancelPurchaseInvoiceInTx(tx, piA.id);
      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } })).invoiceId).toBeNull();

      const r = await cancelStt(stt.id);
      expectCode(r, GR_LINE_INVOICED);
      expect(r.body.error).toContain(piB.invoiceNumber);

      expect((await tx.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } })).status).toBe('Submitted');
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: `JV-${stt.sttNumber}` } })).status).toBe('Submitted');

      // Once PI B is cancelled too, the STT cancels.
      await cancelPurchaseInvoiceInTx(tx, piB.id);
      const ok = await cancelStt(stt.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });
  });
});

d('payment cancel reverses its journal lines', () => {
  it('gives the 10 jt back to the AR account it was posted to, even after AR was remapped', async () => {
    await inRollback(async (tx) => {
      const customer = await party(tx, 'Customer');
      const cash = await cashAccount(tx);
      const newAr = await assetAccount(tx, 'Piutang baru uji');
      const arAccountId = (await systemAccounts.getAccount('AR')).id;
      const ids = [cash.id, newAr.id, arAccountId];
      const before = await balances(tx, ids);

      const { payment } = await submitPaymentInTx(
        tx,
        { date: `${Y}-05-02`, partyId: customer.id, amount: 10_000_000, paymentType: 'Receive', accountId: cash.id } as any,
        actor.userId,
      );
      const posted = await balances(tx, ids);
      expect(posted[arAccountId]).toBe(before[arAccountId] - 10_000_000);
      expect(posted[cash.id]).toBe(10_000_000);

      const realGetAccount = systemAccounts.getAccount.bind(systemAccounts);
      const spy = vi.spyOn(systemAccounts, 'getAccount').mockImplementation(async (role) =>
        role === 'AR' ? { id: newAr.id, accountNumber: newAr.accountNumber, name: newAr.name } : realGetAccount(role));
      let r: RouteResult;
      try {
        r = await cancelPayment(payment.id);
      } finally {
        spy.mockRestore();
      }
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      expect(await balances(tx, ids)).toEqual(before);
      const { journalEntryId } = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId! } });
      expect(je.status).toBe('Cancelled');
      expect(je.cancelledById).toBe(actor.userId);
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: je.id, isCancelled: false } })).toBe(0);
    });
  });

  it('keeps the nominal reversal for a legacy payment that has no journal', async () => {
    await inRollback(async (tx) => {
      const customer = await party(tx, 'Customer');
      const cash = await cashAccount(tx);
      const arAccountId = (await systemAccounts.getAccount('AR')).id;
      const fy = await tx.fiscalYear.findFirstOrThrow({ where: { startDate: new Date(`${Y}-01-01`) }, orderBy: { createdAt: 'desc' } });
      const legacy = await tx.payment.create({
        data: {
          paymentNumber: `PAY-IT-E1R6-${tag()}`, date: new Date(`${Y}-05-02`), paymentType: 'Receive', partyId: customer.id,
          accountId: cash.id, amount: 4_000_000, status: 'Submitted', createdBy: actor.userId, fiscalYearId: fy.id, submittedAt: new Date(),
        },
      });
      const before = await balances(tx, [cash.id, arAccountId]);

      const r = await cancelPayment(legacy.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const after = await balances(tx, [cash.id, arAccountId]);
      expect(after[cash.id]).toBe(before[cash.id] - 4_000_000);
      expect(after[arAccountId]).toBe(before[arAccountId] + 4_000_000);
      expect((await tx.payment.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('Cancelled');
    });
  });
});

d('cancelJournalsInTx', () => {
  it('rejects a journal that already has a reversal and voids nothing', async () => {
    await inRollback(async (tx) => {
      const fy = await tx.fiscalYear.findFirstOrThrow({ where: { startDate: new Date(`${Y}-01-01`) }, orderBy: { createdAt: 'desc' } });
      const cash = await assetAccount(tx, 'Kas uji');
      const other = await assetAccount(tx, 'Lawan uji');
      const journal = (entryNumber: string) => tx.journalEntry.create({
        data: {
          entryNumber, date: new Date(`${Y}-06-01`), narration: 'Uji', status: 'Submitted', fiscalYearId: fy.id,
          createdBy: actor.userId, submittedAt: new Date(),
          items: { create: [{ accountId: cash.id, debit: 1_000, credit: 0 }, { accountId: other.id, debit: 0, credit: 1_000 }] },
        },
        include: { items: true },
      });
      const t = tag();
      const plain = await journal(`JV-IT-E1R6-${t}-A`);
      const reversal = await journal(`JV-IT-E1R6-${t}-B`);
      const reversed = await tx.journalEntry.update({
        where: { id: (await journal(`JV-IT-E1R6-${t}`)).id },
        data: { reversedById: reversal.id },
        include: { items: true },
      });

      let code: string | undefined;
      try {
        await cancelJournalsInTx(tx, [plain, reversed], { label: 'jurnal' });
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        code = e.code;
      }
      expect(code).toBe(JOURNAL_ALREADY_REVERSED);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: plain.id } })).status).toBe('Submitted');

      expect(await cancelJournalsInTx(tx, [plain, reversal], { label: 'jurnal' })).toEqual([plain.entryNumber, reversal.entryNumber]);
      // An already cancelled journal is skipped, not counted.
      const again = await tx.journalEntry.findUniqueOrThrow({ where: { id: plain.id }, include: { items: true } });
      expect(await cancelJournalsInTx(tx, [again], { label: 'jurnal' })).toEqual([]);
    });
  });
});
