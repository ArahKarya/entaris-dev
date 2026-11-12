/**
 * Integration test: production run and stock opname cancels void only their own journals (E6-R2, M-18).
 *
 * A document's journals are JV-<number> and its `JV-<number>-…` satellites (revisions -R<n>). Run
 * 1000 must never touch the journals of run 10000. Cancels go through the E1 cancel model: the
 * canceller is stored on each voided journal, balances are reversed per journal line (no
 * recalculation that overwrites the balance), and a journal that already has a reversal is
 * refused with JOURNAL_ALREADY_REVERSED before anything moves. Edits number their revision
 * journals one above the highest -R<n>, also for a run posted without an original journal.
 * Fixtures are created in rollback transactions in fiscal year 2192.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { mapProductionLeafAccounts } from '../helpers/productionFixture';
import { systemAccounts } from '../../services/systemAccounts';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { JOURNAL_ALREADY_REVERSED } from '../../services/ledger/cancelJournals';
import { submitProductionRunInTx } from '../../services/productionRunSubmit';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import { nextRevisionNumber } from '../../services/production/productionPosting';
import productionRunsRouter from '../../routes/inventory/productionRuns';
import stockOpnameRouter from '../../routes/stockOpname';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const Y = 2192;
const DATE = new Date(`${Y}-01-15T05:00:00Z`);

let prisma: PrismaClient;
let pool: Pool;
/** Holds doc.cancel; created in each rollback transaction. */
let userId: string;
let role: string;
let fy: FiscalYear;

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
        ({ userId, role } = await createCapUser(tx, ['doc.cancel']));
        fy = await createFiscalYear(tx, { year: Y });
        // This database may map COGS to a group account, which production posting refuses.
        await mapProductionLeafAccounts(tx);
        await fn(tx);
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** A pair of postable accounts: an asset (debited) and an expense (credited). */
async function accounts(tx: Tx) {
  const make = (rootType: 'ASSET' | 'EXPENSE') =>
    tx.account.create({
      data: { name: `IT-E6 ${rootType} ${tag()}`, accountNumber: `IT-E6-${tag()}`, accountType: rootType, rootType },
    });
  return { asset: await make('ASSET'), expense: await make('EXPENSE') };
}

/**
 * Posted journal `entryNumber`: Dr asset / Cr expense for `amount`, with its ledger entries and
 * the balance effect applied (asset +amount, expense −amount).
 */
async function postJournal(tx: Tx, entryNumber: string, acc: { asset: { id: string }; expense: { id: string } }, amount: number) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber, date: DATE, status: 'Submitted', narration: `Uji ${entryNumber}`, fiscalYearId: fy.id, createdBy: userId,
      items: { create: [
        { accountId: acc.asset.id, debit: amount, credit: 0 },
        { accountId: acc.expense.id, debit: 0, credit: amount },
      ] },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: [
      { date: DATE, accountId: acc.asset.id, debit: amount, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
      { date: DATE, accountId: acc.expense.id, debit: 0, credit: amount, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id },
    ],
  });
  await tx.account.update({ where: { id: acc.asset.id }, data: { balance: { increment: amount } } });
  await tx.account.update({ where: { id: acc.expense.id }, data: { balance: { decrement: amount } } });
  return je;
}

function productionRun(tx: Tx, runNumber: string) {
  return tx.productionRun.create({ data: { runNumber, date: DATE, fiscalYearId: fy.id, createdById: userId } });
}

function opname(tx: Tx, opnameNumber: string) {
  return tx.stockOpname.create({
    data: { opnameNumber, date: DATE, status: 'Submitted', fiscalYearId: fy.id, createdById: userId, submittedAt: DATE },
  });
}

async function balanceOf(tx: Tx, id: string): Promise<number> {
  return Number((await tx.account.findUniqueOrThrow({ where: { id } })).balance);
}

