/**
 * Integration test: legacy STT cancel data to the paired model (E1-R6 migration, PR-6b, plan step 5
 * PR-5.2), services/ledger/sttCancelLegacy.ts behind scripts/repair/e1-stt-cancel-model.ts.
 *
 * Fixture years 2143 (open) and 2144 (closed), unique to this file; an inventory and an accrued
 * payable account of its own, a Supplier, and an Admin for the audit rows. A legacy pair is an STT
 * Cancelled, its JV-<stt> Cancelled and its JV-<stt>-CXL Submitted with the lines swapped:
 *   A  the original's ledger rows still active (ledger right, status wrong)
 *   B  the original's ledger rows cancelled too (only the reversal on the books)
 * Ledger rows are written straight to the table, every group balanced, and the stored balances
 * follow the active rows (a B case adds the original back to them where it tests a stored balance
 * that never dropped it). Queries are scoped to the fixture's STTs. Route handlers run through the
 * route harness; everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import journalsRouter from '../../routes/journals';
import { applyAccountImpacts } from '../../utils/accountBalance';
import { findAleJournalMismatches } from '../../services/ledger/aleSyncCheck';
import { findAccountBalanceDrift } from '../../services/ledger/storedBalances';
import { cancelJournalsInTx, JOURNAL_ALREADY_REVERSED } from '../../services/ledger/cancelJournals';
import { runCloseChecklist } from '../../services/fiscalYearClose';
import { setPeriodLockInTx } from '../../services/periodLock';
import {
  applySttCancelLegacy,
  planSttCancelLegacy,
  STT_CANCEL_AUDIT_ACTION,
  STT_CANCEL_SCRIPT,
  type LegacySttRow,
} from '../../services/ledger/sttCancelLegacy';

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
      try {
        await fn(tx);
      } finally {
        state.tx = null;
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const APPROVED = 'Bu Sari (akuntan)';

interface Books { open: FiscalYear; closed: FiscalYear; userId: string; partyId: string; inventoryId: string; accruedId: string }

async function books(tx: Tx): Promise<Books> {
  const account = async (name: string, rootType: 'ASSET' | 'LIABILITY') =>
    (await tx.account.create({ data: { name: `IT2143 ${name}`, accountNumber: `IT2143-${tag()}`, accountType: rootType, rootType } })).id;
  const key = `it2143-admin-${tag()}`;
  await tx.user.create({ data: { username: key, fullName: key, email: `${key}@test.invalid`, passwordHash: '-', role: 'Admin' } });
  return {
    open: await createFiscalYear(tx, { year: 2143 }),
    closed: await createFiscalYear(tx, { year: 2144, isClosed: true }),
    userId: (await createCapUser(tx, [])).userId,
    partyId: (await tx.party.create({ data: { name: `IT2143 Supplier ${tag()}`, partyType: 'Supplier' } })).id,
    inventoryId: await account('Persediaan', 'ASSET'),
    accruedId: await account('Hutang Belum Ditagih', 'LIABILITY'),
  };
}

/** Writes balanced ledger rows of a journal's lines and, when active, their balance impact. */
async function ledgerOf(tx: Tx, je: { id: string; date: Date; fiscalYearId: string }, lines: { accountId: string; debit: number; credit: number }[], cancelled: boolean) {
  await tx.accountingLedgerEntry.createMany({
    data: lines.map((l) => ({ ...l, date: je.date, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: je.fiscalYearId, isCancelled: cancelled })),
  });
  if (!cancelled) await applyAccountImpacts(tx, lines);
}

/** A legacy cancel pair of `amount` (shape A or B) in `fy`. */
async function legacyStt(tx: Tx, b: Books, shape: 'A' | 'B', opts: { fy?: FiscalYear; amount?: number } = {}) {
  const fy = opts.fy ?? b.open;
  const year = fy.startDate.getUTCFullYear();
  const amount = opts.amount ?? 1_000_000;
  const sttNumber = `IT2143-STT-${tag()}`;
  const stt = await tx.goodsReceipt.create({
    data: { sttNumber, date: new Date(`${year}-03-10T03:00:00Z`), partyId: b.partyId, status: 'Cancelled', fiscalYearId: fy.id, createdBy: b.userId },
  });
  const lines = [{ accountId: b.inventoryId, debit: amount, credit: 0 }, { accountId: b.accruedId, debit: 0, credit: amount }];
  const swapped = lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit }));
  const original = await tx.journalEntry.create({
    data: {
      entryNumber: `JV-${sttNumber}`, date: new Date(`${year}-03-10T03:00:00Z`), status: 'Cancelled', fiscalYearId: fy.id, createdBy: b.userId,
      cancelledAt: new Date(`${year}-03-12T03:00:00Z`), cancelledById: b.userId, cancelReason: 'Barang salah kirim',
      items: { create: lines },
    },
  });
  await ledgerOf(tx, original, lines, shape === 'B');
  const cxl = await tx.journalEntry.create({
    data: {
      entryNumber: `JV-${sttNumber}-CXL`, date: new Date(`${year}-03-12T03:00:00Z`), status: 'Submitted', fiscalYearId: fy.id, createdBy: b.userId,
      items: { create: swapped },
    },
  });
  await ledgerOf(tx, cxl, swapped, false);
  return { stt, sttNumber, original, cxl, amount };
}

