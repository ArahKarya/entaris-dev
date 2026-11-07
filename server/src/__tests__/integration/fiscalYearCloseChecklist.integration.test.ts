/**
 * Integration test: year-close checklist and gate (E1-R8, PR-8b).
 *
 * Fixture: a fiscal year of its own (and the year before it where needed), cash, revenue, expense
 * and two equity accounts that stand in for the CURRENT_PROFIT and RETAINED_EARNINGS mappings
 * (systemAccounts is stubbed to return them). Journals are written with their ledger rows.
 * - 10 jt of December depreciation unposted: close is refused (CLOSE_CHECKLIST_FAILED) and the
 *   checklist names the entry; once it is posted the close goes through.
 * - A Draft invoice blocks; an uninvoiced delivery note only warns.
 * - The previous year still open blocks until it is closed.
 * - An unbalanced ledger group (lines 100/100, ledger 100/90) blocks through ledger-balanced and
 *   ale-vs-journal; captured in the baseline with the same amount it no longer blocks; once its
 *   amount changes, or a new mismatch appears, the close is refused again.
 * - GET /:id/close-checklist without doc.cancel: 403; an unmapped CURRENT_PROFIT shows up in it.
 *
 * The years are in the far past (1961/1960): every check counts the year's own rows, but
 * prev-year-open looks at all earlier years, and only years before the seeded 2026 (and the 2086+
 * years other tests commit for a moment) have none. Route handlers run through the route harness,
 * whose `$transaction` is a savepoint; everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { systemAccounts } from '../../services/systemAccounts';
import { CLOSE_CHECKLIST_FAILED, captureCloseBaseline, type CloseChecklist, type CloseCheckResult } from '../../services/fiscalYearClose';
import { updateAccountBalance } from '../../utils/accountBalance';
import fiscalYearsRouter from '../../routes/fiscalYears';
import fixedAssetsRouter from '../../routes/fixedAssets';

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

afterEach(() => {
  vi.restoreAllMocks();
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

const Y = 1961;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type RootType = 'ASSET' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function account(tx: Tx, rootType: RootType, name: string): Promise<string> {
  const a = await tx.account.create({
    data: { name: `IT-FYC ${name}`, accountNumber: `IT-FYC-${tag()}`, accountType: rootType, rootType },
  });
  return a.id;
}

interface Books {
  fy: FiscalYear;
  cashId: string;
  revenueId: string;
  currentProfitId: string;
  retainedId: string;
}

/** Maps CURRENT_PROFIT / RETAINED_EARNINGS to the fixture accounts; other roles keep their mapping. */
function stubMapping(books: Pick<Books, 'currentProfitId' | 'retainedId'>, missing: string[] = []) {
  const original = systemAccounts.getAccounts.bind(systemAccounts);
  const fake = (id: string) => [{ id, accountNumber: id, name: id }];
  vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) => {
    if (missing.includes(role)) return [];
    if (role === 'CURRENT_PROFIT') return fake(books.currentProfitId);
    if (role === 'RETAINED_EARNINGS') return fake(books.retainedId);
    return original(role);
  });
}

async function books(tx: Tx, year = Y): Promise<Books> {
  const b: Books = {
    fy: await createFiscalYear(tx, { year }),
    cashId: await account(tx, 'ASSET', 'Kas'),
    revenueId: await account(tx, 'REVENUE', 'Pendapatan'),
    currentProfitId: await account(tx, 'EQUITY', 'Laba tahun berjalan'),
    retainedId: await account(tx, 'EQUITY', 'Laba ditahan'),
  };
  stubMapping(b);
  return b;
}

/**
 * A submitted two-line journal in `fy` with its running balances and ledger rows; `ledgerCredit`
 * writes a different credit to the ledger than the line has (a mismatch).
 */
