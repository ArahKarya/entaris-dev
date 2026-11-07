/**
 * Integration test: the COA import posts opening balances through the opening balance service and
 * the COA template exports the recorded opening, not the running balance (E2-R12, PR-5.8).
 *
 * Fixture: fiscal year 2153 (this file's year, plan §6.3) with company_settings.cutover_date
 * 2153-01-01 set inside the rollback transaction, and a fresh asset group P with detail accounts.
 * - Importing P.1 posts P.1 only: the keyed opening of P.10 (number prefix) is untouched; the same
 *   file again is 'unchanged' with no new journal.
 * - Template export -> re-import unchanged: zero new journals, the balance sheet identical, also
 *   after the cut-over year is closed. The template holds the recorded opening (500), never the
 *   running balance (700), and a blank cell for an account without one.
 * - An old template with running balances: the replacement is refused without confirmReplace and a
 *   value equal to the running balance on an account without an opening is refused too; nothing posts.
 * - A replacement in a closed year is refused (PERIOD_CLOSED) and the balance sheet stays.
 * - A keyed opening journal dated after the cut-over day (old import, keyed by the opening audit):
 *   the template round trip leaves it as it is, also when another row of the file is confirmed;
 *   confirmation is per account, so a confirmed replacement never lets a running balance through.
 * - The preview flags an openingDate other than the cut-over; a locked cut-over month is refused
 *   (PERIOD_LOCKED) unless a period.lock holder gives throughLockReason (audit row with the reason).
 * - No journal or ledger row is ever deleted (row counts never drop; a replaced journal is Cancelled).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null, file: null as { buffer: Buffer; originalname: string } | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../routes/import/shared', async (orig) => ({
  ...(await orig<typeof import('../../routes/import/shared')>()),
  upload: { single: () => (req: any, _res: unknown, next: () => void) => { req.file = state.file; next(); } },
}));

import ExcelJS from 'exceljs';
import { invalidatePermissionCache } from '../../services/permissionService';
import { updateAccountBalance } from '../../utils/accountBalance';
import { computeBalanceSheet } from '../../services/reports/balanceSheet';
import { asOfBound } from '../../utils/businessDate';
import { OPENING_DATE_MISMATCH, OPENING_LOCK_RIGHT, OPENING_THROUGH_LOCK_ACTION, setOpeningBalanceInTx } from '../../services/ledger/openingBalance';
import { sourceKeys } from '../../services/ledger/journalSource';
import { PERIOD_CLOSED, PERIOD_LOCKED } from '../../utils/periodGuard';
import coaImportRouter, { OPENING_REPLACE_UNCONFIRMED, OPENING_RUNNING_BALANCE } from '../../routes/import/coa';
import templateRouter from '../../routes/import/template';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
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
        actor = await createCapUser(tx, []);
        await fn(tx);
      } finally {
        state.tx = null;
        state.file = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 180000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2153;
const CUTOVER = `${Y}-01-01`;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function setCutover(tx: Tx) {
  await tx.companySettings.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', companyName: '' } });
  await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${CUTOVER}::date WHERE slug = 'default'`;
}

interface Fixture { fy: FiscalYear; group: string; p1: { id: string; accountNumber: string; name: string }; p10: { id: string; accountNumber: string; name: string }; p2: { id: string; accountNumber: string; name: string }; other: { id: string } }

/** Asset group P (under the stored group "1" when there is one) with detail accounts P.1, P.10, P.2 and a counter account. */
async function setup(tx: Tx): Promise<Fixture> {
  const fy = await createFiscalYear(tx, { year: Y });
  await setCutover(tx);
  const root = await tx.account.findUnique({ where: { accountNumber: '1' } });
  const group = `1.96${Date.now() % 100000}${Math.floor(Math.random() * 100)}`;
  const g = await tx.account.create({
    data: { accountNumber: group, name: `IT-ICO group ${tag()}`, rootType: 'ASSET', accountType: 'ASSET', isGroup: true, parentId: root?.isGroup ? root.id : null },
  });
  const detail = (suffix: string) => tx.account.create({
    data: { accountNumber: `${group}.${suffix}`, name: `IT-ICO ${suffix}`, rootType: 'ASSET', accountType: 'ASSET', parentId: g.id },
  });
  const p1 = await detail('1');
  const p10 = await detail('10');
  const p2 = await detail('2');
  const other = await detail('9');
  return { fy, group, p1, p10, p2, other };
}