type Pair = Awaited<ReturnType<typeof legacyStt>>;

/** Everything the repair may touch, to compare before and after. */
async function snapshot(tx: Tx, b: Books, pairs: Pair[]) {
  const ids = pairs.flatMap((p) => [p.original.id, p.cxl.id]);
  const [journals, ledger, accounts, audits] = await Promise.all([
    tx.journalEntry.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, status: true, reversedById: true, cancelledAt: true, cancelReason: true } }),
    tx.accountingLedgerEntry.findMany({ where: { referenceId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, isCancelled: true } }),
    tx.account.findMany({ where: { id: { in: [b.inventoryId, b.accruedId] } }, orderBy: { id: 'asc' }, select: { id: true, balance: true } }),
    tx.auditLog.count({ where: { action: STT_CANCEL_AUDIT_ACTION, entityId: { in: ids } } }),
  ]);
  return { journals, ledger, accounts: accounts.map((a) => ({ id: a.id, balance: a.balance.toFixed(2) })), audits };
}

const plan = (tx: Tx, pairs: Pair[]) => planSttCancelLegacy(tx, { sttNumbers: pairs.map((p) => p.sttNumber) });
const balance = async (tx: Tx, id: string) => (await tx.account.findUniqueOrThrow({ where: { id } })).balance.toFixed(2);
const classes = (rows: LegacySttRow[]) => Object.fromEntries(rows.map((r) => [r.sttNumber, r.cls]));

d('legacy STT cancel data: plan', () => {
  it('classifies A and B and writes nothing', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A');
      const bb = await legacyStt(tx, b, 'B', { amount: 10_950_000 });
      const before = await snapshot(tx, b, [a, bb]);

      const rows = await plan(tx, [a, bb]);
      expect(classes(rows)).toEqual({ [a.sttNumber]: 'A', [bb.sttNumber]: 'B' });
      const rowB = rows.find((r) => r.sttNumber === bb.sttNumber)!;
      expect(rowB).toMatchObject({ action: 'fix-ledger', ledgerFixBlocked: null, originalAleActive: 0, originalAleCancelled: 2, locked: false });
      expect(rowB.amount.toFixed(2)).toBe('10950000.00');
      expect(rows.find((r) => r.sttNumber === a.sttNumber)).toMatchObject({ action: 'fix', reason: null, original: { status: 'Cancelled', day: '2143-03-10' } });
      expect(await snapshot(tx, b, [a, bb])).toEqual(before);
      // A shows in the ledger check as legacy-stt-pair; B is invisible to it.
      const mismatches = await findAleJournalMismatches(tx, { journalIds: [a.original.id, a.cxl.id, bb.original.id, bb.cxl.id] });
      expect(mismatches.rows.map((r) => [r.journalId, r.cause])).toEqual([[a.original.id, 'legacy-stt-pair']]);
    });
  });

  it('reports a CXL booked to another year than its date (C) and other shapes (REVIEW) without fixing them', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const c = await legacyStt(tx, b, 'A');
      await tx.journalEntry.update({ where: { id: c.cxl.id }, data: { date: new Date('2144-01-05T03:00:00Z') } });
      const notMirrored = await legacyStt(tx, b, 'A');
      await tx.journalItem.updateMany({ where: { journalEntryId: notMirrored.cxl.id, accountId: b.inventoryId }, data: { credit: 1 } });
      const sttActive = await legacyStt(tx, b, 'A');
      await tx.goodsReceipt.update({ where: { id: sttActive.stt.id }, data: { status: 'Submitted' } });

      const rows = await plan(tx, [c, notMirrored, sttActive]);
      expect(rows.map((r) => [r.sttNumber, r.cls, r.reason, r.action])).toEqual(
        [[c.sttNumber, 'C', 'fy-differs', 'none'], [notMirrored.sttNumber, 'REVIEW', 'lines-not-mirrored', 'none'], [sttActive.sttNumber, 'REVIEW', 'stt-not-cancelled', 'none']]
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      const before = await snapshot(tx, b, [c, notMirrored, sttActive]);
      const result = await applySttCancelLegacy(tx, rows, { approvedBy: APPROVED, includeAleFix: true });
      expect(result).toMatchObject({ fixed: [], ledgerFixed: [], skipped: [] });
      expect(await snapshot(tx, b, [c, notMirrored, sttActive])).toEqual(before);
    });
  });
});

