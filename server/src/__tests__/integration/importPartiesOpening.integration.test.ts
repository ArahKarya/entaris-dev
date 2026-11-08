/**
 * Integration test: the party import posts opening balances through the opening balance service
 * (E2-R13, PR-5.12): arahSaldo, no negatives, the party template, no direct balance writes.
 *
 * Fixture: fiscal year 2157 (this file's year, plan §6.3) with company_settings.cutover_date
 * 2157-01-01 set inside the rollback transaction; fresh parties per case (names carry a tag).
 * - "Budi" is a party of its own: importing it never touches "Budi Santoso" (name and type, not a prefix).
 * - Both, openingBalance 20 jt, arahSaldo Hutang: AP +20 jt, AR unchanged, payable_outstanding 20 jt.
 * - A negative amount, a Both party without a direction and a Customer with Hutang are row errors; no party is created.
 * - A party with transactions imported again from an old file (outstandingAmount): outstanding, columns and GL
 *   unchanged, the row is reported (PARTY_OPENING_KEPT).
 * - A party without transactions: the same amount is 'unchanged'; a different one needs the row in
 *   confirmReplace, then replaces (old journal Cancelled, never deleted).
 * - Template export, then import of the same rows: zero new journals (Both with two sides is two rows).
 * - A closed year refuses a new party with an opening (PERIOD_CLOSED) and leaves no party behind.
 * - Row counts of the journal tables never drop (no DELETE).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient, type FiscalYear, type PartyType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null, file: null as { buffer: Buffer; originalname: string } | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../routes/import/shared', async (orig) => ({
  ...(await orig<typeof import('../../routes/import/shared')>()),
  upload: { single: () => (req: any, _res: unknown, next: () => void) => { req.file = state.file; next(); } },
}));

import { invalidatePermissionCache } from '../../services/permissionService';
import { mappedAccount } from '../../services/systemAccounts';
import { setOpeningBalanceInTx } from '../../services/ledger/openingBalance';
import { PERIOD_CLOSED } from '../../utils/periodGuard';
import partiesImportRouter from '../../routes/import/parties';
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

const Y = 2157;
const DAY = `${Y}-01-01`;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function inRollback(fn: (tx: Tx, fy: FiscalYear) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        actor = await createCapUser(tx, []);
        const fy = await createFiscalYear(tx, { year: Y });
        await tx.companySettings.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', companyName: '' } });
        await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${DAY}::date WHERE slug = 'default'`;
        await fn(tx, fy);
      } finally {
        state.tx = null;
        state.file = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const HEADERS = ['name', 'partyType', 'openingBalance', 'arahSaldo', 'depositBalance', 'customerDepositBalance', 'outstandingAmount'] as const;
type SheetRow = Partial<Record<(typeof HEADERS)[number], string>>;

const csv = (rows: SheetRow[]) =>
  Buffer.from([HEADERS.join(','), ...rows.map((r) => HEADERS.map((h) => r[h] ?? '').join(','))].join('\n'));

interface ImportBody {
  success: number;
  failed: number;
  errors: Array<{ row: number; message: string; code?: string }>;
  openings: Array<{ row: number; name: string; kind: string; action: string }>;
  data?: Array<{ rowNum: number; name: string; opening: { action: string; needsConfirm: boolean; recorded: string | null } | null }>;
}

async function importRows(rows: SheetRow[], query: Record<string, string> = {}, body: Record<string, unknown> = {}): Promise<ImportBody> {
  state.file = { buffer: csv(rows), originalname: 'parties.csv' };
  const r = await callRoute(partiesImportRouter, 'post', '/parties', { userId: actor.userId, role: actor.role, query, body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ImportBody;
}

const uniq = (label: string) => `IT2157 ${label} ${tag()}`;

const setParty = (tx: Tx, partyId: string, subledger: 'AR' | 'AP' | 'VDEP' | 'CDEP', amount: number) =>
  setOpeningBalanceInTx(tx, { target: { kind: 'PARTY', partyId, subledger }, amount: String(amount), userId: actor.userId });

const makeParty = (tx: Tx, name: string, partyType: PartyType) => tx.party.create({ data: { name, partyType } });

const findParty = (tx: Tx, name: string, partyType: PartyType) => tx.party.findFirst({ where: { name, partyType } });

/** Normal-side ledger of a party on one system account role. */
async function partyLedger(tx: Tx, partyId: string, role: 'AR' | 'AP'): Promise<string> {
  const account = await mappedAccount(tx, role);
  const agg = await tx.accountingLedgerEntry.aggregate({ where: { accountId: account.id, partyId, isCancelled: false }, _sum: { debit: true, credit: true } });
  const debit = agg._sum.debit ?? new Prisma.Decimal(0);
  const credit = agg._sum.credit ?? new Prisma.Decimal(0);
  return (role === 'AR' ? debit.sub(credit) : credit.sub(debit)).toFixed(2);
}

