/**
 * Integration test: a party typed Both in manual journals and the AR subledger per side (PR-5.9b,
 * services/ledger/partyRules.ts, services/ledger/arSubledgerCheck.ts).
 *
 * Fixture year 2139 (unique to this file). Everything runs in a rollback transaction with its own
 * fiscal year, user, parties and accounts; the receivable and payable accounts are the seed's AR
 * and AP mappings. Assertions only look at this file's parties.
 * - Dr Piutang 20 jt and Cr Hutang 30 jt for a Both party post (201); its receivable side is 20 jt,
 *   its payable side 30 jt and the AR subledger check has no difference for it.
 * - The opening directed to the receivable side counts in the AR check; the payable side stays out.
 * - A Customer on a payable line and a Supplier on a receivable line are still refused
 *   (PARTY_TYPE_MISMATCH); the menu cancel of the Both journals brings both sides back to 0.
 * - The ledger audit no longer reports a Both line as a party problem.
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

import { invalidatePermissionCache } from '../../services/permissionService';
import { findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { runLedgerAudit } from '../../services/ledger/ledgerAudit';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import journalsRouter from '../../routes/journals';

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
      invalidatePermissionCache();
      try {
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

const Y = 2139;
const JT = 1_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type Actor = { userId: string; role: string };

interface Books {
  fyId: string;
  control: Actor;
  arId: string;
  apId: string;
  contraId: string;
}

async function mapped(tx: Tx, role: string): Promise<string> {
  const m = await tx.systemAccountMapping.findFirst({ where: { role }, select: { accountId: true } });
  if (!m) throw new Error(`${role} is not mapped (seed).`);
  return m.accountId;
}

async function books(tx: Tx): Promise<Books> {
  const contra = await tx.account.create({
    data: { name: 'IT-PBM Lawan', accountNumber: `IT-PBM-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE' },
  });
  return {
    fyId: (await createFiscalYear(tx, { year: Y })).id,
    control: await createCapUser(tx, ['doc.cancel', 'journal.control']),
    arId: await mapped(tx, 'AR'),
    apId: await mapped(tx, 'AP'),
    contraId: contra.id,
  };
}

type PartyKind = 'Customer' | 'Supplier' | 'Both';
const party = async (tx: Tx, partyType: PartyKind, data: Record<string, number> = {}) =>
  (await tx.party.create({ data: { name: `IT-PBM ${partyType} ${tag()}`, partyType, ...data } })).id;

type Item = { accountId: string; debit?: number; credit?: number; partyId?: string | null };

function post(who: Actor, items: Item[]) {
  return callRoute(journalsRouter, 'post', '/', {
    body: { date: `${Y}-03-10`, narration: `IT-PBM ${tag()}`, items: items.map((i) => ({ debit: 0, credit: 0, ...i })) },
    ...who,
  });
}

function cancel(who: Actor, id: string) {
  return callRoute(journalsRouter, 'patch', '/:id/cancel', { params: { id }, body: { reason: 'Uji Both manual' }, ...who });
}

function expectCode(r: RouteResult, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.code).toBe(code);
}

const sides = async (tx: Tx, id: string) => {
  const p = await tx.party.findUniqueOrThrow({ where: { id } });
  return { receivable: p.receivableOutstanding.toFixed(2), payable: p.payableOutstanding.toFixed(2), total: p.outstandingAmount.toFixed(2) };
};

d('a Both party in manual journals (PR-5.9b)', () => {
  it('posts a receivable and a payable line for a Both party and keeps the two sides apart', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const both = await party(tx, 'Both');

      const ar = await post(b.control, [{ accountId: b.arId, debit: 20 * JT, partyId: both }, { accountId: b.contraId, credit: 20 * JT }]);
      expect(ar.status, JSON.stringify(ar.body)).toBe(201);
      const ap = await post(b.control, [{ accountId: b.contraId, debit: 30 * JT }, { accountId: b.apId, credit: 30 * JT, partyId: both }]);
      expect(ap.status, JSON.stringify(ap.body)).toBe(201);

      expect(await sides(tx, both)).toEqual({ receivable: '20000000.00', payable: '30000000.00', total: '50000000.00' });
      await recalcPartyOutstanding(tx, both);
      expect(await sides(tx, both)).toEqual({ receivable: '20000000.00', payable: '30000000.00', total: '50000000.00' });
      expect(await findArSubledgerDiffs(tx, { partyIds: [both] })).toEqual([]);

      const audit = await runLedgerAudit(tx, { only: ['manualPartyLines'], fiscalYearId: b.fyId });
      const lines = audit.sections.find((x) => x.id === 'manualPartyLines')?.rows ?? [];
      expect(lines.filter((r) => r.detail.includes('IT-PBM Both'))).toEqual([]);

      for (const r of [ar, ap]) expect((await cancel(b.control, r.body.id)).status).toBe(200);
      expect(await sides(tx, both)).toEqual({ receivable: '0.00', payable: '0.00', total: '0.00' });
    });
  });

  it('counts the receivable side of a Both opening in the AR check and leaves the payable side out', async () => {
    await inRollback(async (tx) => {
      // 12 jt opening: 5 jt receivable, 7 jt payable.
      const both = await party(tx, 'Both', { openingOutstanding: 12 * JT, openingReceivable: 5 * JT, openingPayable: 7 * JT });
      await recalcPartyOutstanding(tx, both);
      expect(await sides(tx, both)).toEqual({ receivable: '5000000.00', payable: '7000000.00', total: '12000000.00' });

      // The ledger holds nothing yet: the subledger is the 5 jt receivable side, not the 12 jt total.
      const before = await findArSubledgerDiffs(tx, { partyIds: [both] });
      expect(before).toHaveLength(1);
      expect(before[0]!.subledger.toFixed(2)).toBe('5000000.00');
      expect(before[0]!.difference.toFixed(2)).toBe('-5000000.00');
    });
  });

  it('includes a Both party in the AR check by the same expression as its amount, with or without an invoice', async () => {
    await inRollback(async (tx) => {
      // Payable opening of 10 jt whose outstanding was consumed by a vendor payment: -10 jt, invoice or not.
      const both = await party(tx, 'Both', { openingOutstanding: 0, openingReceivable: 0, openingPayable: 10 * JT });
      const diffs = await findArSubledgerDiffs(tx, { partyIds: [both] });
      expect(diffs).toHaveLength(1);
      expect(diffs[0]!.subledger.toFixed(2)).toBe('-10000000.00');
    });
  });

  it('still refuses a Customer on a payable line and a Supplier on a receivable line', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const customer = await party(tx, 'Customer');
      const supplier = await party(tx, 'Supplier');
      expectCode(
        await post(b.control, [{ accountId: b.contraId, debit: JT }, { accountId: b.apId, credit: JT, partyId: customer }]),
        'PARTY_TYPE_MISMATCH',
      );
      expectCode(
        await post(b.control, [{ accountId: b.arId, debit: JT, partyId: supplier }, { accountId: b.contraId, credit: JT }]),
        'PARTY_TYPE_MISMATCH',
      );
    });
  });
});