async function journalsByNumber(tx: Tx, numbers: string[]) {
  const rows = await tx.journalEntry.findMany({
    where: { entryNumber: { in: numbers } },
    select: { entryNumber: true, status: true, cancelledById: true },
  });
  return Object.fromEntries(rows.map((r) => [r.entryNumber, r]));
}

async function activeLedgerCount(tx: Tx, journalId: string): Promise<number> {
  return tx.accountingLedgerEntry.count({ where: { referenceId: journalId, isCancelled: false } });
}

d('production run cancel scope', () => {
  it('cancelling run 1000 voids JV-…-1000 and -1000-R1 with the canceller, and leaves run 10000 and its balances alone', async () => {
    await inRollback(async (tx) => {
      const own = await accounts(tx);
      const other = await accounts(tx);
      const run = await productionRun(tx, `PR-${Y}01-1000`);
      await productionRun(tx, `PR-${Y}01-10000`);
      await postJournal(tx, `JV-PR-${Y}01-1000`, own, 300_000);
      await postJournal(tx, `JV-PR-${Y}01-1000-R1`, own, 200_000);
      const otherJe = await postJournal(tx, `JV-PR-${Y}01-10000`, other, 700_000);
      // A balance that drifted from the ledger stays drifted: the cancel reverses its own lines only.
      await tx.account.update({ where: { id: own.asset.id }, data: { balance: { increment: 1_234 } } });
      const otherBefore = [await balanceOf(tx, other.asset.id), await balanceOf(tx, other.expense.id)];

      const r = await callRoute(productionRunsRouter, 'put', '/:id/cancel', { params: { id: run.id }, userId, role });
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const after = await journalsByNumber(tx, [`JV-PR-${Y}01-1000`, `JV-PR-${Y}01-1000-R1`, `JV-PR-${Y}01-10000`]);
      expect(after[`JV-PR-${Y}01-1000`]).toMatchObject({ status: 'Cancelled', cancelledById: userId });
      expect(after[`JV-PR-${Y}01-1000-R1`]).toMatchObject({ status: 'Cancelled', cancelledById: userId });
      expect(after[`JV-PR-${Y}01-10000`]).toMatchObject({ status: 'Submitted', cancelledById: null });
      expect(await activeLedgerCount(tx, otherJe.id)).toBe(2);
      expect([await balanceOf(tx, other.asset.id), await balanceOf(tx, other.expense.id)]).toEqual(otherBefore);
      expect(await balanceOf(tx, own.asset.id)).toBe(1_234);
      expect(await balanceOf(tx, own.expense.id)).toBe(0);
      expect((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).isCancelled).toBe(true);
    });
  });

  it('the run detail shows its own newest active journal, never the one of run 10000', async () => {
    await inRollback(async (tx) => {
      const acc = await accounts(tx);
      const run = await productionRun(tx, `PR-${Y}01-1000`);
      const otherRun = await productionRun(tx, `PR-${Y}01-10000`);
      await postJournal(tx, `JV-PR-${Y}01-1000`, acc, 100_000);
      const otherJe = await postJournal(tx, `JV-PR-${Y}01-10000`, acc, 900_000);

      const own = await callRoute(productionRunsRouter, 'get', '/:id', { params: { id: run.id }, userId, role });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.journal?.entryNumber).toBe(`JV-PR-${Y}01-1000`);

      // With its own journal cancelled, run 1000 shows none rather than run 10000's.
      await tx.journalEntry.updateMany({ where: { entryNumber: `JV-PR-${Y}01-1000` }, data: { status: 'Cancelled' } });
      const none = await callRoute(productionRunsRouter, 'get', '/:id', { params: { id: run.id }, userId, role });
      expect(none.body.journal).toBeNull();

      const theirs = await callRoute(productionRunsRouter, 'get', '/:id', { params: { id: otherRun.id }, userId, role });
      expect(theirs.body.journal?.id).toBe(otherJe.id);
    });
  });

  it('refuses with JOURNAL_ALREADY_REVERSED when a journal of the run has a reversal; stock and journals unchanged', async () => {
    await inRollback(async (tx) => {
      const acc = await accounts(tx);
      const wh = await tx.warehouse.create({ data: { code: `IT-E6-${tag()}`, name: `Gudang uji ${tag()}` } });
      const item = await tx.inventoryItem.create({
        data: { code: `IT-E6-${tag()}`, name: `Uji E6 ${tag()}`, unit: 'kg', currentStock: 90, averageCost: 1_000, isActive: true },
      });
      await tx.inventoryStock.create({ data: { itemId: item.id, warehouseId: wh.id, currentStock: 90 } });
      const run = await productionRun(tx, `PR-${Y}01-2000`);
      // The run consumed 10 kg; cancelling it would put them back.
      const mov = await tx.stockMovement.create({
        data: {
          movementNumber: `SM-IT-E6-${tag()}`, date: DATE, itemId: item.id, warehouseId: wh.id, movementType: 'Out',
          quantity: 10, unitCost: 1_000, totalValue: 10_000, referenceType: 'ProductionRun', referenceId: run.id,
          referenceNumber: run.runNumber, fiscalYearId: fy.id, createdById: userId,
        },
      });
      const je = await postJournal(tx, `JV-PR-${Y}01-2000`, acc, 10_000);
      const reversal = await postJournal(tx, `JV-REV-PR-${Y}01-2000`, acc, 10_000);
      await tx.journalEntry.update({ where: { id: je.id }, data: { reversedById: reversal.id } });
      const balances = [await balanceOf(tx, acc.asset.id), await balanceOf(tx, acc.expense.id)];

      const r = await callRoute(productionRunsRouter, 'put', '/:id/cancel', { params: { id: run.id }, userId, role });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe(JOURNAL_ALREADY_REVERSED);

      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock)).toBe(90);
      expect(Number((await tx.inventoryStock.findFirstOrThrow({ where: { itemId: item.id, warehouseId: wh.id } })).currentStock)).toBe(90);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: mov.id } })).isCancelled).toBe(false);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: je.id } })).status).toBe('Submitted');
      expect([await balanceOf(tx, acc.asset.id), await balanceOf(tx, acc.expense.id)]).toEqual(balances);
      expect((await tx.productionRun.findUniqueOrThrow({ where: { id: run.id } })).isCancelled).toBe(false);
    });
  });
});