const columns = (tx: Tx, id: string) =>
  tx.party.findUniqueOrThrow({
    where: { id },
    select: { openingReceivable: true, openingPayable: true, openingOutstanding: true, outstandingAmount: true, receivableOutstanding: true, payableOutstanding: true, depositBalance: true, customerDepositBalance: true },
  });

const money = (v: Prisma.Decimal | number) => new Prisma.Decimal(v).toFixed(2);

/** Row counts of the journal tables: they must never drop (no DELETE). */
async function rowCounts(tx: Tx) {
  const [je, ale] = await Promise.all([tx.journalEntry.count(), tx.accountingLedgerEntry.count()]);
  return { je, ale };
}

d('party import opening balances (2157)', () => {
  it('imports a new party with its receivable through the service and leaves a party with a longer name alone', async () => {
    await inRollback(async (tx) => {
      const longer = uniq('Budi Santoso');
      const shorter = longer.replace(' Santoso', '');
      const santoso = await makeParty(tx, longer, 'Customer');
      await setParty(tx, santoso.id, 'AR', 1 * JT);
      const before = await rowCounts(tx);

      const res = await importRows([{ name: shorter, partyType: 'Customer', openingBalance: '5000000' }]);

      expect(res).toMatchObject({ success: 1, failed: 0, errors: [] });
      expect(res.openings).toMatchObject([{ name: shorter, kind: 'AR', action: 'posted' }]);
      const budi = (await findParty(tx, shorter, 'Customer'))!;
      const cols = await columns(tx, budi.id);
      expect([money(cols.openingReceivable), money(cols.openingOutstanding), money(cols.receivableOutstanding), money(cols.outstandingAmount)])
        .toEqual(['5000000.00', '5000000.00', '5000000.00', '5000000.00']);
      expect(await partyLedger(tx, budi.id, 'AR')).toBe('5000000.00');
      const key = await tx.journalEntry.findMany({ where: { sourceKey: `OPENING:PARTY:${budi.id}:AR`, status: { not: 'Cancelled' } } });
      expect(key).toHaveLength(1);
      // The longer name keeps its own opening.
      expect(money((await columns(tx, santoso.id)).openingReceivable)).toBe('1000000.00');
      expect(await partyLedger(tx, santoso.id, 'AR')).toBe('1000000.00');
      const after = await rowCounts(tx);
      expect(after.je).toBeGreaterThanOrEqual(before.je);
    });
  });

  it('Both with Hutang 20 jt: AP +20 jt, AR unchanged', async () => {
    await inRollback(async (tx) => {
      const name = uniq('Sari');

      const res = await importRows([{ name, partyType: 'Both', openingBalance: '20000000', arahSaldo: 'Hutang' }]);

      expect(res.errors).toEqual([]);
      const sari = (await findParty(tx, name, 'Both'))!;
      const cols = await columns(tx, sari.id);
      expect([money(cols.openingPayable), money(cols.openingReceivable), money(cols.payableOutstanding), money(cols.receivableOutstanding)])
        .toEqual(['20000000.00', '0.00', '20000000.00', '0.00']);
      expect(await partyLedger(tx, sari.id, 'AP')).toBe('20000000.00');
      expect(await partyLedger(tx, sari.id, 'AR')).toBe('0.00');
    });
  });

  it('refuses a negative amount, a Both party without a direction and a wrong direction; no party is created', async () => {
    await inRollback(async (tx) => {
      const [a, b, c] = [uniq('Neg'), uniq('NoDir'), uniq('Wrong')];

      const res = await importRows([
        { name: a, partyType: 'Customer', openingBalance: '-5000000' },
        { name: b, partyType: 'Both', openingBalance: '5000000' },
        { name: c, partyType: 'Customer', openingBalance: '5000000', arahSaldo: 'Hutang' },
      ]);

      expect(res.success).toBe(0);
      expect(res.errors.map((e) => [e.row, e.code])).toEqual([[2, 'OPENING_NEGATIVE'], [3, 'PARTY_OPENING_DIRECTION'], [4, 'PARTY_OPENING_DIRECTION']]);
      expect(await tx.party.count({ where: { name: { in: [a, b, c] } } })).toBe(0);
    });
  });

  it('a party with transactions imported again from an old file keeps its outstanding and GL', async () => {
    await inRollback(async (tx, fy) => {
      const name = uniq('Bertransaksi');
      const c = await makeParty(tx, name, 'Customer');
      await setParty(tx, c.id, 'AR', 50 * JT);
      // A submitted payment is a transaction of the party (no ledger rows of its own in this fixture).
      const cash = await tx.account.findFirstOrThrow({ where: { accountNumber: { startsWith: '1.1.' }, isGroup: false } });
      await tx.payment.create({
        data: { paymentNumber: `PAY-IT2157-${tag()}`, date: new Date(`${Y}-03-01T05:00:00.000Z`), partyId: c.id, paymentType: 'Receive', accountId: cash.id, amount: 10 * JT, status: 'Submitted', fiscalYearId: fy.id, createdBy: actor.userId },
      });
      const colsBefore = await columns(tx, c.id);
      const glBefore = await partyLedger(tx, c.id, 'AR');
      const counts = await rowCounts(tx);

      // The old export wrote outstandingAmount (opening plus invoices) as the opening balance.
      const res = await importRows([{ name, partyType: 'Customer', outstandingAmount: String(60 * JT) }, { name, partyType: 'Customer', openingBalance: String(70 * JT) }]);

      expect(res.success).toBe(2);
      expect(res.errors).toMatchObject([{ row: 2, code: 'PARTY_OPENING_KEPT' }, { row: 3, code: 'PARTY_OPENING_KEPT' }]);
      expect(res.errors[0].message).toContain('saldo awal tidak diubah');
      expect(await columns(tx, c.id)).toEqual(colsBefore);
      expect(await partyLedger(tx, c.id, 'AR')).toBe(glBefore);
      expect(await rowCounts(tx)).toEqual(counts);
    });
  });

  it('a party without transactions: the same amount is unchanged, a new one needs the row confirmed and replaces', async () => {
    await inRollback(async (tx) => {
      const name = uniq('Ganti');
      const c = await makeParty(tx, name, 'Customer');
      await setParty(tx, c.id, 'AR', 5 * JT);
      const counts = await rowCounts(tx);

      const same = await importRows([{ name, partyType: 'Customer', openingBalance: '5000000' }]);
      expect(same.errors).toEqual([]);
      expect(same.openings).toEqual([]);
      expect(await rowCounts(tx)).toEqual(counts);

      const preview = await importRows([{ name, partyType: 'Customer', openingBalance: '7000000' }], { preview: 'true' });
      expect(preview.data?.[0]).toMatchObject({ rowNum: 2, opening: { action: 'replace', needsConfirm: true, recorded: '5000000.00' } });

      const refused = await importRows([{ name, partyType: 'Customer', openingBalance: '7000000' }]);
      expect(refused.errors).toMatchObject([{ row: 2, code: 'OPENING_REPLACE_UNCONFIRMED' }]);
      expect(money((await columns(tx, c.id)).openingReceivable)).toBe('5000000.00');
      expect(await rowCounts(tx)).toEqual(counts);

      // Another row's number does not confirm this one.
      const other = await importRows([{ name, partyType: 'Customer', openingBalance: '7000000' }], {}, { confirmReplace: ['9'] });
      expect(other.errors).toMatchObject([{ code: 'OPENING_REPLACE_UNCONFIRMED' }]);

      const done = await importRows([{ name, partyType: 'Customer', openingBalance: '7000000' }], {}, { confirmReplace: ['2'] });
      expect(done.errors).toEqual([]);
      expect(done.openings).toMatchObject([{ kind: 'AR', action: 'replaced' }]);
      const cols = await columns(tx, c.id);
      expect([money(cols.openingReceivable), money(cols.receivableOutstanding)]).toEqual(['7000000.00', '7000000.00']);
      expect(await partyLedger(tx, c.id, 'AR')).toBe('7000000.00');
      const journals = await tx.journalEntry.findMany({ where: { sourceKey: `OPENING:PARTY:${c.id}:AR` } });
      expect(journals.map((j) => j.status).sort()).toEqual(['Cancelled', 'Submitted']);
      const after = await rowCounts(tx);
      expect(after.je).toBeGreaterThan(counts.je);
      expect(after.ale).toBeGreaterThan(counts.ale);
    });
  });

  it('template export then import of the same rows posts no new journal; Both with two sides is two rows', async () => {
    await inRollback(async (tx) => {
      const [cust, supp, both] = [uniq('C'), uniq('S'), uniq('B')];
      await importRows([
        { name: cust, partyType: 'Customer', openingBalance: '5000000', customerDepositBalance: '300000' },
        { name: supp, partyType: 'Supplier', openingBalance: '2000000', depositBalance: '100000' },
        { name: both, partyType: 'Both', openingBalance: '9000000', arahSaldo: 'Piutang', depositBalance: '40000', customerDepositBalance: '50000' },
        { name: both, partyType: 'Both', openingBalance: '8000000', arahSaldo: 'Hutang' },
      ]);
      const bothParty = (await findParty(tx, both, 'Both'))!;
      const colsBoth = await columns(tx, bothParty.id);
      expect([money(colsBoth.openingReceivable), money(colsBoth.openingPayable), money(colsBoth.depositBalance), money(colsBoth.customerDepositBalance)])
        .toEqual(['9000000.00', '8000000.00', '40000.00', '50000.00']);

      const r = await callRoute(templateRouter, 'get', '/template/:type', { userId: actor.userId, role: actor.role, params: { type: 'parties' } });
      expect(r.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as ArrayBuffer);
      const sheet = wb.worksheets[0];
      const header = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
      expect(header).toContain('arahSaldo');
      // Only this test's parties: the database may hold others.
      const mine = new workbookRows(header, sheet, [cust, supp, both]);
      expect(mine.rows.filter((row) => row.name === both).map((row) => [row.arahSaldo, row.openingBalance])).toEqual([['Piutang', 9000000], ['Hutang', 8000000]]);
      expect(mine.rows.find((row) => row.name === cust)).toMatchObject({ openingBalance: 5000000, arahSaldo: 'Piutang', customerDepositBalance: 300000 });
      expect(mine.rows.find((row) => row.name === supp)).toMatchObject({ openingBalance: 2000000, arahSaldo: 'Hutang', depositBalance: 100000 });

      const counts = await rowCounts(tx);
      const again = await importRows(mine.asSheet());
      expect(again).toMatchObject({ success: 4, failed: 0, errors: [], openings: [] });
      expect(await rowCounts(tx)).toEqual(counts);
    });
  });

  it('a closed year refuses a new party with an opening and leaves no party behind', async () => {
    await inRollback(async (tx, fy) => {
      await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
      const name = uniq('Tertutup');
      const counts = await rowCounts(tx);

      const res = await importRows([{ name, partyType: 'Customer', openingBalance: '5000000' }]);

      expect(res.success).toBe(0);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].message).toContain(`Gagal insert "${name}"`);
      expect(res.errors[0].code).toBe(PERIOD_CLOSED);
      expect(await findParty(tx, name, 'Customer')).toBeNull();
      expect(await rowCounts(tx)).toEqual(counts);
    });
  });
});

/** The data rows of the exported party sheet for a few names, as objects and as import rows. */
class workbookRows {
  readonly rows: Array<Record<string, string | number>> = [];
  constructor(header: string[], sheet: ExcelJS.Worksheet, names: string[]) {
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const values = (row.values as unknown[]).slice(1);
      const obj = Object.fromEntries(header.map((h, i) => [h, (values[i] ?? '') as string | number]));
      if (names.includes(String(obj.name))) this.rows.push(obj);
    });
  }
  asSheet(): SheetRow[] {
    return this.rows.map((row) => Object.fromEntries(HEADERS.map((h) => [h, row[h] === undefined ? '' : String(row[h])])) as SheetRow);
  }
}