/** A two-line manual journal with ledger rows and balances (a movement after the cut-over). */
async function move(tx: Tx, fy: FiscalYear, date: Date, debitId: string, creditId: string, amount: number) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-ICO-${tag()}`, date, narration: 'IT-ICO movement', status: 'Submitted', fiscalYearId: fy.id,
      createdBy: actor.userId, submittedAt: new Date(), sourceType: 'MANUAL',
      items: { create: [{ accountId: debitId, debit: amount, credit: 0 }, { accountId: creditId, debit: 0, credit: amount }] },
    },
  });
  const row = { date, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id };
  await tx.accountingLedgerEntry.createMany({
    data: [{ ...row, accountId: debitId, debit: amount, credit: 0 }, { ...row, accountId: creditId, debit: 0, credit: amount }],
  });
  await updateAccountBalance(tx, debitId, amount, 0);
  await updateAccountBalance(tx, creditId, 0, amount);
}

/** An opening journal keyed OPENING:ACCOUNT:<id> but dated `date` (the old import posted at input time). */
async function keyedOpeningOn(tx: Tx, fy: FiscalYear, date: Date, accountId: string, amount: number) {
  const equity = await tx.systemAccountMapping.findFirstOrThrow({ where: { role: 'OPENING_EQUITY' }, orderBy: { sortOrder: 'asc' } });
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-ICO-OB-${tag()}`, date, narration: 'Saldo awal akun (impor lama)', status: 'Submitted', fiscalYearId: fy.id,
      createdBy: actor.userId, submittedAt: new Date(), sourceType: 'OPENING', sourceKey: sourceKeys.openingAccount(accountId),
      items: { create: [{ accountId, debit: amount, credit: 0 }, { accountId: equity.accountId, debit: 0, credit: amount }] },
    },
  });
  const row = { date, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id };
  await tx.accountingLedgerEntry.createMany({
    data: [{ ...row, accountId, debit: amount, credit: 0 }, { ...row, accountId: equity.accountId, debit: 0, credit: amount }],
  });
  await updateAccountBalance(tx, accountId, amount, 0);
  await updateAccountBalance(tx, equity.accountId, 0, amount);
  return je;
}

const setOpening = (tx: Tx, accountId: string, amount: number) =>
  setOpeningBalanceInTx(tx, { target: { kind: 'ACCOUNT', accountId }, amount, userId: actor.userId });

const csv = (rows: Array<[string, string, string]>) =>
  Buffer.from(['accountNumber,name,rootType,accountType,parentNumber,isGroup,openingBalance',
    ...rows.map(([n, name, ob]) => `${n},${name},ASSET,ASSET,,false,${ob}`)].join('\n'));