d('stock opname cancel scope', () => {
  it('cancelling SO-…-1000 voids only its journals, with the canceller, and leaves SO-…-10000 alone', async () => {
    await inRollback(async (tx) => {
      const own = await accounts(tx);
      const other = await accounts(tx);
      const so = await opname(tx, `SO-${Y}01-1000`);
      const otherSo = await opname(tx, `SO-${Y}01-10000`);
      await postJournal(tx, `JV-SO-${Y}01-1000`, own, 50_000);
      const otherJe = await postJournal(tx, `JV-SO-${Y}01-10000`, other, 80_000);
      const otherBefore = [await balanceOf(tx, other.asset.id), await balanceOf(tx, other.expense.id)];

      const r = await callRoute(stockOpnameRouter, 'put', '/:id/cancel', { params: { id: so.id }, userId, role });
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const after = await journalsByNumber(tx, [`JV-SO-${Y}01-1000`, `JV-SO-${Y}01-10000`]);
      expect(after[`JV-SO-${Y}01-1000`]).toMatchObject({ status: 'Cancelled', cancelledById: userId });
      expect(after[`JV-SO-${Y}01-10000`]).toMatchObject({ status: 'Submitted', cancelledById: null });
      expect(await activeLedgerCount(tx, otherJe.id)).toBe(2);
      expect([await balanceOf(tx, other.asset.id), await balanceOf(tx, other.expense.id)]).toEqual(otherBefore);
      expect(await balanceOf(tx, own.asset.id)).toBe(0);
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: so.id } })).status).toBe('Cancelled');
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: otherSo.id } })).status).toBe('Submitted');
    });
  });
});

