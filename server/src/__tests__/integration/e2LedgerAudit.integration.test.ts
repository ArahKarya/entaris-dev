/**
 * Integration test: the ledger audit (E2-R3, E7-R5, E7-R9; PR-4.1).
 *
 * Fixture year 2170 (unique to this file): an open fiscal year A (Jan-Jun) and a closed one B
 * (Jul-Dec). Ledger rows are written straight to the table (the ledger balance triggers do not
 * exist yet, and the old journal trigger is deferred, so nothing fires inside the rollback).
 * Every assertion is limited to the fixture (fiscal year, ids, template names), so data elsewhere
 * in the database does not matter. Everything runs in a rollback transaction.
 * - aleGroups: an unbalanced group per cause (journal missing, journal cancelled, other), a balanced
 *   group split over two fiscal years, --since, cancelled rows ignored, closed years reported but
 *   never gating, and the same definition feeds the year-close check (includeFySplit false).
 * - journalSubCent / journalTooFewLines / ledgerOnGroupOrInactive / manualPartyLines /
 *   recurringTemplates / sourceNull each detect their cases and leave the clean ones alone.
 * - The audit writes nothing: row counts of every table it reads are equal before and after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type FiscalYear, type JournalSourceType, type DocumentStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { invalidatePermissionCache } from '../../services/permissionService';
import { gateExitCode, runLedgerAudit, type AuditRow, type LedgerAuditResult } from '../../services/ledger/ledgerAudit';
import { findUnbalancedAleGroups } from '../../services/ledger/ledgerAudit/sections/aleGroups';

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
      invalidatePermissionCache();
      try {
        await fn(tx);
      } finally {
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => Math.random().toString(36).slice(2, 8);

interface Fixture {
  userId: string;
  fyA: FiscalYear;
  fyB: FiscalYear;
  contra: string;
  cash: string;
  group: string;
  inactive: string;
  ar: string;
  customerDeposit: string;
  customer: string;
  supplier: string;
}

async function account(tx: Tx, name: string, over: { isGroup?: boolean; isActive?: boolean } = {}): Promise<string> {
  return (
    await tx.account.create({
      data: { name, accountNumber: `IT2170-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE', ...over },
    })
  ).id;
}

async function roleAccount(tx: Tx, role: string): Promise<string> {
  const m = await tx.systemAccountMapping.findFirst({ where: { role } });
  if (!m) throw new Error(`No system account mapping for ${role}.`);
  return m.accountId;
}

async function fixture(tx: Tx): Promise<Fixture> {
  const { userId } = await createCapUser(tx, []);
  const suffix = tag();
  const fyA = await tx.fiscalYear.create({
    data: { name: `IT-2170A-${suffix}`, startDate: new Date('2170-01-01'), endDate: new Date('2170-06-30') },
  });
  const fyB = await tx.fiscalYear.create({
    data: { name: `IT-2170B-${suffix}`, startDate: new Date('2170-07-01'), endDate: new Date('2170-12-31'), isClosed: true, closedAt: new Date() },
  });
  const customer = await tx.party.create({ data: { name: `IT Customer ${suffix}`, partyType: 'Customer' } });
  const supplier = await tx.party.create({ data: { name: `IT Supplier ${suffix}`, partyType: 'Supplier' } });
  return {
    userId,
    fyA,
    fyB,
    contra: await account(tx, 'IT contra'),
    cash: await account(tx, 'IT cash'),
    group: await account(tx, 'IT group', { isGroup: true }),
    inactive: await account(tx, 'IT inactive', { isActive: false }),
    ar: await roleAccount(tx, 'AR'),
    customerDeposit: await roleAccount(tx, 'CUSTOMER_DEPOSIT'),
    customer: customer.id,
    supplier: supplier.id,
  };
}

interface LineSpec { accountId: string; debit?: number | string; credit?: number | string; partyId?: string }

async function journal(
  tx: Tx,
  f: Fixture,
  over: { status?: DocumentStatus; sourceType?: JournalSourceType | null; number?: string; fy?: FiscalYear; day?: string },
  lines: LineSpec[],
) {
  const fy = over.fy ?? f.fyA;
  return tx.journalEntry.create({
    data: {
      entryNumber: over.number ?? `IT2170-${tag()}`,
      date: new Date(`${over.day ?? '2170-03-10'}T00:00:00Z`),
      status: over.status ?? 'Submitted',
      narration: 'IT audit',
      fiscalYearId: fy.id,
      createdBy: f.userId,
      sourceType: over.sourceType === undefined ? 'SYSTEM_DOC' : over.sourceType,
      items: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          partyId: l.partyId ?? null,
        })),
      },
    },
    include: { items: true },
  });
}

async function ale(
  tx: Tx,
  f: Fixture,
  o: { type?: string; id: string; fy?: FiscalYear; account?: string; debit?: number; credit?: number; cancelled?: boolean; createdAt?: Date },
) {
  const fy = o.fy ?? f.fyA;
  await tx.accountingLedgerEntry.create({
    data: {
      date: new Date(fy === f.fyB ? '2170-08-10T00:00:00Z' : '2170-03-10T00:00:00Z'),
      accountId: o.account ?? f.contra,
      debit: o.debit ?? 0,
      credit: o.credit ?? 0,
      referenceType: o.type ?? 'JournalEntry',
      referenceId: o.id,
      fiscalYearId: fy.id,
      isCancelled: o.cancelled ?? false,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  });
}

const rowsOf = (r: LedgerAuditResult, id: string): AuditRow[] => r.sections.find((s) => s.id === id)?.rows ?? [];

async function counts(tx: Tx): Promise<number[]> {
  return Promise.all([
    tx.accountingLedgerEntry.count(),
    tx.journalEntry.count(),
    tx.journalItem.count(),
    tx.recurringTemplate.count(),
    tx.account.count(),
    tx.party.count(),
  ]);
}

d('ledger audit', () => {
  it('aleGroups: finds every cause, ignores balanced, cancelled and old rows, and gates on open years only', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      const missingId = randomUUID();
      const cancelled = await journal(tx, f, { status: 'Cancelled' }, [{ accountId: f.contra, debit: 50 }, { accountId: f.cash, credit: 50 }]);
      const payment = randomUUID();
      const split = randomUUID();
      const balancedSplit = randomUUID();
      const balanced = randomUUID();
      const onlyCancelledRows = randomUUID();
      const old = randomUUID();
      const oldClosed = randomUUID();

      await ale(tx, f, { id: missingId, debit: 100 });
      await ale(tx, f, { id: cancelled.id, debit: 50 });
      await ale(tx, f, { type: 'Payment', id: payment, debit: 70 });
      await ale(tx, f, { type: 'Payment', id: split, debit: 200 });
      await ale(tx, f, { type: 'Payment', id: split, fy: f.fyB, credit: 200 });
      await ale(tx, f, { type: 'Payment', id: balancedSplit, debit: 10, credit: 10 });
      await ale(tx, f, { type: 'Payment', id: balancedSplit, fy: f.fyB, debit: 10, credit: 10 });
      await ale(tx, f, { id: balanced, debit: 30 });
      await ale(tx, f, { id: balanced, credit: 30 });
      await ale(tx, f, { id: onlyCancelledRows, debit: 9, cancelled: true });
      await ale(tx, f, { type: 'Payment', id: old, debit: 5, createdAt: new Date('2020-01-01T00:00:00Z') });
      await ale(tx, f, { type: 'Payment', id: oldClosed, fy: f.fyB, debit: 5, createdAt: new Date('2020-01-01T00:00:00Z') });

      const found = await findUnbalancedAleGroups(tx, { fiscalYearId: f.fyA.id });
      const byRef = (id: string) => found.filter((g) => g.referenceId === id);
      expect(byRef(missingId).map((g) => [g.cause, g.difference, g.yearClosed])).toEqual([['je-missing', '100.00', false]]);
      expect(byRef(cancelled.id).map((g) => [g.cause, g.label])).toEqual([['je-cancelled-active-ale', cancelled.entryNumber]]);
      expect(byRef(payment).map((g) => [g.cause, g.referenceType])).toEqual([['other', 'Payment']]);
      expect(byRef(split).map((g) => [g.cause, g.difference, g.fiscalYearCount])).toEqual([['fy-split', '200.00', 2]]);
      expect(byRef(balancedSplit).map((g) => [g.cause, g.difference])).toEqual([['fy-split', '0.00']]);
      expect(byRef(balanced)).toEqual([]);
      expect(byRef(onlyCancelledRows)).toEqual([]);
      expect(byRef(old).map((g) => g.cause)).toEqual(['other']);

      // The year-close definition: no balanced split slices, same unbalanced slices.
      const closeView = await findUnbalancedAleGroups(tx, { fiscalYearId: f.fyA.id, includeFySplit: false });
      expect(closeView.filter((g) => g.referenceId === balancedSplit)).toEqual([]);
      expect(closeView.filter((g) => g.referenceId === split)).toHaveLength(1);

      // Without a year filter both slices of the split group show, the closed one flagged.
      const all = await findUnbalancedAleGroups(tx, {});
      expect(all.filter((g) => g.referenceId === split).map((g) => [g.fiscalYearId === f.fyB.id, g.yearClosed])).toEqual(
        expect.arrayContaining([[true, true], [false, false]]),
      );

      // --since cannot date a delete / cancel of an old row, so an old open-year group still shows;
      // an old closed-year group is dropped.
      const recent = await findUnbalancedAleGroups(tx, { since: new Date('2021-01-01T00:00:00Z') });
      expect(recent.filter((g) => g.referenceId === old)).toHaveLength(1);
      expect(recent.filter((g) => g.referenceId === oldClosed)).toEqual([]);
      expect(recent.filter((g) => g.referenceId === payment)).toHaveLength(1);

      // Gate: open year A blocks, a run limited to closed year B never does.
      const resA = await runLedgerAudit(tx, { only: ['aleGroups'], fiscalYearId: f.fyA.id });
      expect(gateExitCode(resA, 'trigger')).toBe(1);
      expect(gateExitCode(resA, 'tolerance')).toBe(0);
      const resB = await runLedgerAudit(tx, { only: ['aleGroups'], fiscalYearId: f.fyB.id });
      expect(rowsOf(resB, 'aleGroups').length).toBeGreaterThan(0);
      expect(rowsOf(resB, 'aleGroups').every((r) => r.yearClosed === true && r.gate === false)).toBe(true);
      expect(gateExitCode(resB, 'trigger')).toBe(0);
    });
  });

  it('journalSubCent and journalTooFewLines: sub-cent, unbalanced and thin journals', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      const subCent = await journal(tx, f, {}, [{ accountId: f.contra, debit: '100.01' }, { accountId: f.cash, credit: '100.00' }]);
      const off = await journal(tx, f, {}, [{ accountId: f.contra, debit: 105 }, { accountId: f.cash, credit: 100 }]);
      const fine = await journal(tx, f, {}, [{ accountId: f.contra, debit: 100 }, { accountId: f.cash, credit: 100 }]);
      const draft = await journal(tx, f, { status: 'Draft' }, [{ accountId: f.contra, debit: 3 }, { accountId: f.cash, credit: 1 }]);
      const one = await journal(tx, f, {}, [{ accountId: f.contra, debit: 10 }]);
      const zero = await journal(tx, f, {}, [{ accountId: f.contra, debit: 10 }, { accountId: f.cash }]);
      const closedOff = await journal(tx, f, { fy: f.fyB, day: '2170-08-10' }, [{ accountId: f.contra, debit: 8 }, { accountId: f.cash, credit: 7 }]);

      const res = await runLedgerAudit(tx, { only: ['journalSubCent', 'journalTooFewLines'], fiscalYearId: f.fyA.id });
      const sub = rowsOf(res, 'journalSubCent');
      expect(sub.find((r) => r.key === subCent.id)).toMatchObject({ cause: 'sub-cent', amount: '0.01', gate: true });
      expect(sub.find((r) => r.key === off.id)).toMatchObject({ cause: 'unbalanced', amount: '5.00', gate: true });
      expect(sub.find((r) => r.key === one.id)).toMatchObject({ cause: 'unbalanced' });
      expect(sub.find((r) => r.key === fine.id)).toBeUndefined();
      expect(sub.find((r) => r.key === draft.id)).toBeUndefined();
      expect(sub.find((r) => r.key === closedOff.id)).toBeUndefined();
      expect(gateExitCode(res, 'tolerance')).toBe(1);

      const thin = rowsOf(res, 'journalTooFewLines');
      expect(thin.find((r) => r.key === one.id)?.cause).toBe('one-valued-line');
      expect(thin.find((r) => r.key === zero.id)?.cause).toBe('one-valued-line');
      expect(thin.find((r) => r.key === fine.id)).toBeUndefined();

      // The closed year is reported, never gating.
      const resB = await runLedgerAudit(tx, { only: ['journalSubCent'], fiscalYearId: f.fyB.id });
      expect(rowsOf(resB, 'journalSubCent').find((r) => r.key === closedOff.id)).toMatchObject({ yearClosed: true, gate: false });
      expect(gateExitCode(resB, 'tolerance')).toBe(0);
    });
  });

  it('ledgerOnGroupOrInactive and sourceNull', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      await ale(tx, f, { id: randomUUID(), account: f.group, debit: 40 });
      await ale(tx, f, { id: randomUUID(), account: f.inactive, credit: 15 });
      await ale(tx, f, { id: randomUUID(), account: f.group, debit: 999, cancelled: true });
      await ale(tx, f, { id: randomUUID(), account: f.cash, debit: 1 });
      await journal(tx, f, { sourceType: null, number: 'ZZIT-0001', day: '2170-03-05' }, [{ accountId: f.contra, debit: 5 }, { accountId: f.cash, credit: 5 }]);
      await journal(tx, f, { sourceType: null, number: 'ZZIT-0002', day: '2170-03-25' }, [{ accountId: f.contra, debit: 7 }, { accountId: f.cash, credit: 7 }]);
      await journal(tx, f, { sourceType: null, number: 'ZZIT-0003', day: '2170-04-02' }, [{ accountId: f.contra, debit: 2 }, { accountId: f.cash, credit: 2 }]);
      await journal(tx, f, { sourceType: 'MANUAL', number: 'ZZIT-0004', day: '2170-03-06' }, [{ accountId: f.contra, debit: 2 }, { accountId: f.cash, credit: 2 }]);

      const res = await runLedgerAudit(tx, { only: ['ledgerOnGroupOrInactive', 'sourceNull'], fiscalYearId: f.fyA.id });
      const accts = rowsOf(res, 'ledgerOnGroupOrInactive');
      expect(accts.find((r) => r.key === f.group)).toMatchObject({ cause: 'group', amount: '40.00', count: 1 });
      expect(accts.find((r) => r.key === f.inactive)).toMatchObject({ cause: 'inactive', amount: '15.00' });
      expect(accts.find((r) => r.key === f.inactive)?.detail).toContain('credit balance');
      expect(accts.find((r) => r.key === f.cash)).toBeUndefined();

      const nulls = rowsOf(res, 'sourceNull');
      expect(nulls.find((r) => r.key === 'ZZIT@2170-03')).toMatchObject({ cause: 'source-null', count: 2, amount: '12.00' });
      expect(nulls.find((r) => r.key === 'ZZIT@2170-04')).toMatchObject({ count: 1 });
    });
  });

  it('manualPartyLines: party on a plain account, import line without party, wrong party type, manual deposit line, Both is fine', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      const onPlain = await journal(tx, f, { sourceType: 'MANUAL' }, [{ accountId: f.contra, debit: 10, partyId: f.customer }, { accountId: f.cash, credit: 10 }]);
      const importNoParty = await journal(tx, f, { sourceType: 'IMPORT' }, [{ accountId: f.ar, debit: 20 }, { accountId: f.cash, credit: 20 }]);
      const wrongType = await journal(tx, f, { sourceType: 'MANUAL' }, [{ accountId: f.ar, debit: 30, partyId: f.supplier }, { accountId: f.cash, credit: 30 }]);
      const deposit = await journal(tx, f, { sourceType: 'MANUAL' }, [{ accountId: f.customerDeposit, credit: 40, partyId: f.customer }, { accountId: f.cash, debit: 40 }]);
      const both = await tx.party.create({ data: { name: `IT Both ${tag()}`, partyType: 'Both' } });
      const bothLine = await journal(tx, f, { sourceType: 'MANUAL' }, [{ accountId: f.ar, debit: 25, partyId: both.id }, { accountId: f.cash, credit: 25 }]);
      const clean = await journal(tx, f, { sourceType: 'MANUAL' }, [{ accountId: f.ar, debit: 50, partyId: f.customer }, { accountId: f.cash, credit: 50 }]);
      const documentJournal = await journal(tx, f, { sourceType: 'SYSTEM_DOC' }, [{ accountId: f.contra, debit: 60, partyId: f.customer }, { accountId: f.cash, credit: 60 }]);

      const res = await runLedgerAudit(tx, { only: ['manualPartyLines'], fiscalYearId: f.fyA.id });
      const rows = rowsOf(res, 'manualPartyLines');
      expect(rows.find((r) => r.cause === 'party-role-ambiguous')).toBeUndefined();
      const byItem = (j: { items: { id: string; accountId: string }[] }, accountId: string) => j.items.find((i) => i.accountId === accountId)!.id;
      expect(rows.find((r) => r.key === byItem(onPlain, f.contra))?.cause).toBe('party-on-non-role-account');
      expect(rows.find((r) => r.key === byItem(importNoParty, f.ar))?.cause).toBe('import-role-line-without-party');
      expect(rows.find((r) => r.key === byItem(wrongType, f.ar))?.cause).toBe('party-type-mismatch');
      expect(rows.filter((r) => bothLine.items.some((i) => i.id === r.key))).toEqual([]);
      expect(rows.find((r) => r.key === byItem(deposit, f.customerDeposit))?.cause).toBe('manual-deposit-account');
      expect(rows.filter((r) => clean.items.some((i) => i.id === r.key))).toEqual([]);
      expect(rows.filter((r) => documentJournal.items.some((i) => i.id === r.key))).toEqual([]);
    });
  });

  it('recurringTemplates: reports templates that break the journal rules, leaves a clean and an inactive one', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      const name = (s: string) => `IT2170 ${s} ${tag()}`;
      const future = new Date('2170-05-01T00:00:00Z');
      const mk = (n: string, data: unknown, over: { type?: string; next?: Date; active?: boolean } = {}) =>
        tx.recurringTemplate.create({
          data: {
            name: n, templateType: over.type ?? 'journal', frequency: 'monthly', nextRunDate: over.next ?? future,
            isActive: over.active ?? true, templateData: data as object, createdBy: f.userId,
          },
        });
      const balancedItems = [{ accountId: f.contra, debit: 10, credit: 0 }, { accountId: f.cash, debit: 0, credit: 10 }];
      const nClean = name('clean'); await mk(nClean, { narration: 'x', items: balancedItems });
      const nUnbalanced = name('unbalanced');
      await mk(nUnbalanced, { narration: 'x', items: [{ accountId: f.contra, debit: 10, credit: 0 }, { accountId: f.cash, debit: 0, credit: 9 }] });
      const nGroup = name('group');
      await mk(nGroup, { narration: 'x', items: [{ accountId: f.group, debit: 10, credit: 0 }, { accountId: f.cash, debit: 0, credit: 10 }] });
      const nInactive = name('inactive account');
      await mk(nInactive, { narration: 'x', items: [{ accountId: f.inactive, debit: 10, credit: 0 }, { accountId: f.cash, debit: 0, credit: 10 }] });
      const nControl = name('control');
      await mk(nControl, { narration: 'x', items: [{ accountId: f.ar, debit: 10, credit: 0 }, { accountId: f.cash, debit: 0, credit: 10 }] });
      const nParty = name('party');
      await mk(nParty, { narration: 'x', items: balancedItems.map((i, k) => (k === 0 ? { ...i, partyId: f.customer } : i)) });
      const nPast = name('past'); await mk(nPast, { narration: 'x', items: balancedItems }, { next: new Date('2000-01-01T00:00:00Z') });
      const nType = name('type'); await mk(nType, { narration: 'x', items: balancedItems }, { type: 'sales_invoice' });
      const nOff = name('off');
      await mk(nOff, { narration: 'x', items: [{ accountId: f.group, debit: 1, credit: 0 }] }, { active: false });

      const res = await runLedgerAudit(tx, { only: ['recurringTemplates'] });
      const rows = rowsOf(res, 'recurringTemplates');
      const causes = (n: string) => rows.filter((r) => r.label === n).map((r) => r.cause).sort();
      expect(causes(nClean)).toEqual([]);
      expect(causes(nUnbalanced)).toEqual(['unbalanced']);
      expect(causes(nGroup)).toEqual(['account-group']);
      expect(causes(nInactive)).toEqual(['account-inactive']);
      expect(causes(nControl)).toEqual(['account-control-or-tax']);
      expect(causes(nParty)).toEqual(['has-party']);
      expect(causes(nPast)).toEqual(['next-run-in-past']);
      expect(causes(nType)).toEqual(['type-data-mismatch']);
      expect(causes(nOff)).toEqual([]);
    });
  });

  it('writes nothing: the tables it reads have the same row counts afterwards', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      await ale(tx, f, { id: randomUUID(), debit: 100 });
      await journal(tx, f, { sourceType: null }, [{ accountId: f.contra, debit: 105 }, { accountId: f.cash, credit: 100 }]);
      const before = await counts(tx);
      const res = await runLedgerAudit(tx, {});
      expect(res.sections.map((s) => s.id)).toEqual([
        'aleGroups', 'journalSubCent', 'journalTooFewLines', 'ledgerOnGroupOrInactive', 'manualPartyLines', 'nonJournalAle', 'recurringTemplates', 'sourceNull',
      ]);
      expect(await counts(tx)).toEqual(before);
    });
  });
});
