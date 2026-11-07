/**
 * Integration test: the ledger row and party checks of /api/health-check (E2-R14, PR-5.1).
 *
 * Fixture year 2142 (unique to this file), open, and a closed copy where a case needs one; accounts,
 * parties and documents of its own. The checks read the whole database through the global prisma,
 * which the route harness points at the rollback transaction, so seed and dev data are visible too:
 * assertions look at the fixture's own rows (each check takes a scope of ids), and the GET case
 * compares counts with independent COUNT(*) queries instead of fixed numbers. Ledger rows are
 * written straight to the table and every group balances. Everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type DocumentStatus, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import healthCheckRouter from '../../routes/healthCheck';
import { checkAleSync, checkNonJournalAle, checkOrphanAle } from '../../routes/health/aleChecks';
import { checkPartyOutstandingDrift } from '../../routes/health/partyChecks';
import { runLedgerAudit } from '../../services/ledger/ledgerAudit';

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
const JT = 1_000_000;
const DAY = new Date('2142-05-20T03:00:00Z');

interface Books { fy: FiscalYear; userId: string; inventoryId: string; accruedId: string }

async function books(tx: Tx, isClosed = false): Promise<Books> {
  const account = async (name: string, rootType: 'ASSET' | 'LIABILITY') =>
    (await tx.account.create({ data: { name: `IT2142 ${name}`, accountNumber: `IT2142-${tag()}`, accountType: rootType, rootType } })).id;
  return {
    fy: await createFiscalYear(tx, { year: 2142, isClosed }),
    userId: (await createCapUser(tx, [])).userId,
    inventoryId: await account('Persediaan', 'ASSET'),
    accruedId: await account('Hutang belum ditagih', 'LIABILITY'),
  };
}

/** Two balanced ledger rows of `referenceType`/`referenceId`, debit `debitId`, credit `creditId`, of `partyId` (none by default). */
async function ledgerRows(
  tx: Tx,
  b: Books,
  ref: { type?: string; id: string },
  amount: number,
  opts: { debitId?: string; creditId?: string; cancelled?: boolean; partyId?: string } = {},
) {
  const row = {
    date: DAY, referenceType: ref.type ?? 'JournalEntry', referenceId: ref.id, fiscalYearId: b.fy.id,
    isCancelled: opts.cancelled ?? false, partyId: opts.partyId ?? null,
  };
  await tx.accountingLedgerEntry.createMany({
    data: [
      { ...row, accountId: opts.debitId ?? b.inventoryId, debit: amount, credit: 0 },
      { ...row, accountId: opts.creditId ?? b.accruedId, debit: 0, credit: amount },
    ],
  });
}

/** An STT-style journal DR Persediaan / CR Hutang belum ditagih (reverse swaps them), with its ledger rows. */
async function journal(
  tx: Tx,
  b: Books,
  opts: { number?: string; status?: DocumentStatus; amount?: number; reverse?: boolean; ledger?: 'active' | 'cancelled' | 'none' } = {},
) {
  const amount = opts.amount ?? 50 * JT;
  const [dr, cr] = opts.reverse ? [b.accruedId, b.inventoryId] : [b.inventoryId, b.accruedId];
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: opts.number ?? `JV-IT2142-${tag()}`,
      date: DAY,
      status: opts.status ?? 'Submitted',
      fiscalYearId: b.fy.id,
      createdBy: b.userId,
      items: { create: [{ accountId: dr, debit: amount, credit: 0 }, { accountId: cr, debit: 0, credit: amount }] },
    },
  });
  const ledger = opts.ledger ?? 'active';
  if (ledger !== 'none') await ledgerRows(tx, b, { id: je.id }, amount, { debitId: dr, creditId: cr, cancelled: ledger === 'cancelled' });
  return je;
}

const balanceOf = async (tx: Tx, accountId: string) => (await tx.account.findUniqueOrThrow({ where: { id: accountId } })).balance.toString();

