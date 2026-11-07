/**
 * Integration test: core of scripts/repair/e2-opening-balance-audit.ts
 * (services/ledger/openingBalanceAudit.ts, plan step 5 PR-5.6).
 *
 * Fixture year 2149 (this file's only year, plan §6.3), cut-over 2149-01-01. Every journal is
 * written the way the legacy writers did (journal, lines, balanced ledger rows) inside a rollback
 * transaction; assertions only look at this file's journals, since the database may hold others.
 * - The plan finds an OB- journal with source_type NULL, a typed OPENING journal and a payment-screen
 *   deposit opening, and classes them: single-two-line-opening, patch-delta (a PATCH in March on an
 *   account with January activity), multi (two openings of one account), multi-line, refused-account
 *   (a revenue account), deposit-legacy.
 * - "Setoran modal awal" against OPENING_EQUITY is listed among the non-opening equity counters.
 * - A party whose opening_outstanding differs from its opening journal is listed.
 * - The dry run writes nothing; --apply keys the single-two-line-opening rows only, with one audit
 *   row each naming the accountant; --key-journal keys a named patch-delta journal; a named journal
 *   with several targets, or two journals of one target, refuse the run and nothing is keyed.
 * - Duplicate active RECURRING keys are found (exit 1 of the script), and are gone once one is cancelled.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type FiscalYear, type JournalSourceType, type DocumentStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import {
  applyOpeningKeys,
  findActiveDuplicateKeys,
  OpeningAuditRefusal,
  OPENING_KEY_AUDIT_ACTION,
  planOpeningBalanceAudit,
  type OpeningAuditReport,
} from '../../services/ledger/openingBalanceAudit';

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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2149;
const CUTOVER = `${Y}-01-01`;
const opts = { cutoverDay: CUTOVER };
const tag = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

interface Line { accountId: string; debit?: number; credit?: number; partyId?: string }
interface JournalSpec {
  number?: string;
  day: string;
  narration: string;
  sourceType?: JournalSourceType | null;
  sourceKey?: string | null;
  status?: DocumentStatus;
  lines: Line[];
}

interface Books {
  fy: FiscalYear;
  userId: string;
  equityId: string;
  arId: string;
  vendorDepositId: string;
  account: (rootType?: 'ASSET' | 'REVENUE') => Promise<string>;
  journal: (spec: JournalSpec) => Promise<{ id: string; entryNumber: string }>;
}

async function roleAccount(tx: Tx, role: string): Promise<string> {
  const m = await tx.systemAccountMapping.findFirst({ where: { role }, orderBy: { sortOrder: 'asc' }, select: { accountId: true } });
  if (!m) throw new Error(`${role} is not mapped (seed).`);
  return m.accountId;
}

async function books(tx: Tx): Promise<Books> {
  const fy = await createFiscalYear(tx, { year: Y });
  const { userId } = await createCapUser(tx, []);
  return {
    fy,
    userId,
    equityId: await roleAccount(tx, 'OPENING_EQUITY'),
    arId: await roleAccount(tx, 'AR'),
    vendorDepositId: await roleAccount(tx, 'VENDOR_DEPOSIT'),
    account: async (rootType = 'ASSET') => (await tx.account.create({
      data: { name: `IT-OBA ${rootType}`, accountNumber: `IT-OBA-${tag()}`, accountType: rootType, rootType },
    })).id,
    // A legacy-style journal: lines and balanced ledger rows, written directly.
    journal: async (spec) => {
      const date = new Date(`${spec.day}T03:00:00.000Z`);
      const status = spec.status ?? 'Submitted';
      const j = await tx.journalEntry.create({
        data: {
          entryNumber: spec.number ?? `JV-OBA-${tag()}`,
          date,
          narration: spec.narration,
          status,
          fiscalYearId: fy.id,
          createdBy: userId,
          sourceType: spec.sourceType ?? null,
          sourceKey: spec.sourceKey ?? null,
          items: { create: spec.lines.map((l) => ({ accountId: l.accountId, partyId: l.partyId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0 })) },
        },
      });
      if (status === 'Submitted') {
        await tx.accountingLedgerEntry.createMany({
          data: spec.lines.map((l) => ({
            date, accountId: l.accountId, partyId: l.partyId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0,
            referenceType: 'JournalEntry', referenceId: j.id, fiscalYearId: fy.id,
          })),
        });
      }
      return { id: j.id, entryNumber: j.entryNumber };
    },
  };
}

const opening = (b: Books, accountId: string, amount: number, day = CUTOVER, extra: Partial<JournalSpec> = {}) =>
  b.journal({ day, narration: 'Saldo awal akun: IT - OBA', sourceType: 'OPENING', lines: [{ accountId, debit: amount }, { accountId: b.equityId, credit: amount }], ...extra });

interface Fixture {
  single: { id: string; entryNumber: string; accountId: string };
  patch: { id: string; entryNumber: string; accountId: string };
  multi: { id: string; entryNumber: string }[];
  multiLine: { id: string; entryNumber: string };
  revenue: { id: string; entryNumber: string };
  deposit: { id: string; entryNumber: string; partyId: string };
  partyAr: { id: string; entryNumber: string; partyId: string };
  modal: { id: string; accountId: string };
}

async function fixture(tx: Tx, b: Books): Promise<Fixture> {
  const singleAccount = await b.account();
  const single = await opening(b, singleAccount, 1_000_000, CUTOVER, { number: `OB-${Y}01-${tag()}`, sourceType: null, narration: 'Saldo Awal: IT - OBA' });

  // PATCH /coa/:id/balance in March on an account with January activity: a delta, not an opening.
  const patchAccount = await b.account();
  const other = await b.account();
  await b.journal({ day: `${Y}-01-10`, narration: 'Penjualan tunai', lines: [{ accountId: patchAccount, debit: 300_000 }, { accountId: other, credit: 300_000 }] });
  const patch = await opening(b, patchAccount, 200_000, `${Y}-03-05`, { number: `OB-${Y}03-${tag()}`, narration: 'Saldo Awal: IT - OBA' });

  const multiAccount = await b.account();
  const multi = [await opening(b, multiAccount, 100_000), await opening(b, multiAccount, 50_000, `${Y}-02-01`)];

  const lineA = await b.account();
  const lineB = await b.account();
  const multiLine = await b.journal({
    day: CUTOVER, narration: 'Saldo awal akun: gabungan', sourceType: 'OPENING',
    lines: [{ accountId: lineA, debit: 400_000 }, { accountId: lineB, debit: 100_000 }, { accountId: b.equityId, credit: 500_000 }],
  });

  const revenue = await opening(b, await b.account('REVENUE'), 75_000);

  const supplier = await tx.party.create({ data: { name: `IT-OBA Supplier ${tag()}`, partyType: 'Supplier' } });
  const deposit = await b.journal({
    number: `JV-PAY-OBA-${tag()}`, day: `${Y}-02-15`, narration: `Saldo Awal Uang Muka Vendor: PAY-OBA - ${supplier.name}`,
    lines: [{ accountId: b.vendorDepositId, partyId: supplier.id, debit: 250_000 }, { accountId: b.equityId, credit: 250_000 }],
  });

  const customer = await tx.party.create({ data: { name: `IT-OBA Customer ${tag()}`, partyType: 'Customer', openingOutstanding: 500_000 } });
  const partyAr = await b.journal({
    day: CUTOVER, narration: `Saldo awal piutang: ${customer.name}`, sourceType: 'OPENING',
    lines: [{ accountId: b.arId, partyId: customer.id, debit: 300_000 }, { accountId: b.equityId, credit: 300_000 }],
  });

  const bank = await b.account();
  const modal = await b.journal({ day: CUTOVER, narration: 'Setoran modal awal', lines: [{ accountId: bank, debit: 5_000_000 }, { accountId: b.equityId, credit: 5_000_000 }] });

  return {
    single: { ...single, accountId: singleAccount },
    patch: { ...patch, accountId: patchAccount },
    multi,
    multiLine,
    revenue,
    deposit: { ...deposit, partyId: supplier.id },
    partyAr: { ...partyAr, partyId: customer.id },
    modal: { id: modal.id, accountId: bank },
  };
}

const rowsOf = (report: OpeningAuditReport, journalId: string) => report.openings.filter((r) => r.journalId === journalId);
const classOf = (report: OpeningAuditReport, journalId: string) => rowsOf(report, journalId).map((r) => r.cls);
const keyOf = async (tx: Tx, id: string) => (await tx.journalEntry.findUniqueOrThrow({ where: { id }, select: { sourceKey: true, sourceType: true } }));
const auditRows = (tx: Tx, ids: string[]) => tx.auditLog.findMany({ where: { action: OPENING_KEY_AUDIT_ACTION, entityId: { in: ids } } });

d('legacy opening-balance audit (E2-R11 migration, PR-5.6)', () => {
  it('lists and classes the legacy opening journals, the equity counters and the party difference', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const f = await fixture(tx, b);
      const report = await planOpeningBalanceAudit(tx, opts);

      expect(report.cutoverDay).toBe(CUTOVER);
      const [single] = rowsOf(report, f.single.id);
      expect(single).toMatchObject({
        cls: 'single-two-line-opening', detection: 'classifier', sourceType: null, twoLine: true, priorActivity: false,
        afterCutover: false, target: { kind: 'ACCOUNT', accountId: f.single.accountId }, proposedKey: `OPENING:ACCOUNT:${f.single.accountId}`,
      });
      expect(single!.amount.toFixed(2)).toBe('1000000.00');

      expect(rowsOf(report, f.patch.id)[0]).toMatchObject({ cls: 'patch-delta', priorActivity: true, afterCutover: true, detection: 'source-type' });
      expect(f.multi.map((j) => classOf(report, j.id))).toEqual([['multi'], ['multi']]);
      expect(rowsOf(report, f.multi[0]!.id)[0]!.openingsForTarget).toBe(2);
      expect(classOf(report, f.multiLine.id)).toEqual(['multi-line', 'multi-line']);
      expect(rowsOf(report, f.revenue.id)[0]).toMatchObject({ cls: 'refused-account', ruleProblem: 'ACCOUNT_ROOT_TYPE' });
      expect(rowsOf(report, f.deposit.id)[0]).toMatchObject({
        cls: 'deposit-legacy', detection: 'deposit-narration', target: { kind: 'PARTY', partyId: f.deposit.partyId, subledger: 'VDEP' },
      });
      expect(rowsOf(report, f.partyAr.id)[0]).toMatchObject({
        cls: 'single-two-line-opening', target: { kind: 'PARTY', partyId: f.partyAr.partyId, subledger: 'AR' },
        proposedKey: `OPENING:PARTY:${f.partyAr.partyId}:AR`,
      });

      // "Setoran modal awal" is an opening recorded another way: not a legacy opening, but listed.
      expect(rowsOf(report, f.modal.id)).toEqual([]);
      const counter = report.equityCounters.filter((r) => r.journalId === f.modal.id);
      expect(counter).toHaveLength(1);
      expect(counter[0]).toMatchObject({ accountId: f.modal.accountId, nearCutover: true });
      expect(counter[0]!.amount.toFixed(2)).toBe('5000000.00');

      const party = report.parties.find((p) => p.partyId === f.partyAr.partyId);
      expect(party && [party.openingOutstanding.toFixed(2), party.fromJournals.toFixed(2), party.difference.toFixed(2)]).toEqual(['500000.00', '300000.00', '200000.00']);
    });
  });

  it('the dry run writes nothing; --apply keys only single-two-line-opening, with one audit row each', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const f = await fixture(tx, b);
      const own = [f.single.id, f.patch.id, ...f.multi.map((j) => j.id), f.multiLine.id, f.revenue.id, f.deposit.id, f.partyAr.id];

      const dry = await applyOpeningKeys(tx, { ...opts, approvedBy: null, write: false });
      expect(dry.keyed.map((k) => k.journalId)).toEqual(expect.arrayContaining([f.single.id, f.partyAr.id]));
      for (const id of own) expect((await keyOf(tx, id)).sourceKey).toBeNull();
      expect(await auditRows(tx, own)).toHaveLength(0);

      await expect(applyOpeningKeys(tx, { ...opts, approvedBy: '  ', write: true })).rejects.toThrow('--approved-by');

      const applied = await applyOpeningKeys(tx, { ...opts, approvedBy: 'Bu Sari', write: true });
      const keyedOwn = applied.keyed.filter((k) => own.includes(k.journalId)).map((k) => k.journalId).sort();
      expect(keyedOwn).toEqual([f.single.id, f.partyAr.id].sort());
      expect(await keyOf(tx, f.single.id)).toEqual({ sourceKey: `OPENING:ACCOUNT:${f.single.accountId}`, sourceType: 'OPENING' });
      expect(await keyOf(tx, f.partyAr.id)).toEqual({ sourceKey: `OPENING:PARTY:${f.partyAr.partyId}:AR`, sourceType: 'OPENING' });
      for (const id of [f.patch.id, ...f.multi.map((j) => j.id), f.multiLine.id, f.revenue.id, f.deposit.id]) {
        expect((await keyOf(tx, id)).sourceKey).toBeNull();
      }

      const audits = await auditRows(tx, own);
      expect(audits.map((a) => a.entityId).sort()).toEqual([f.single.id, f.partyAr.id].sort());
      expect(audits.every((a) => a.via === 'repair')).toBe(true);
      expect(audits.find((a) => a.entityId === f.single.id)).toMatchObject({
        oldValues: { sourceType: null, sourceKey: null },
        viaMeta: { script: 'e2-opening-balance-audit', approvedBy: 'Bu Sari' },
      });

      // Keyed journals are no longer legacy openings; the ledger is untouched.
      const after = await planOpeningBalanceAudit(tx, opts);
      expect(rowsOf(after, f.single.id)).toEqual([]);
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceId: f.single.id } });
      expect(ale.map((r) => [Number(r.debit), Number(r.credit), r.isCancelled]).sort()).toEqual([[0, 1_000_000, false], [1_000_000, 0, false]]);
    });
  });

  it('--key-journal keys a named patch-delta journal; a several-target or same-key choice refuses the run', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const f = await fixture(tx, b);

      await expect(applyOpeningKeys(tx, { ...opts, approvedBy: 'Bu Sari', keyJournals: [f.multiLine.entryNumber], write: true }))
        .rejects.toBeInstanceOf(OpeningAuditRefusal);
      await expect(applyOpeningKeys(tx, { ...opts, approvedBy: 'Bu Sari', keyJournals: f.multi.map((j) => j.entryNumber), write: true }))
        .rejects.toThrow(/another active journal holds/);
      await expect(applyOpeningKeys(tx, { ...opts, approvedBy: 'Bu Sari', keyJournals: ['JV-OBA-NOPE'], write: true }))
        .rejects.toThrow(/not an active opening journal/);
      // Refused runs wrote nothing, not even the automatic keys.
      expect((await keyOf(tx, f.single.id)).sourceKey).toBeNull();

      const applied = await applyOpeningKeys(tx, { ...opts, approvedBy: 'Bu Sari', keyJournals: [f.patch.entryNumber, f.multi[0]!.entryNumber], write: true });
      expect(applied.keyed.find((k) => k.journalId === f.patch.id)).toMatchObject({ explicit: true, cls: 'patch-delta' });
      expect(await keyOf(tx, f.patch.id)).toEqual({ sourceKey: `OPENING:ACCOUNT:${f.patch.accountId}`, sourceType: 'OPENING' });
      expect((await keyOf(tx, f.multi[0]!.id)).sourceKey).toMatch(/^OPENING:ACCOUNT:/);
      expect((await keyOf(tx, f.multi[1]!.id)).sourceKey).toBeNull();

      // The other opening of that account is now "multi" against a keyed one and cannot take its key.
      const after = await planOpeningBalanceAudit(tx, opts);
      expect(rowsOf(after, f.multi[1]!.id)[0]).toMatchObject({ cls: 'multi', keyedActive: true });
      await expect(applyOpeningKeys(tx, { ...opts, approvedBy: 'Bu Sari', keyJournals: [f.multi[1]!.entryNumber], write: true }))
        .rejects.toThrow(/another active journal holds/);
      const multiKey = (await keyOf(tx, f.multi[0]!.id)).sourceKey;
      expect((await findActiveDuplicateKeys(tx)).some((r) => r.sourceKey === multiKey)).toBe(false);
    });
  });

  it('finds duplicate active RECURRING keys (the script exits 1), and not once one is cancelled', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const cash = await b.account();
      const expense = await b.account();
      const key = `RECURRING:${tag()}:${Y}-03-10`;
      const run = (status?: DocumentStatus) => b.journal({
        day: `${Y}-03-10`, narration: 'Sewa', sourceType: 'RECURRING', sourceKey: key, status,
        lines: [{ accountId: expense, debit: 10 }, { accountId: cash, credit: 10 }],
      });
      const first = await run();
      const second = await run();

      const dup = (await findActiveDuplicateKeys(tx)).find((r) => r.sourceKey === key);
      expect(dup).toMatchObject({ sourceType: 'RECURRING', entryNumbers: [first.entryNumber, second.entryNumber].sort() });
      expect((await planOpeningBalanceAudit(tx, opts)).duplicates.some((r) => r.sourceKey === key)).toBe(true);

      await tx.journalEntry.update({ where: { id: second.id }, data: { status: 'Cancelled' } });
      await tx.accountingLedgerEntry.updateMany({ where: { referenceId: second.id }, data: { isCancelled: true } });
      expect((await findActiveDuplicateKeys(tx)).some((r) => r.sourceKey === key)).toBe(false);
    });
  });
});
