/**
 * Moving a balance-sheet system account role with its balance (E2-R8, PR-4.12) against a real database.
 *
 * - AR on an account holding 500 jt from two Customers' invoices: moving it without transferBalance
 *   is refused (ACCOUNT_HAS_BALANCE) and nothing changes; with it, one SYSTEM_DOC reclass journal
 *   (sourceKey REMAP:AR:<from>:<to>:<day>) empties the old account per Customer, the new one holds
 *   500 jt, the receivable check stays green and the parties' outstanding is untouched.
 * - Voiding one of those old invoices afterwards lands on the old account: the receivable check
 *   stays green (the old account is a former AR account), the former-account check reports the
 *   residue and the sweep moves it, leaving the old account at 0.
 * - An old AR group account with ledger rows can be emptied (REMAP_SOURCE_RULE); a group target is
 *   refused. Saving another role next to an unchanged AR does not check AR's balance. A closed
 *   current year refuses the transfer and keeps the mapping.
 *
 * Everything runs in a rollback transaction on fixtures made here, in fiscal year 2162, with the
 * Date clock inside it (the reclass is dated the current business day).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { cancelSalesInvoiceInTx } from '../../services/invoiceCancellation';
import { findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { findFormerResidues } from '../../services/systemAccountRemap';
import { checkFormerRoleAccounts } from '../../routes/health/formerRoleAccountChecks';
import router from '../../routes/systemAccounts';

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
  vi.useRealTimers();
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
      systemAccounts.invalidateCache();
      try {
        await fn(tx);
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
        vi.useRealTimers();
      }
      throw new RollbackSentinel();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2162;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Only the Date clock moves: the reclass is dated today, which must fall in fiscal year 2162. */