d('ALE vs JournalItem Sync', () => {
  it('an STT of 50 jt cancelled the void way leaves no finding and changes no balance', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const stt = await journal(tx, b, { number: `JV-STT-IT2142-${tag()}` });
      await tx.journalEntry.update({ where: { id: stt.id }, data: { status: 'Cancelled' } });
      await tx.accountingLedgerEntry.updateMany({ where: { referenceId: stt.id }, data: { isCancelled: true } });
      const before = await balanceOf(tx, b.inventoryId);
      const res = await checkAleSync({ journalIds: [stt.id] });
      expect(res).toMatchObject({ status: 'ok', count: 0, details: [], fixable: false });
      expect(await balanceOf(tx, b.inventoryId)).toBe(before);
    });
  });

  it('an old-way cancel pair alone is a warning in an open year, an error next to another cause', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const stt = await journal(tx, b, { number: `JV-STT-IT2142-${tag()}`, status: 'Cancelled' });
      const cxl = await journal(tx, b, { number: `${stt.entryNumber}-CXL`, reverse: true });
      const pairOnly = await checkAleSync({ journalIds: [stt.id, cxl.id] });
      expect(pairOnly).toMatchObject({ status: 'warning', count: 1, fixable: false });
      expect(pairOnly.details).toEqual([
        expect.objectContaining({ journal_number: stt.entryNumber, date: '2142-05-20', cause: 'legacy-stt-pair', difference: 100 * JT, closed_year: false }),
      ]);

      const broken = await journal(tx, b, { status: 'Cancelled', amount: JT });
      const mixed = await checkAleSync({ journalIds: [stt.id, cxl.id, broken.id] });
      expect(mixed).toMatchObject({ status: 'error', count: 2 });
      expect(mixed.details!.map((r) => (r as { cause: string }).cause)).toEqual(['legacy-stt-pair', 'cancelled-active-ale']);
    });
  });

  it('an old-way cancel pair in a closed year is an error', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx, true);
      const stt = await journal(tx, b, { number: `JV-STT-IT2142-${tag()}`, status: 'Cancelled' });
      const cxl = await journal(tx, b, { number: `${stt.entryNumber}-CXL`, reverse: true });
      const res = await checkAleSync({ journalIds: [stt.id, cxl.id] });
      expect(res).toMatchObject({ status: 'error', count: 1 });
      expect(res.details![0]).toMatchObject({ cause: 'legacy-stt-pair', closed_year: true, fiscal_year: b.fy.name });
    });
  });
});