d('legacy STT cancel data: apply', () => {
  it('without includeAleFix fixes only A: status and reversedBy, ledger and balances unchanged, one audit row', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A');
      const bb = await legacyStt(tx, b, 'B');
      const before = await snapshot(tx, b, [a, bb]);

      const result = await applySttCancelLegacy(tx, await plan(tx, [a, bb]), { approvedBy: APPROVED });
      expect(result.fixed).toEqual([a.sttNumber]);
      expect(result.ledgerFixed).toEqual([]);
      expect(result.skipped).toEqual([{ sttNumber: bb.sttNumber, why: expect.stringMatching(/--include-ale-fix/) }]);

      const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: a.original.id } });
      expect(original).toMatchObject({ status: 'Submitted', reversedById: a.cxl.id, cancelledAt: null, cancelledById: null, cancelReason: null });
      const after = await snapshot(tx, b, [a, bb]);
      expect(after.ledger).toEqual(before.ledger);
      expect(after.accounts).toEqual(before.accounts);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: bb.original.id } })).status).toBe('Cancelled');

      const audit = await tx.auditLog.findMany({ where: { action: STT_CANCEL_AUDIT_ACTION, entityId: { in: [a.original.id, bb.original.id] } } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'JournalEntry',
        entityId: a.original.id,
        via: 'repair',
        viaMeta: { script: STT_CANCEL_SCRIPT, approvedBy: APPROVED },
        oldValues: { status: 'Cancelled', cancelReason: 'Barang salah kirim', cancelledById: b.userId, aleActive: 2, aleCancelled: 0 },
        newValues: { status: 'Submitted', reversedById: a.cxl.id, cxlEntryNumber: a.cxl.entryNumber, class: 'A', ledgerReactivated: false, approvedBy: APPROVED },
      });
      expect((await findAleJournalMismatches(tx, { journalIds: [a.original.id, a.cxl.id] })).total).toBe(0);
    });
  });

  it('with includeAleFix restores B: ledger rows active, balances move by the STT amount, ledger check clean; a second run writes nothing', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A', { amount: 35_000 });
      const bb = await legacyStt(tx, b, 'B', { amount: 10_950_000 });
      // Only the B reversal is on the books: Inventory -10.95 jt, accrued payable -10.95 jt.
      expect(await balance(tx, b.inventoryId)).toBe('-10950000.00');
      expect(await balance(tx, b.accruedId)).toBe('-10950000.00');

      const rows = await plan(tx, [a, bb]);
      expect(rows.find((r) => r.sttNumber === bb.sttNumber)!.storedBalance).toMatchObject({ state: 'follows-ledger' });
      const result = await applySttCancelLegacy(tx, rows, { approvedBy: APPROVED, includeAleFix: true });
      expect(result).toMatchObject({ fixed: [a.sttNumber], ledgerFixed: [bb.sttNumber], skipped: [] });
      expect(await balance(tx, b.inventoryId)).toBe('0.00');
      expect(await balance(tx, b.accruedId)).toBe('0.00');
      expect((await findAccountBalanceDrift(tx, { accountIds: [b.inventoryId, b.accruedId] })).total).toBe(0);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: STT_CANCEL_AUDIT_ACTION, entityId: bb.original.id } });
      expect(audit.newValues).toMatchObject({ class: 'B', ledgerReactivated: true, storedBalance: 'follows-ledger' });
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: bb.original.id, isCancelled: true } })).toBe(0);
      expect(await tx.journalEntry.findUniqueOrThrow({ where: { id: bb.original.id } })).toMatchObject({ status: 'Submitted', reversedById: bb.cxl.id });
      const ids = [a.original.id, a.cxl.id, bb.original.id, bb.cxl.id];
      expect((await findAleJournalMismatches(tx, { journalIds: ids })).total).toBe(0);
      // Per account the pair nets to zero in the active ledger.
      const net = await tx.accountingLedgerEntry.groupBy({ by: ['accountId'], where: { referenceId: { in: ids }, isCancelled: false }, _sum: { debit: true, credit: true } });
      for (const n of net) expect(new Prisma.Decimal(n._sum.debit!).equals(n._sum.credit!)).toBe(true);

      const again = await plan(tx, [a, bb]);
      expect(again.map((r) => r.cls)).toEqual(['PAIRED', 'PAIRED']);
      const before = await snapshot(tx, b, [a, bb]);
      expect(await applySttCancelLegacy(tx, again, { approvedBy: APPROVED, includeAleFix: true })).toMatchObject({ fixed: [], ledgerFixed: [], skipped: [] });
      expect(await snapshot(tx, b, [a, bb])).toEqual(before);
    });
  });

  it('B whose stored balance never dropped the original (no balance fix after the ALE sync): ledger restored, balances not added twice', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const bb = await legacyStt(tx, b, 'B', { amount: 10_950_000 });
      // The CXL reversed the balances while both sets were active, the ALE sync then cancelled the
      // original's rows without touching balances: stored 0, ledger -10.95 jt.
      await applyAccountImpacts(tx, await tx.journalItem.findMany({ where: { journalEntryId: bb.original.id } }));
      expect(await balance(tx, b.inventoryId)).toBe('0.00');
      expect(await balance(tx, b.accruedId)).toBe('0.00');

      const rows = await plan(tx, [bb]);
      expect(rows[0]).toMatchObject({ cls: 'B', ledgerFixBlocked: null, storedBalance: { state: 'includes-original' } });
      const inventory = rows[0].storedBalance!.accounts.find((x) => x.accountId === b.inventoryId)!;
      expect([inventory.difference.toFixed(2), inventory.originalImpact.toFixed(2)]).toEqual(['10950000.00', '10950000.00']);

      const result = await applySttCancelLegacy(tx, rows, { approvedBy: APPROVED, includeAleFix: true });
      expect(result).toMatchObject({ ledgerFixed: [bb.sttNumber], skipped: [] });
      expect(await balance(tx, b.inventoryId)).toBe('0.00');
      expect(await balance(tx, b.accruedId)).toBe('0.00');
      expect((await findAccountBalanceDrift(tx, { accountIds: [b.inventoryId, b.accruedId] })).total).toBe(0);
      expect((await findAleJournalMismatches(tx, { journalIds: [bb.original.id, bb.cxl.id] })).total).toBe(0);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: STT_CANCEL_AUDIT_ACTION, entityId: bb.original.id } });
      expect(audit.newValues).toMatchObject({ class: 'B', storedBalance: 'includes-original' });
    });
  });

  it('skips B when its accounts carry other stored-balance drift, and changes nothing', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const bb = await legacyStt(tx, b, 'B');
      await tx.account.update({ where: { id: b.inventoryId }, data: { balance: { increment: 500 } } });
      const before = await snapshot(tx, b, [bb]);

      const rows = await plan(tx, [bb]);
      expect(rows[0]).toMatchObject({ cls: 'B', ledgerFixBlocked: 'stored-balance-drift', storedBalance: { state: 'drift' } });
      const result = await applySttCancelLegacy(tx, rows, { approvedBy: APPROVED, includeAleFix: true });
      expect(result.ledgerFixed).toEqual([]);
      expect(result.skipped).toEqual([{ sttNumber: bb.sttNumber, why: expect.stringMatching(/^stored-balance-drift: .*500\.00/) }]);
      expect(await snapshot(tx, b, [bb])).toEqual(before);
    });
  });

  it('skips B in a closed year or on or before the lock date; fixes A in a closed year', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const closedA = await legacyStt(tx, b, 'A', { fy: b.closed });
      const closedB = await legacyStt(tx, b, 'B', { fy: b.closed });
      const lockedB = await legacyStt(tx, b, 'B');
      await setPeriodLockInTx(tx, { lockDate: '2143-03-31', userId: b.userId, today: '2143-06-01' });
      const before = await snapshot(tx, b, [closedB, lockedB]);

      const rows = await plan(tx, [closedA, closedB, lockedB]);
      expect(rows.find((r) => r.sttNumber === closedB.sttNumber)!.ledgerFixBlocked).toBe('closed-year');
      expect(rows.find((r) => r.sttNumber === lockedB.sttNumber)).toMatchObject({ ledgerFixBlocked: 'locked', locked: true });

      const result = await applySttCancelLegacy(tx, rows, { approvedBy: APPROVED, includeAleFix: true });
      expect(result.fixed).toEqual([closedA.sttNumber]);
      expect(result.ledgerFixed).toEqual([]);
      expect(Object.fromEntries(result.skipped.map((s) => [s.sttNumber, s.why]))).toEqual({
        [closedB.sttNumber]: expect.stringMatching(/^PERIOD_CLOSED/),
        [lockedB.sttNumber]: expect.stringMatching(/^PERIOD_LOCKED/),
      });
      expect(await snapshot(tx, b, [closedB, lockedB])).toEqual(before);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: closedA.original.id } })).reversedById).toBe(closedA.cxl.id);
    });
  });

  it('refuses without an accountant, and skips a pair that changed after the plan', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A');
      const bb = await legacyStt(tx, b, 'B');
      const rows = await plan(tx, [a, bb]);
      await expect(applySttCancelLegacy(tx, rows, { approvedBy: '  ' })).rejects.toThrow(/--approved-by/);

      await tx.journalEntry.update({ where: { id: a.cxl.id }, data: { status: 'Cancelled' } });
      const one = await tx.accountingLedgerEntry.findFirstOrThrow({ where: { referenceId: bb.original.id } });
      await tx.accountingLedgerEntry.update({ where: { id: one.id }, data: { isCancelled: false } });
      const before = await snapshot(tx, b, [a, bb]);
      const result = await applySttCancelLegacy(tx, rows, { approvedBy: APPROVED, includeAleFix: true });
      expect(result.fixed).toEqual([]);
      expect(result.ledgerFixed).toEqual([]);
      expect(Object.fromEntries(result.skipped.map((s) => [s.sttNumber, s.why]))).toEqual({
        [a.sttNumber]: 'changed since the plan (now REVIEW)',
        [bb.sttNumber]: 'changed since the plan (now REVIEW)',
      });
      expect(await snapshot(tx, b, [a, bb])).toEqual(before);
    });
  });

  it('a fixed original cannot be voided again (JOURNAL_ALREADY_REVERSED)', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A');
      await applySttCancelLegacy(tx, await plan(tx, [a]), { approvedBy: APPROVED });
      const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: a.original.id }, include: { items: true } });
      await expect(cancelJournalsInTx(tx, [original], { label: 'penerimaan barang' })).rejects.toMatchObject({ code: JOURNAL_ALREADY_REVERSED });
    });
  });
});