function clockAt(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

async function account(tx: Tx, label: string, over: Record<string, unknown> = {}) {
  return tx.account.create({
    data: { name: `IT-RM ${label}`, accountNumber: `IT-RM-${tag()}`, accountType: 'ASSET', rootType: 'ASSET', ...over },
  });
}

async function mapRole(tx: Tx, role: string, accountId: string) {
  await tx.systemAccountMapping.deleteMany({ where: { role } });
  await tx.systemAccountMapping.create({ data: { role, accountId } });
  systemAccounts.invalidateCache();
}

/** Net ledger (debit − credit) of an account, per party when partyId is given. */
async function net(tx: Tx, accountId: string, partyId?: string): Promise<number> {
  const agg = await tx.accountingLedgerEntry.aggregate({
    where: { accountId, isCancelled: false, ...(partyId ? { partyId } : {}) },
    _sum: { debit: true, credit: true },
  });
  return Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
}

/** A balanced journal written straight to the ledger (legacy data the reclass has to move). */
async function rawJournal(tx: Tx, fy: FiscalYear, userId: string, date: Date, lines: Array<{ accountId: string; partyId?: string; debit?: number; credit?: number }>) {
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-RM-${tag()}`, date, status: 'Submitted', fiscalYearId: fy.id, createdBy: userId, sourceType: 'MANUAL',
      items: { create: lines.map((l) => ({ accountId: l.accountId, partyId: l.partyId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0 })) },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: lines.map((l) => ({
      date, accountId: l.accountId, partyId: l.partyId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0,
      referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: fy.id,
    })),
  });
  return je;
}

async function fixture(tx: Tx, opts: { closed?: boolean } = {}) {
  const fy = await createFiscalYear(tx, { year: Y, isClosed: opts.closed });
  const { userId } = await createCapUser(tx, []);
  const oldAr = await account(tx, 'Piutang lama');
  const newAr = await account(tx, 'Piutang baru');
  await mapRole(tx, 'AR', oldAr.id);
  const customer = async () => (await tx.party.create({
    data: { name: `IT-RM Customer ${tag()}`, partyType: 'Customer', isActive: true, openingOutstanding: 0, outstandingAmount: 0 },
  })).id;
  return { fy, userId, oldAr, newAr, p1: await customer(), p2: await customer() };
}

const put = (userId: string, body: unknown) => callRoute(router, 'put', '/', { body, userId, role: 'Admin' });

d('system account remap with balance-sheet reclass (PR-4.12)', () => {
  it('moves AR with its 500 jt per Customer, then a voided old invoice is swept off the old account', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-06-15T10:00:00+07:00`);
      const f = await fixture(tx);
      const invoice = (partyId: string, rate: number) => submitSalesInvoiceInTx(
        tx,
        { date: `${Y}-03-01`, partyId, items: [{ itemName: 'IT-RM jasa', itemType: 'service', quantity: 1, rate }] },
        f.userId,
      );
      const inv1 = await invoice(f.p1, 300 * JT);
      await invoice(f.p2, 200 * JT);
      expect(await net(tx, f.oldAr.id)).toBe(500 * JT);

      // Without transferBalance: refused with the balance, nothing changes.
      const refused = await put(f.userId, { mappings: [{ role: 'AR', accountId: f.newAr.id }] });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('ACCOUNT_HAS_BALANCE');
      expect(refused.body.balances).toEqual([expect.objectContaining({ role: 'AR', fromAccountId: f.oldAr.id, toAccountId: f.newAr.id, amount: '500000000.00', partyCount: 2 })]);
      expect((await tx.systemAccountMapping.findFirst({ where: { role: 'AR' } }))!.accountId).toBe(f.oldAr.id);

      // With it: one reclass journal, old account empty per Customer, new one holds the 500 jt.
      const ok = await put(f.userId, { mappings: [{ role: 'AR', accountId: f.newAr.id }], transferBalance: true, reason: 'Pindah ke akun piutang baru' });
      expect(ok.status).toBe(200);
      expect(ok.body.transfers).toHaveLength(1);
      expect(ok.body.transfers[0]).toMatchObject({ role: 'AR', amount: '500000000.00', partyCount: 2 });
      expect((await tx.systemAccountMapping.findFirst({ where: { role: 'AR' } }))!.accountId).toBe(f.newAr.id);

      const reclass = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber: ok.body.transfers[0].journalNumbers[0] }, include: { items: true } });
      expect(reclass).toMatchObject({ sourceType: 'SYSTEM_DOC', sourceKey: `REMAP:AR:${f.oldAr.id}:${f.newAr.id}:${Y}0615`, status: 'Submitted', fiscalYearId: f.fy.id });
      expect(reclass.narration).toContain('Pindah ke akun piutang baru');
      expect(await net(tx, f.oldAr.id)).toBe(0);
      expect(await net(tx, f.newAr.id)).toBe(500 * JT);
      expect(await net(tx, f.newAr.id, f.p1)).toBe(300 * JT);
      expect(await net(tx, f.newAr.id, f.p2)).toBe(200 * JT);
      expect(Number((await tx.account.findUniqueOrThrow({ where: { id: f.oldAr.id } })).balance)).toBe(0);
      expect(Number((await tx.account.findUniqueOrThrow({ where: { id: f.newAr.id } })).balance)).toBe(500 * JT);
      expect(await findArSubledgerDiffs(tx, { partyIds: [f.p1, f.p2] })).toEqual([]);
      const parties = await tx.party.findMany({ where: { id: { in: [f.p1, f.p2] } }, orderBy: { outstandingAmount: 'desc' } });
      expect(parties.map((p) => Number(p.outstandingAmount))).toEqual([300 * JT, 200 * JT]);
      expect((await findFormerResidues(tx, 'AR')).filter((r) => r.fromAccountId === f.oldAr.id)).toEqual([]);

      // Void an invoice from before the remap: it lands on the old account, the subledger follows.
      await cancelSalesInvoiceInTx(tx, inv1.id);
      expect(await net(tx, f.oldAr.id, f.p1)).toBe(-300 * JT);
      expect(await findArSubledgerDiffs(tx, { partyIds: [f.p1, f.p2] })).toEqual([]);
      const check = await checkFormerRoleAccounts();
      expect(check.status).toBe('warning');
      expect(check.details).toContainEqual(expect.objectContaining({ role: 'AR', amount: '-300000000.00', parties: 1 }));

      const swept = await callRoute(router, 'post', '/:role/sweep', { params: { role: 'AR' }, body: { reason: 'Sisa batal invoice lama' }, userId: f.userId, role: 'Admin' });
      expect(swept.status).toBe(200);
      expect(swept.body.transfers).toEqual([expect.objectContaining({ fromAccountId: f.oldAr.id, toAccountId: f.newAr.id, amount: '-300000000.00' })]);
      expect(await net(tx, f.oldAr.id)).toBe(0);
      expect(await net(tx, f.newAr.id, f.p1)).toBe(0);
      expect(await net(tx, f.newAr.id)).toBe(200 * JT);
      expect(await findArSubledgerDiffs(tx, { partyIds: [f.p1, f.p2] })).toEqual([]);
      expect((await findFormerResidues(tx, 'AR')).filter((r) => r.fromAccountId === f.oldAr.id)).toEqual([]);

      const again = await callRoute(router, 'post', '/:role/sweep', { params: { role: 'AR' }, body: { reason: 'Sisa batal invoice lama' }, userId: f.userId, role: 'Admin' });
      expect(again.status).toBe(200);
      expect(again.body.transfers).toEqual([]);
    });
  });

  it('empties an old AR group account; a group target is refused', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-06-15T10:00:00+07:00`);
      const f = await fixture(tx);
      const group = await account(tx, 'Piutang grup', { isGroup: true });
      const contra = await account(tx, 'Lawan', { accountType: 'REVENUE', rootType: 'REVENUE' });
      await mapRole(tx, 'AR', group.id);
      await rawJournal(tx, f.fy, f.userId, new Date(`${Y}-02-01T00:00:00+07:00`), [
        { accountId: group.id, partyId: f.p1, debit: 7 * JT },
        { accountId: contra.id, credit: 7 * JT },
      ]);

      const toGroup = await put(f.userId, { mappings: [{ role: 'AR', accountId: (await account(tx, 'Grup lain', { isGroup: true })).id }], transferBalance: true, reason: 'Ke akun grup' });
      expect(toGroup.status).toBe(400);
      expect(toGroup.body.code).toBe('ACCOUNT_GROUP');

      const ok = await put(f.userId, { mappings: [{ role: 'AR', accountId: f.newAr.id }], transferBalance: true, reason: 'Keluar dari akun grup' });
      expect(ok.status).toBe(200);
      expect(await net(tx, group.id)).toBe(0);
      expect(await net(tx, f.newAr.id, f.p1)).toBe(7 * JT);
    });
  });

  it('saving another role next to an unchanged AR does not check AR', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-06-15T10:00:00+07:00`);
      const f = await fixture(tx);
      const contra = await account(tx, 'Lawan', { accountType: 'REVENUE', rootType: 'REVENUE' });
      await rawJournal(tx, f.fy, f.userId, new Date(`${Y}-02-01T00:00:00+07:00`), [
        { accountId: f.oldAr.id, partyId: f.p1, debit: 5 * JT },
        { accountId: contra.id, credit: 5 * JT },
      ]);
      const guarantee = await account(tx, 'Jaminan');
      await tx.systemAccountMapping.deleteMany({ where: { role: 'PROJECT_GUARANTEE' } }); // a new mapping, not a move
      const r = await put(f.userId, { mappings: [{ role: 'AR', accountId: f.oldAr.id }, { role: 'PROJECT_GUARANTEE', accountId: guarantee.id }] });
      expect(r.status).toBe(200);
      expect(r.body.transfers).toEqual([]);
      expect(await net(tx, f.oldAr.id)).toBe(5 * JT);
    });
  });

  it('a closed current year refuses the transfer and keeps the mapping', async () => {
    await inRollback(async (tx) => {
      clockAt(`${Y}-06-15T10:00:00+07:00`);
      const f = await fixture(tx, { closed: true });
      const contra = await account(tx, 'Lawan', { accountType: 'REVENUE', rootType: 'REVENUE' });
      await rawJournal(tx, f.fy, f.userId, new Date(`${Y}-02-01T00:00:00+07:00`), [
        { accountId: f.oldAr.id, partyId: f.p1, debit: 5 * JT },
        { accountId: contra.id, credit: 5 * JT },
      ]);
      const r = await put(f.userId, { mappings: [{ role: 'AR', accountId: f.newAr.id }], transferBalance: true, reason: 'Tahun tertutup' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('PERIOD_CLOSED');
      expect((await tx.systemAccountMapping.findFirst({ where: { role: 'AR' } }))!.accountId).toBe(f.oldAr.id);
      expect(await net(tx, f.oldAr.id)).toBe(5 * JT);
    });
  });
});