d('Orphan ALE Entries and Non-Journal Ledger Entries', () => {
  it('lists the ledger rows of a missing journal with their year', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const goneId = randomUUID();
      await ledgerRows(tx, b, { id: goneId }, 7 * JT);
      const res = await checkOrphanAle({ referenceIds: [goneId] });
      expect(res).toMatchObject({ status: 'warning', count: 2, fixable: false });
      expect(res.details).toEqual([
        expect.objectContaining({ reference_id: goneId, fiscal_year: b.fy.name, closed_year: false }),
        expect.objectContaining({ reference_id: goneId, fiscal_year: b.fy.name, closed_year: false }),
      ]);
      expect(await checkOrphanAle({ referenceIds: [] })).toMatchObject({ status: 'ok', count: 0 });
    });
  });

  it('finds ledger rows booked to a Sales Invoice, and flags the one also booked through its journal', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const party = await tx.party.create({ data: { name: `IT2142 Customer ${tag()}`, partyType: 'Customer' } });
      const invoice = (n: string) => tx.salesInvoice.create({
        data: { invoiceNumber: n, date: DAY, partyId: party.id, grandTotal: 3 * JT, outstanding: 0, fiscalYearId: b.fy.id, createdBy: b.userId, status: 'Submitted' },
      });
      const linked = await invoice(`SI-IT2142-${tag()}`);
      const alone = await invoice(`SI-IT2142-${tag()}`);
      const elsewhere = await invoice(`SI-IT2142-${tag()}`);
      const otherYear = { ...b, fy: await createFiscalYear(tx, { year: 2142 }) };
      const thirdId = (await tx.account.create({ data: { name: 'IT2142 Lain', accountNumber: `IT2142-${tag()}`, accountType: 'LIABILITY', rootType: 'LIABILITY' } })).id;
      const [twin, partial, ofParty] = [randomUUID(), randomUUID(), randomUUID()];
      // linked: its journal JV-<number> exists in the same year; elsewhere: its JV-<number> is in another
      // year; alone: neither. twin: no document, every row matches a journal's row; partial: only one row
      // does (an unrelated journal of the same amount on the same day); ofParty: same rows as a journal
      // but booked to a party the journal's rows do not have.
      await journal(tx, b, { number: `JV-${linked.invoiceNumber}`, amount: 3 * JT });
      await ledgerRows(tx, b, { type: 'SalesInvoice', id: linked.id }, 3 * JT, { debitId: b.accruedId, creditId: b.inventoryId });
      await ledgerRows(tx, b, { type: 'SalesInvoice', id: alone.id }, 2 * JT, { debitId: b.accruedId, creditId: b.inventoryId });
      await journal(tx, otherYear, { number: `JV-${elsewhere.invoiceNumber}`, amount: 5 * JT });
      await ledgerRows(tx, b, { type: 'SalesInvoice', id: elsewhere.id }, 5 * JT, { debitId: b.accruedId, creditId: b.inventoryId });
      await journal(tx, b, { amount: 11 * JT });
      await ledgerRows(tx, b, { type: 'Payment', id: twin }, 11 * JT);
      await journal(tx, { ...b, accruedId: thirdId }, { amount: 13 * JT });
      await ledgerRows(tx, b, { type: 'Payment', id: partial }, 13 * JT);
      await journal(tx, b, { amount: 17 * JT });
      await ledgerRows(tx, b, { type: 'Payment', id: ofParty }, 17 * JT, { partyId: party.id });

      const res = await checkNonJournalAle({ referenceIds: [linked.id, alone.id, elsewhere.id, twin, partial, ofParty] });
      expect(res).toMatchObject({ name: 'Non-Journal Ledger Entries', status: 'warning', count: 6, fixable: false });
      expect(res.details).toEqual([
        { reference_type: 'Payment', documents: 3, entries: 6, debit: 41 * JT, duplicated_documents: 0, possibly_duplicated_documents: 1 },
        { reference_type: 'SalesInvoice', documents: 3, entries: 6, debit: 10 * JT, duplicated_documents: 1, possibly_duplicated_documents: 0 },
      ]);

      // The ledger audit lists the same groups, one per document, with the reason; only `linked` is a
      // duplicate (the year close blocks on it), the others are report only.
      const audit = await runLedgerAudit(tx, { only: ['nonJournalAle'], fiscalYearId: b.fy.id });
      const rows = audit.sections[0]!.rows;
      expect(rows.map((r) => [r.label, r.cause, r.amount, r.gate])).toEqual([
        [ofParty, 'document-only', '17000000.00', false],
        [partial, 'document-only', '13000000.00', false],
        [twin, 'twin-rows-only', '11000000.00', false],
        [elsewhere.invoiceNumber, 'document-only', '5000000.00', false],
        [linked.invoiceNumber, 'also-in-journal', '3000000.00', false],
        [alone.invoiceNumber, 'document-only', '2000000.00', false],
      ]);
      expect(rows[4]!.detail).toContain(`journal JV-${linked.invoiceNumber}`);
      expect(rows[3]!.detail).not.toContain('journal JV-');
      expect(rows[2]!.detail).toContain('2 row(s) with a twin journal ledger row');
      expect(rows[1]!.detail).toContain('1 row(s) with a twin journal ledger row');
      expect(rows[0]!.detail).not.toContain('twin');
    });
  });
});

d('Party Outstanding Drift', () => {
  it('flags a party whose stored outstanding differs from its calculation', async () => {
    await inRollback(async (tx) => {
      const drifted = await tx.party.create({ data: { name: `IT2142 Drift ${tag()}`, partyType: 'Customer', outstandingAmount: 500_000 } });
      const fine = await tx.party.create({ data: { name: `IT2142 Fine ${tag()}`, partyType: 'Supplier', outstandingAmount: 250_000, openingOutstanding: 250_000 } });
      const res = await checkPartyOutstandingDrift({ partyIds: [drifted.id, fine.id] });
      expect(res).toMatchObject({ name: 'Party Outstanding Drift', status: 'warning', count: 1, fixable: false });
      expect(res.details).toEqual([{ party_name: drifted.name, party_type: 'Customer', stored: 500_000, expected: 0, difference: 500_000 }]);
      expect(await checkPartyOutstandingDrift({ partyIds: [fine.id] })).toMatchObject({ status: 'ok', count: 0 });
    });
  });

  it('an account in two party roles is this check\'s error; GET still answers with every check', async () => {
    await inRollback(async (tx) => {
      const shared = await tx.account.create({
        data: { name: 'IT2142 Hutang ganda', accountNumber: `IT2142-${tag()}`, accountType: 'LIABILITY', rootType: 'LIABILITY' },
      });
      await tx.systemAccountMapping.createMany({ data: [{ role: 'AP', accountId: shared.id }, { role: 'VENDOR_DEPOSIT', accountId: shared.id }] });
      const res = await checkPartyOutstandingDrift();
      expect(res).toMatchObject({ name: 'Party Outstanding Drift', status: 'error', count: 1, details: [], fixable: false });
      expect(res.message).toContain(shared.accountNumber);

      const route = await callRoute(healthCheckRouter, 'get', '/', await createCapUser(tx, []));
      expect(route.status, JSON.stringify(route.body)).toBe(200);
      const checks = route.body.data.checks as Array<{ name: string; status: string }>;
      expect(checks.find((c) => c.name === 'Party Outstanding Drift')).toMatchObject({ status: 'error' });
    });
  });
});