d('legacy STT cancel data: read paths', () => {
  it('the year-close checklist warns with legacy-stt-cancel until the pairs are fixed', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A', { amount: 35_000 });
      const bb = await legacyStt(tx, b, 'B', { amount: 10_950_000 });
      const check = async () => (await runCloseChecklist(tx, { ...b.open, isClosed: false })).checks.find((c) => c.id === 'legacy-stt-cancel')!;

      const first = await check();
      expect(first).toMatchObject({ severity: 'warn', status: 'fail', count: 2 });
      expect(first.items.map((i) => [i.key, i.label, i.amount]).sort()).toEqual([
        [`GoodsReceipt:${a.stt.id}`, `${a.sttNumber} (A)`, '35000.00'],
        [`GoodsReceipt:${bb.stt.id}`, `${bb.sttNumber} (B)`, '10950000.00'],
      ].sort());

      await applySttCancelLegacy(tx, await plan(tx, [a, bb]), { approvedBy: APPROVED, includeAleFix: true });
      expect(await check()).toMatchObject({ status: 'ok', count: 0 });
    });
  });

  it('GET /journals and GET /journals/:id name the reversing journal of a fixed original', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const a = await legacyStt(tx, b, 'A');
      await applySttCancelLegacy(tx, await plan(tx, [a]), { approvedBy: APPROVED });

      const list = await callRoute(journalsRouter, 'get', '/', { userId: b.userId, query: { search: a.sttNumber } });
      expect(list.status).toBe(200);
      const byNumber = Object.fromEntries(list.body.data.map((j: any) => [j.entryNumber, j.reversedBy]));
      expect(byNumber).toEqual({ [a.original.entryNumber]: { id: a.cxl.id, entryNumber: a.cxl.entryNumber }, [a.cxl.entryNumber]: null });

      const one = await callRoute(journalsRouter, 'get', '/:id', { userId: b.userId, params: { id: a.original.id } });
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ status: 'Submitted', reversedBy: { id: a.cxl.id, entryNumber: a.cxl.entryNumber } });
    });
  });
});