async function post(tx: Tx, fy: FiscalYear, date: string, debitId: string, creditId: string, amount: number, ledgerCredit = amount) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-FYC-${tag()}`,
      date: new Date(date),
      narration: 'IT-FYC fixture',
      status: 'Submitted',
      fiscalYearId: fy.id,
      createdBy: actor.userId,
      submittedAt: new Date(),
      items: { create: [{ accountId: debitId, debit: amount, credit: 0 }, { accountId: creditId, debit: 0, credit: amount }] },
    },
  });
  const row = { date: new Date(date), referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id };
  await tx.accountingLedgerEntry.createMany({
    data: [
      { ...row, accountId: debitId, debit: amount, credit: 0 },
      { ...row, accountId: creditId, debit: 0, credit: ledgerCredit },
    ],
  });
  await updateAccountBalance(tx, debitId, amount, 0);
  await updateAccountBalance(tx, creditId, 0, amount);
  return je;
}

const asActor = (who?: { userId: string; role: string }) => ({ userId: (who ?? actor).userId, role: (who ?? actor).role });

function close(fyId: string): Promise<RouteResult> {
  return callRoute(fiscalYearsRouter, 'post', '/:id/close', { params: { id: fyId }, ...asActor() });
}

function checklist(fyId: string, who?: { userId: string; role: string }): Promise<RouteResult> {
  return callRoute(fiscalYearsRouter, 'get', '/:id/close-checklist', { params: { id: fyId }, ...asActor(who) });
}

function check(list: CloseChecklist, id: string): CloseCheckResult {
  const found = list.checks.find((c) => c.id === id);
  if (!found) throw new Error(`check ${id} missing from ${JSON.stringify(list.checks.map((c) => c.id))}`);
  return found;
}

/** Ids of the failing checks of a severity. */
function failing(list: CloseChecklist, severity: 'block' | 'warn'): string[] {
  return list.checks.filter((c) => c.severity === severity && c.status === 'fail').map((c) => c.id);
}

/** Close refused by the checklist: 400, the code, the year still open; returns the checklist. */
async function expectRefused(tx: Tx, fy: FiscalYear): Promise<CloseChecklist> {
  const r = await close(fy.id);
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(CLOSE_CHECKLIST_FAILED);
  expect(r.body.error).toMatch(new RegExp(`^Tahun buku ${fy.name} belum bisa ditutup`));
  expect((await tx.fiscalYear.findUniqueOrThrow({ where: { id: fy.id } })).isClosed).toBe(false);
  expect(await tx.journalEntry.count({ where: { fiscalYearId: fy.id, sourceType: 'FY_CLOSE' } })).toBe(0);
  return r.body.checklist as CloseChecklist;
}

async function expectClosed(fy: FiscalYear) {
  const r = await close(fy.id);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toMatchObject({ id: fy.id, isClosed: true });
}

async function party(tx: Tx): Promise<string> {
  const p = await tx.party.create({ data: { name: `IT-FYC Customer ${tag()}`, partyType: 'Customer' } });
  return p.id;
}

d('year-close checklist', () => {
  it('10 jt of December depreciation unposted: close refused with the entry listed; posted, it closes', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await post(tx, b.fy, `${Y}-03-15`, b.cashId, b.revenueId, 50 * JT);
      const asset = await tx.fixedAsset.create({
        data: {
          assetNumber: `IT-FYC-${tag()}`,
          name: 'IT-FYC Mesin',
          category: 'IT-FYC',
          acquisitionDate: new Date(`${Y}-12-01`),
          acquisitionCost: 120 * JT,
          usefulLifeMonths: 12,
          bookValue: 120 * JT,
          assetAccountId: await account(tx, 'ASSET', 'Aset'),
          depreciationAccountId: await account(tx, 'EXPENSE', 'Beban penyusutan'),
          accumulatedDepAccountId: await account(tx, 'ASSET', 'Akumulasi penyusutan'),
          fiscalYearId: b.fy.id,
          createdBy: actor.userId,
        },
      });
      const dec = await tx.depreciationEntry.create({
        data: { fixedAssetId: asset.id, periodDate: new Date(`${Y}-12-01`), amount: 10 * JT },
      });
      // January of the next year is outside this year and does not count.
      await tx.depreciationEntry.create({ data: { fixedAssetId: asset.id, periodDate: new Date(`${Y + 1}-01-01`), amount: 10 * JT } });

      const list = await expectRefused(tx, b.fy);
      expect(list).toMatchObject({ canClose: false, blocking: 1, fiscalYear: { id: b.fy.id, startDay: `${Y}-01-01`, endDay: `${Y}-12-31` } });
      expect(failing(list, 'block')).toEqual(['depreciation-unposted']);
      expect(check(list, 'depreciation-unposted')).toMatchObject({
        severity: 'block',
        status: 'fail',
        count: 1,
        items: [{ key: dec.id, kind: 'DepreciationEntry', date: `${Y}-12-01`, amount: '10000000.00', label: `${asset.assetNumber} IT-FYC Mesin` }],
      });

      // The preview says the same.
      const preview = await checklist(b.fy.id);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body).toMatchObject({ canClose: false, blocking: 1 });
      expect(check(preview.body, 'depreciation-unposted').count).toBe(1);

      const dep = await callRoute(fixedAssetsRouter, 'post', '/:id/depreciate', { params: { id: asset.id }, body: { entryId: dec.id }, ...asActor() });
      expect(dep.status, JSON.stringify(dep.body)).toBe(200);
      const after = await checklist(b.fy.id);
      expect(after.body).toMatchObject({ canClose: true, blocking: 0 });
      await expectClosed(b.fy);
    });
  });

  it('a Draft invoice blocks; an uninvoiced delivery note only warns', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx);
      const invoice = await tx.salesInvoice.create({
        data: {
          invoiceNumber: `IT-FYC-INV-${tag()}`,
          date: new Date(`${Y}-11-20`),
          partyId: customer,
          grandTotal: 5 * JT,
          outstanding: 5 * JT,
          fiscalYearId: b.fy.id,
          createdBy: actor.userId,
        },
      });
      const sj = await tx.deliveryOrder.create({
        data: { doNumber: `IT-FYC-DO-${tag()}`, date: new Date(`${Y}-12-30`), partyId: customer, fiscalYearId: b.fy.id, createdBy: actor.userId },
      });

      const list = await expectRefused(tx, b.fy);
      expect(failing(list, 'block')).toEqual(['drafts-ledger']);
      expect(failing(list, 'warn')).toEqual(['do-uninvoiced']);
      expect(list).toMatchObject({ blocking: 1, warnings: 1 });
      expect(check(list, 'drafts-ledger')).toMatchObject({
        count: 1,
        items: [{ key: `SalesInvoice:${invoice.id}`, kind: 'SalesInvoice', label: invoice.invoiceNumber, date: `${Y}-11-20`, amount: '5000000.00' }],
      });
      expect(check(list, 'do-uninvoiced')).toMatchObject({ severity: 'warn', count: 1, items: [{ key: sj.id, label: sj.doNumber }] });

      // Without the draft only the warning is left, and it does not stop the close.
      await tx.salesInvoice.update({ where: { id: invoice.id }, data: { status: 'Cancelled' } });
      const preview = await checklist(b.fy.id);
      expect(preview.body).toMatchObject({ canClose: true, blocking: 0, warnings: 1 });
      await expectClosed(b.fy);
    });
  });

  it('the previous fiscal year still open blocks until it is closed', async () => {
    await inRollback(async (tx) => {
      const prev = await createFiscalYear(tx, { year: Y - 1 });
      const b = await books(tx);

      const list = await expectRefused(tx, b.fy);
      expect(failing(list, 'block')).toEqual(['prev-year-open']);
      expect(check(list, 'prev-year-open').items).toEqual([{ key: prev.id, kind: 'FiscalYear', label: prev.name, date: `${Y - 1}-12-31` }]);

      await expectClosed(prev);
      await expectClosed(b.fy);
    });
  });

  it('a ledger mismatch blocks unless the baseline has it with the same amount; a changed or new one blocks', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // Lines 100/100, ledger 100/90: the year's ledger is 10 jt off, and so is the journal.
      const je = await post(tx, b.fy, `${Y}-05-10`, b.cashId, b.revenueId, 100 * JT, 90 * JT);

      const list = await expectRefused(tx, b.fy);
      expect(failing(list, 'block')).toEqual(['ledger-balanced', 'ale-vs-journal']);
      expect(check(list, 'ledger-balanced').items).toEqual([
        { key: `JournalEntry:${je.id}@${b.fy.id}`, kind: 'JournalEntry', label: je.entryNumber, date: `${Y}-05-10`, amount: '10000000.00' },
      ]);
      expect(check(list, 'ale-vs-journal').items).toEqual([
        { key: `${je.id}@${b.fy.id}`, kind: 'JournalEntry', label: je.entryNumber, date: `${Y}-05-10`, amount: '10000000.00' },
      ]);

      // Dry run writes nothing; apply captures both items once.
      const dry = await captureCloseBaseline(tx, b.fy, false);
      expect(dry.map((c) => [c.checkId, c.added])).toEqual([['ledger-balanced', true], ['ale-vs-journal', true]]);
      expect(await tx.closeCheckBaseline.count({ where: { fiscalYearId: b.fy.id } })).toBe(0);
      await captureCloseBaseline(tx, b.fy, true);
      const again = await captureCloseBaseline(tx, b.fy, true);
      expect(again.map((c) => c.added)).toEqual([false, false]);
      expect(await tx.closeCheckBaseline.count({ where: { fiscalYearId: b.fy.id } })).toBe(2);

      const baselined = await checklist(b.fy.id);
      expect(baselined.body).toMatchObject({ canClose: true, blocking: 0 });
      expect(check(baselined.body, 'ale-vs-journal')).toMatchObject({
        status: 'ok', count: 0, baselinedCount: 1, items: [{ key: `${je.id}@${b.fy.id}`, baselined: true }],
      });

      // The same journal drifts further (ledger credit 85 instead of 90): no longer the baselined amount.
      await tx.accountingLedgerEntry.updateMany({ where: { referenceId: je.id, credit: { gt: 0 } }, data: { credit: 85 * JT } });
      const drifted = await expectRefused(tx, b.fy);
      expect(failing(drifted, 'block')).toEqual(['ledger-balanced', 'ale-vs-journal']);
      expect(check(drifted, 'ale-vs-journal').items).toEqual([expect.objectContaining({ amount: '15000000.00' })]);
      expect(check(drifted, 'ale-vs-journal').items[0]!.baselined).toBeUndefined();

      // Back to the baselined amount, plus a new mismatch on another journal: only the new one counts.
      await tx.accountingLedgerEntry.updateMany({ where: { referenceId: je.id, credit: { gt: 0 } }, data: { credit: 90 * JT } });
      const fresh = await post(tx, b.fy, `${Y}-06-10`, b.cashId, b.revenueId, 20 * JT, 19 * JT);
      const withNew = await expectRefused(tx, b.fy);
      expect(check(withNew, 'ale-vs-journal')).toMatchObject({
        status: 'fail',
        count: 1,
        baselinedCount: 1,
        items: [
          { key: `${fresh.id}@${b.fy.id}`, amount: '1000000.00' },
          { key: `${je.id}@${b.fy.id}`, baselined: true },
        ],
      });

      // Fixed: the year closes with the baselined mismatch still there.
      await tx.accountingLedgerEntry.updateMany({ where: { referenceId: fresh.id, credit: { gt: 0 } }, data: { credit: 20 * JT } });
      await expectClosed(b.fy);
    });
  });

  it('a cancelled journal whose ledger rows are still active is a mismatch', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const je = await post(tx, b.fy, `${Y}-07-01`, b.cashId, b.revenueId, 3 * JT);
      await tx.journalEntry.update({ where: { id: je.id }, data: { status: 'Cancelled' } });

      const list = await expectRefused(tx, b.fy);
      expect(failing(list, 'block')).toEqual(['ale-vs-journal']);
      expect(check(list, 'ale-vs-journal').items).toEqual([expect.objectContaining({ key: `${je.id}@${b.fy.id}`, amount: '6000000.00' })]);
    });
  });

  it('GET /:id/close-checklist needs doc.cancel and reports an unmapped close account', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const viewer = await createCapUser(tx, []);
      const denied = await checklist(b.fy.id, viewer);
      expect(denied.status).toBe(403);

      vi.restoreAllMocks();
      stubMapping(b, ['CURRENT_PROFIT']);
      const r = await checklist(b.fy.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(failing(r.body, 'block')).toEqual(['system-accounts']);
      expect(check(r.body, 'system-accounts').items).toEqual([{ key: 'CURRENT_PROFIT', kind: 'SystemAccountRole', label: 'Laba Tahun Berjalan' }]);

      const missing = await checklist('00000000-0000-0000-0000-000000000000');
      expect(missing.status).toBe(400);
    });
  });

  it('a close account mapped to an inactive or group account blocks the close before it posts', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      await post(tx, b.fy, `${Y}-06-15`, b.cashId, b.revenueId, 1_000_000);
      await tx.account.update({ where: { id: b.retainedId }, data: { isActive: false } });
      await tx.account.update({ where: { id: b.currentProfitId }, data: { isGroup: true } });

      const list = await expectRefused(tx, b.fy);
      expect(failing(list, 'block')).toEqual(['system-accounts']);
      expect(check(list, 'system-accounts').items.map((i) => i.key)).toEqual(['CURRENT_PROFIT', 'RETAINED_EARNINGS']);

      await tx.account.update({ where: { id: b.retainedId }, data: { isActive: true } });
      await tx.account.update({ where: { id: b.currentProfitId }, data: { isGroup: false } });
      await expectClosed(b.fy);
    });
  });
});