async function importFile(buffer: Buffer, originalname: string, query: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  state.file = { buffer, originalname };
  const r = await callRoute(coaImportRouter, 'post', '/coa', { userId: actor.userId, role: actor.role, query, body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    success: number; errors: Array<{ row: number; message: string; code?: string }>; openings: Array<{ accountNumber: string; action: string }>;
    data?: Array<{ accountNumber: string; opening: { allowed: boolean; reason: string | null; action: string } | null }>;
  };
}

async function exportTemplate(): Promise<Buffer> {
  const r = await callRoute(templateRouter, 'get', '/template/:type', { userId: actor.userId, role: actor.role, params: { type: 'coa' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Buffer;
}

async function templateCell(buffer: Buffer, accountNumber: string): Promise<unknown> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  let value: unknown;
  wb.worksheets[0].eachRow((row) => { if (row.getCell(1).value === accountNumber) value = row.getCell(7).value; });
  return value;
}

/** Row counts of the journal tables: they must never drop (no DELETE). */
async function rowCounts(tx: Tx) {
  const [je, ale] = await Promise.all([tx.journalEntry.count(), tx.accountingLedgerEntry.count()]);
  return { je, ale };
}

async function balanceSheet(tx: Tx) {
  const bound = asOfBound(`${Y}-12-31`);
  if (!bound.ok) throw new Error(bound.error);
  return JSON.stringify(await computeBalanceSheet(tx, bound));
}

async function ledgerNet(tx: Tx, accountId: string): Promise<string> {
  const agg = await tx.accountingLedgerEntry.aggregate({ where: { accountId, isCancelled: false }, _sum: { debit: true, credit: true } });
  return new Prisma.Decimal(agg._sum.debit ?? 0).sub(agg._sum.credit ?? 0).toFixed(2);
}

const activeOpenings = (tx: Tx, accountId: string) =>
  tx.journalEntry.findMany({ where: { sourceKey: sourceKeys.openingAccount(accountId), status: { not: 'Cancelled' } }, include: { items: true } });

const rowErrors = (body: { errors: Array<{ message: string; code?: string }> }, accountNumber: string) =>
  body.errors.filter((e) => e.message.includes(`"${accountNumber}"`));

d('COA import opening balances through the opening balance service', () => {
  it('posts 1.1.1 without touching 1.1.10, and the same file again is unchanged', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      await setOpening(tx, f.p10.id, 700 * JT);
      const [p10Journal] = await activeOpenings(tx, f.p10.id);

      const first = await importFile(csv([[f.p1.accountNumber, f.p1.name, String(500 * JT)]]), 'coa.csv');
      expect(first.errors).toEqual([]);
      expect(first.openings).toEqual([expect.objectContaining({ accountNumber: f.p1.accountNumber, action: 'posted' })]);
      expect(await ledgerNet(tx, f.p1.id)).toBe('500000000.00');
      expect((await activeOpenings(tx, f.p10.id)).map((j) => j.id)).toEqual([p10Journal.id]);
      expect(await ledgerNet(tx, f.p10.id)).toBe('700000000.00');

      const before = await rowCounts(tx);
      const again = await importFile(csv([[f.p1.accountNumber, f.p1.name, '500000000.00']]), 'coa.csv');
      expect(again.errors).toEqual([]);
      expect(again.openings).toEqual([expect.objectContaining({ action: 'unchanged' })]);
      expect(await rowCounts(tx)).toEqual(before);
    });
  });

  it('template export then re-import unchanged writes no journal and keeps the balance sheet, also after the year is closed', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      await setOpening(tx, f.p1.id, 500 * JT);
      await move(tx, f.fy, new Date(`${Y}-03-10T09:00:00+07:00`), f.p1.id, f.other.id, 200 * JT);
      await move(tx, f.fy, new Date(`${Y}-03-11T09:00:00+07:00`), f.p2.id, f.other.id, 300 * JT);

      const template = await exportTemplate();
      expect(await templateCell(template, f.p1.accountNumber)).toBe(500 * JT);
      expect(await templateCell(template, f.p2.accountNumber) ?? '').toBe('');

      for (const closeFirst of [false, true]) {
        if (closeFirst) await tx.fiscalYear.update({ where: { id: f.fy.id }, data: { isClosed: true, closedAt: new Date() } });
        const counts = await rowCounts(tx);
        const sheet = await balanceSheet(tx);

        const body = await importFile(template, 'template_coa.xlsx');
        for (const acc of [f.p1, f.p10, f.p2]) expect(rowErrors(body, acc.accountNumber)).toEqual([]);
        expect(body.openings.find((o) => o.accountNumber === f.p1.accountNumber)?.action).toBe('unchanged');
        expect(await rowCounts(tx)).toEqual(counts);
        expect(await balanceSheet(tx)).toBe(sheet);
        expect(await ledgerNet(tx, f.p1.id)).toBe('700000000.00');
        expect(await ledgerNet(tx, f.p2.id)).toBe('300000000.00');
      }
    });
  });

  it('an old template with running balances posts nothing without confirmation; confirmReplace replaces without deleting', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      await setOpening(tx, f.p1.id, 500 * JT);
      await move(tx, f.fy, new Date(`${Y}-03-10T09:00:00+07:00`), f.p1.id, f.other.id, 200 * JT);
      await move(tx, f.fy, new Date(`${Y}-03-11T09:00:00+07:00`), f.p2.id, f.other.id, 300 * JT);
      const [oldJournal] = await activeOpenings(tx, f.p1.id);
      const counts = await rowCounts(tx);
      const sheet = await balanceSheet(tx);

      const old = csv([[f.p1.accountNumber, f.p1.name, String(700 * JT)], [f.p2.accountNumber, f.p2.name, String(300 * JT)]]);
      const refused = await importFile(old, 'old.csv');
      expect(refused.success).toBe(2);
      expect(rowErrors(refused, f.p1.accountNumber).map((e) => e.code)).toEqual([OPENING_REPLACE_UNCONFIRMED]);
      expect(rowErrors(refused, f.p2.accountNumber).map((e) => e.code)).toEqual([OPENING_RUNNING_BALANCE]);
      expect(refused.openings).toEqual([]);
      expect(await rowCounts(tx)).toEqual(counts);
      expect(await balanceSheet(tx)).toBe(sheet);

      const confirmed = await importFile(csv([[f.p1.accountNumber, f.p1.name, String(600 * JT)]]), 'fix.csv', { confirmReplace: f.p1.accountNumber });
      expect(confirmed.errors).toEqual([]);
      expect(confirmed.openings).toEqual([expect.objectContaining({ action: 'replaced' })]);
      expect((await tx.journalEntry.findUniqueOrThrow({ where: { id: oldJournal.id } })).status).toBe('Cancelled');
      expect(await tx.accountingLedgerEntry.count({ where: { referenceId: oldJournal.id, isCancelled: true } })).toBe(2);
      expect(await ledgerNet(tx, f.p1.id)).toBe('800000000.00');
      const after = await rowCounts(tx);
      expect(after.je).toBe(counts.je + 1);
      expect(after.ale).toBe(counts.ale + 2);
    });
  });

  it('refuses a replacement in a closed year and leaves that year balance sheet as it was', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      await setOpening(tx, f.p1.id, 500 * JT);
      await tx.fiscalYear.update({ where: { id: f.fy.id }, data: { isClosed: true, closedAt: new Date() } });
      const counts = await rowCounts(tx);
      const sheet = await balanceSheet(tx);

      const body = await importFile(csv([[f.p1.accountNumber, f.p1.name, String(650 * JT)]]), 'coa.csv', { confirmReplace: f.p1.accountNumber });
      expect(body.success).toBe(1);
      expect(rowErrors(body, f.p1.accountNumber).map((e) => e.code)).toEqual([PERIOD_CLOSED]);
      expect(await rowCounts(tx)).toEqual(counts);
      expect(await balanceSheet(tx)).toBe(sheet);
      expect(await ledgerNet(tx, f.p1.id)).toBe('500000000.00');
    });
  });

  it('a keyed opening dated after the cut-over day survives the template round trip, also when another row is confirmed', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      const old = await keyedOpeningOn(tx, f.fy, new Date(`${Y}-03-10T09:00:00+07:00`), f.p1.id, 500 * JT);
      await setOpening(tx, f.p2.id, 100 * JT);
      await move(tx, f.fy, new Date(`${Y}-04-02T09:00:00+07:00`), f.other.id, f.p2.id, 40 * JT);

      const template = await exportTemplate();
      expect(await templateCell(template, f.p1.accountNumber)).toBe(500 * JT);
      const counts = await rowCounts(tx);
      const sheet = await balanceSheet(tx);

      const shown = await importFile(template, 'template_coa.xlsx', { preview: 'true' });
      expect(shown.data?.find((r) => r.accountNumber === f.p1.accountNumber)?.opening).toMatchObject({ action: 'unchanged' });
      const roundTrip = await importFile(template, 'template_coa.xlsx');
      for (const acc of [f.p1, f.p2]) expect(rowErrors(roundTrip, acc.accountNumber)).toEqual([]);
      expect(roundTrip.openings.find((o) => o.accountNumber === f.p1.accountNumber)?.action).toBe('unchanged');
      expect(await rowCounts(tx)).toEqual(counts);
      expect(await balanceSheet(tx)).toBe(sheet);

      // Ticking p2's replacement: p1 (same value) is not voided and posted again on the cut-over day.
      const file = csv([[f.p1.accountNumber, f.p1.name, String(500 * JT)], [f.p2.accountNumber, f.p2.name, String(150 * JT)]]);
      const body = await importFile(file, 'fix.csv', {}, { confirmReplace: [f.p2.accountNumber] });
      expect(body.errors).toEqual([]);
      expect(body.openings.map((o) => [o.accountNumber, o.action])).toEqual([[f.p1.accountNumber, 'unchanged'], [f.p2.accountNumber, 'replaced']]);
      expect((await activeOpenings(tx, f.p1.id)).map((j) => j.id)).toEqual([old.id]);
      expect(await ledgerNet(tx, f.p1.id)).toBe('500000000.00');
      expect(await ledgerNet(tx, f.p2.id)).toBe('110000000.00');
    });
  });

  it('confirming one replacement does not post a running balance on another account', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      await setOpening(tx, f.p1.id, 500 * JT);
      await move(tx, f.fy, new Date(`${Y}-03-11T09:00:00+07:00`), f.p2.id, f.other.id, 300 * JT);
      const counts = await rowCounts(tx);

      const file = csv([[f.p1.accountNumber, f.p1.name, String(600 * JT)], [f.p2.accountNumber, f.p2.name, String(300 * JT)]]);
      const body = await importFile(file, 'old.csv', {}, { confirmReplace: [f.p1.accountNumber] });
      expect(body.openings).toEqual([expect.objectContaining({ accountNumber: f.p1.accountNumber, action: 'replaced' })]);
      expect(rowErrors(body, f.p2.accountNumber).map((e) => e.code)).toEqual([OPENING_RUNNING_BALANCE]);
      expect(await ledgerNet(tx, f.p2.id)).toBe('300000000.00');
      expect((await rowCounts(tx)).je).toBe(counts.je + 1);
    });
  });

  it('the preview flags an openingDate other than the cut-over date', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      const file = Buffer.from(['accountNumber,name,rootType,accountType,parentNumber,isGroup,openingBalance,openingDate',
        `${f.p1.accountNumber},${f.p1.name},ASSET,ASSET,,false,500000,${Y}-02-01`].join('\n'));
      const shown = await importFile(file, 'coa.csv', { preview: 'true' });
      expect(shown.data?.[0].opening).toMatchObject({ allowed: false, reason: OPENING_DATE_MISMATCH });
      const body = await importFile(file, 'coa.csv');
      expect(rowErrors(body, f.p1.accountNumber).map((e) => e.code)).toEqual([OPENING_DATE_MISMATCH]);
      expect(await ledgerNet(tx, f.p1.id)).toBe('0.00');
    });
  });

  it('a locked cut-over month: refused without throughLockReason; a period.lock holder posts with the reason audited', async () => {
    await inRollback(async (tx) => {
      const f = await setup(tx);
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${Y}-01-31`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      const file = csv([[f.p1.accountNumber, f.p1.name, String(500 * JT)]]);

      const refused = await importFile(file, 'coa.csv');
      expect(rowErrors(refused, f.p1.accountNumber).map((e) => e.code)).toEqual([PERIOD_LOCKED]);

      state.file = { buffer: file, originalname: 'coa.csv' };
      const noRight = await callRoute(coaImportRouter, 'post', '/coa', { userId: actor.userId, role: actor.role, body: { throughLockReason: 'Saldo awal dari akuntan' } });
      expect(noRight.status).toBe(403);
      expect((noRight.body as { code: string }).code).toBe(OPENING_LOCK_RIGHT);

      actor = await createCapUser(tx, ['period.lock']);
      const body = await importFile(file, 'coa.csv', {}, { throughLockReason: 'Saldo awal dari akuntan' });
      expect(body.errors).toEqual([]);
      expect(body.openings).toEqual([expect.objectContaining({ action: 'posted' })]);
      expect(await ledgerNet(tx, f.p1.id)).toBe('500000000.00');
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: OPENING_THROUGH_LOCK_ACTION, entityId: f.p1.id } });
      expect(audit.newValues).toMatchObject({ reason: 'Saldo awal dari akuntan', asOfDate: CUTOVER });
    });
  });
});