d('GET /api/health-check', () => {
  it('runs the new checks and counts every finding, not only the listed ones', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      // A large amount so the journal is among the 20 listed whatever else the database holds.
      const noLedger = await journal(tx, b, { amount: 4_000_000_000_000, ledger: 'none' });
      await ledgerRows(tx, b, { id: randomUUID() }, JT);
      const user = await createCapUser(tx, []);
      const res = await callRoute(healthCheckRouter, 'get', '/', user);
      expect(res.status).toBe(200);
      type Check = { name: string; status: string; count: number; details: Array<Record<string, unknown>> };
      const checks = res.body.data.checks as Check[];
      const byName = (name: string) => {
        const c = checks.find((x) => x.name === name);
        if (!c) throw new Error(`${name} missing from ${checks.map((x) => x.name).join(', ')}`);
        return c;
      };
      expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(['Non-Journal Ledger Entries', 'Party Outstanding Drift']));

      const sync = byName('ALE vs JournalItem Sync');
      expect(sync.status).toBe('error');
      // Independent of the check's query: lines of Submitted journals minus active ledger rows, netted
      // per journal and account; a journal with any account left over is one finding.
      const [syncCount] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(DISTINCT journal_id) AS n FROM (
          SELECT journal_id FROM (
            SELECT jea.journal_entry_id AS journal_id, jea.account_id, jea.debit, jea.credit
              FROM journal_entry_accounts jea
              JOIN journal_entries je ON je.id = jea.journal_entry_id AND je.status = 'Submitted'
            UNION ALL
            SELECT ale.reference_id, ale.account_id, -ale.debit, -ale.credit
              FROM accounting_ledger_entries ale
             WHERE ale.reference_type = 'JournalEntry' AND ale.is_cancelled = false) x
           GROUP BY journal_id, account_id
          HAVING SUM(debit) <> 0 OR SUM(credit) <> 0) t`;
      expect(sync.count).toBe(Number(syncCount!.n));
      expect(sync.details[0]).toMatchObject({ journal_number: noLedger.entryNumber, cause: 'no-ledger' });
      expect(sync.details.length).toBeLessThanOrEqual(20);

      const [orphanCount] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM accounting_ledger_entries ale
         WHERE ale.is_cancelled = false
           AND ((ale.reference_type = 'JournalEntry' AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = ale.reference_id))
             OR (ale.reference_type = 'StockMovement' AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.id = ale.reference_id))
             OR (ale.reference_type = 'StockOpname' AND NOT EXISTS (SELECT 1 FROM stock_opnames so WHERE so.id = ale.reference_id)))`;
      expect(byName('Orphan ALE Entries').count).toBe(Number(orphanCount!.n));

      const [unbalancedCount] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM (
          SELECT je.id FROM journal_entries je JOIN journal_entry_accounts jea ON jea.journal_entry_id = je.id
           WHERE je.status = 'Submitted' GROUP BY je.id HAVING ABS(SUM(jea.debit) - SUM(jea.credit)) > 0.01) t`;
      expect(byName('Unbalanced Journal Entries').count).toBe(Number(unbalancedCount!.n));

      const [docCount] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM (
          SELECT DISTINCT reference_type, reference_id, fiscal_year_id FROM accounting_ledger_entries
           WHERE is_cancelled = false AND reference_type <> 'JournalEntry') t`;
      expect(byName('Non-Journal Ledger Entries').count).toBe(Number(docCount!.n));
    });
  });
});