d('production run revision numbers', () => {
  it('numbers the next revision one above the highest -R<n>, cancelled ones included', async () => {
    await inRollback(async (tx) => {
      const acc = await accounts(tx);
      const base = `JV-PR-${Y}02-0001`;
      expect(await nextRevisionNumber(tx, base)).toBe(`${base}-R1`);

      await postJournal(tx, base, acc, 1_000);
      expect(await nextRevisionNumber(tx, base)).toBe(`${base}-R1`);

      // Only -R1 exists and it is cancelled (a run posted without an original journal, edited once).
      await postJournal(tx, `${base}-R1`, acc, 1_000);
      await tx.journalEntry.updateMany({ where: { entryNumber: `${base}-R1` }, data: { status: 'Cancelled' } });
      expect(await nextRevisionNumber(tx, base)).toBe(`${base}-R2`);

      // Numeric, not text, order; other satellites and the -10000 neighbour do not count.
      await postJournal(tx, `${base}-R10`, acc, 1_000);
      await postJournal(tx, `${base}-R9`, acc, 1_000);
      await postJournal(tx, `${base}-CORR`, acc, 1_000);
      await postJournal(tx, `${base}-R11X`, acc, 1_000);
      await postJournal(tx, `JV-PR-${Y}02-00010-R50`, acc, 1_000);
      expect(await nextRevisionNumber(tx, base)).toBe(`${base}-R11`);
    });
  });

  it('two edits of a run posted without a journal give -R1 then -R2 (no P2002)', async () => {
    await inRollback(async (tx) => {
      const wh = await tx.warehouse.create({ data: { code: `IT-E6-${tag()}`, name: `Gudang uji ${tag()}` } });
      const input = await tx.inventoryItem.create({
        data: { code: `IT-E6-IN-${tag()}`, name: `Uji E6 input ${tag()}`, unit: 'kg', currentStock: 1_000, averageCost: 0, isActive: true },
      });
      await tx.inventoryStock.create({ data: { itemId: input.id, warehouseId: wh.id, currentStock: 1_000 } });
      const output = await tx.inventoryItem.create({
        data: { code: `IT-E6-OUT-${tag()}`, name: `Uji E6 output ${tag()}`, unit: 'kg', currentStock: 0, averageCost: 0, isActive: true },
      });
      const date = `${Y}-03-10`;
      // Zero cost in and zero value out: nothing to post, so the run has no JV-<runNumber>.
      const run = await submitProductionRunInTx(
        tx,
        { date, warehouseId: wh.id, inputs: [{ itemId: input.id, quantity: 100 }], outputs: [{ itemId: output.id, quantity: 60, unitPrice: 0 }] },
        userId,
      );
      if (!run) throw new Error('Production run was not created.');
      const base = `JV-${run.runNumber}`;
      expect(await tx.journalEntry.count({ where: { entryNumber: { startsWith: base } } })).toBe(0);

      const edit = (unitPrice: number) => editProductionRunInTx(
        tx,
        run.id,
        { date, warehouseId: wh.id, inputs: [{ itemId: input.id, quantity: 100 }], outputs: [{ itemId: output.id, quantity: 60, unitPrice }] },
        userId,
      );
      await edit(1_000);
      await edit(2_000);

      const family = await tx.journalEntry.findMany({
        where: { entryNumber: { startsWith: `${base}-` } },
        select: { entryNumber: true, status: true, cancelledById: true, cancelReason: true },
        orderBy: { entryNumber: 'asc' },
      });
      expect(family).toEqual([
        { entryNumber: `${base}-R1`, status: 'Cancelled', cancelledById: userId, cancelReason: 'Revisi produksi' },
        { entryNumber: `${base}-R2`, status: 'Submitted', cancelledById: null, cancelReason: null },
      ]);
    });
  });
});
