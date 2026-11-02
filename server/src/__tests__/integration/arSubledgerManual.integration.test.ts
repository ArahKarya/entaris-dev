/**
 * Integration test: one definition of the manual party adjustment (plan §2.8, PR-4.4a) shared by
 * the receivable subledger check and recalcPartyOutstanding.
 *
 * Fixture year 2177 (unique to this file). Everything runs in a rollback transaction with its own
 * fiscal year, accounts, parties and user; the receivable account is the seed's AR mapping.
 * - A manual journal Dr Piutang 5 jt for Customer B (through postJournal) leaves the AR check green
 *   for B, and recalcPartyOutstanding(B) = 5 jt (the document-only formula would give 0).
 * - Cash book journals are not adjustments: one with a Customer on AR shows up as a difference for
 *   that Customer, one without a party shows up in the bucket without a party.
 * - A cancelled manual journal counts on neither side.
 * - An account AR held before a remap (sourceKey REMAP:AR:<from>:<to>:...) still counts: a manual
 *   line there is in both the ledger side and the adjustment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { postJournal } from '../../services/ledger/postJournal';
import { DOCUMENT_RULE, manualJournalRule } from '../../services/ledger/accountGuard';
import { findArSubledgerDiffs } from '../../services/ledger/arSubledgerCheck';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import { fiscalYearRange } from '../../utils/periodGuard';

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
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2177;
const JT = 1_000_000;
const DAY = new Date(`${Y}-05-20T00:00:00+07:00`);
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books { fy: FiscalYear; userId: string; arId: string; contraId: string }

async function books(tx: Tx): Promise<Books> {
  const ar = await tx.systemAccountMapping.findFirst({ where: { role: 'AR' }, select: { accountId: true } });
  if (!ar) throw new Error('AR is not mapped (seed).');
  const contra = await tx.account.create({
    data: { name: 'IT-ARM Lawan', accountNumber: `IT-ARM-${tag()}`, accountType: 'REVENUE', rootType: 'REVENUE' },
  });
  return {
    fy: await createFiscalYear(tx, { year: Y }),
    userId: (await createCapUser(tx, [])).userId,
    arId: ar.accountId,
    contraId: contra.id,
  };
}

const customer = async (tx: Tx) =>
  (await tx.party.create({ data: { name: `IT-ARM Customer ${tag()}`, partyType: 'Customer' } })).id;

/** Manual journal Dr AR `amount` for `partyId` / Cr contra, as the manual journal will post it. */
function manualAr(tx: Tx, b: Books, partyId: string, amount: number) {
  return postJournal(tx, {
    date: DAY, narration: 'IT-ARM manual', createdBy: b.userId, sourceType: 'MANUAL',
    accountRule: manualJournalRule(true), partyRule: 'strict', partyEffect: 'recalc',
    lines: [{ accountId: b.arId, debit: amount, partyId }, { accountId: b.contraId, credit: amount }],
  });
}

/** Cash book style journal on AR (party rule off, as the cash book posts today). */
function cashBookAr(tx: Tx, b: Books, partyId: string | null, debit: number, credit: number) {
  return postJournal(tx, {
    date: DAY, narration: 'IT-ARM kas', createdBy: b.userId, sourceType: 'CASH_BOOK',
    accountRule: DOCUMENT_RULE, partyRule: 'off',
    lines: [
      { accountId: b.arId, debit, credit, partyId },
      { accountId: b.contraId, debit: credit, credit: debit },
    ],
  });
}

d('manual party adjustment (plan §2.8)', () => {
  it('a manual Dr Piutang 5 jt keeps the AR check green and recalc gives 5 jt', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const partyB = await customer(tx);
      await manualAr(tx, b, partyB, 5 * JT);

      expect(await findArSubledgerDiffs(tx, { partyIds: [partyB] })).toEqual([]);
      const range = fiscalYearRange(b.fy);
      expect((await findArSubledgerDiffs(tx, { fiscalYear: range })).map((r) => r.partyId)).not.toContain(partyB);

      await tx.party.update({ where: { id: partyB }, data: { outstandingAmount: 0 } });
      await recalcPartyOutstanding(tx, partyB);
      const p = await tx.party.findUniqueOrThrow({ where: { id: partyB } });
      expect(p.outstandingAmount.toFixed(2)).toBe('5000000.00');
    });
  });

  it('cash book journals on AR are not adjustments: with a Customer and without a party both show up', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const partyC = await customer(tx);
      await cashBookAr(tx, b, partyC, 2 * JT, 0);
      await cashBookAr(tx, b, null, 0, JT);

      const forC = await findArSubledgerDiffs(tx, { partyIds: [partyC] });
      expect(forC.map((r) => [r.partyId, r.gl.toFixed(2), r.subledger.toFixed(2)])).toEqual([[partyC, '2000000.00', '0.00']]);

      const year = await findArSubledgerDiffs(tx, { fiscalYear: fiscalYearRange(b.fy) });
      const noParty = year.find((r) => r.partyId === null);
      expect(noParty?.gl.toFixed(2)).toBe('-1000000.00');
      expect(noParty?.subledger.toFixed(2)).toBe('0.00');

      await recalcPartyOutstanding(tx, partyC);
      expect((await tx.party.findUniqueOrThrow({ where: { id: partyC } })).outstandingAmount.toFixed(2)).toBe('0.00');
    });
  });

  it('a cancelled manual journal counts on neither side', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const partyD = await customer(tx);
      const { journal } = await manualAr(tx, b, partyD, 3 * JT);
      await tx.journalEntry.update({ where: { id: journal.id }, data: { status: 'Cancelled', cancelledAt: new Date() } });
      await tx.accountingLedgerEntry.updateMany({ where: { referenceId: journal.id }, data: { isCancelled: true } });

      expect(await findArSubledgerDiffs(tx, { partyIds: [partyD] })).toEqual([]);
      await recalcPartyOutstanding(tx, partyD);
      expect((await tx.party.findUniqueOrThrow({ where: { id: partyD } })).outstandingAmount.toFixed(2)).toBe('0.00');
    });
  });

  it('an account AR held before a remap still counts on both sides', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const partyE = await customer(tx);
      const formerAr = await tx.account.create({
        data: { name: 'IT-ARM Piutang lama', accountNumber: `IT-ARM-${tag()}`, accountType: 'ASSET', rootType: 'ASSET' },
      });
      await tx.journalEntry.create({
        data: {
          entryNumber: `IT-ARM-REMAP-${tag()}`, date: DAY, status: 'Submitted', fiscalYearId: b.fy.id, createdBy: b.userId,
          sourceType: 'SYSTEM_DOC', sourceKey: `REMAP:AR:${formerAr.id}:${b.arId}:${Y}0101`,
        },
      });
      // A manual line on the former account, written as an older manual journal would have.
      const je = await tx.journalEntry.create({
        data: {
          entryNumber: `IT-ARM-OLD-${tag()}`, date: DAY, status: 'Submitted', fiscalYearId: b.fy.id, createdBy: b.userId,
          sourceType: 'MANUAL',
          items: { create: [{ accountId: formerAr.id, partyId: partyE, debit: 4 * JT }, { accountId: b.contraId, credit: 4 * JT }] },
        },
      });
      await tx.accountingLedgerEntry.createMany({
        data: [
          { date: DAY, accountId: formerAr.id, partyId: partyE, debit: 4 * JT, credit: 0, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: b.fy.id },
          { date: DAY, accountId: b.contraId, debit: 0, credit: 4 * JT, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: b.fy.id },
        ],
      });

      expect(await findArSubledgerDiffs(tx, { partyIds: [partyE] })).toEqual([]);
      await recalcPartyOutstanding(tx, partyE);
      expect((await tx.party.findUniqueOrThrow({ where: { id: partyE } })).outstandingAmount.toFixed(2)).toBe('4000000.00');

      // Without the remap journal the former account is no longer AR: the GL side drops it too.
      await tx.journalEntry.updateMany({ where: { sourceKey: { startsWith: `REMAP:AR:${formerAr.id}:` } }, data: { status: 'Cancelled' } });
      expect(await findArSubledgerDiffs(tx, { partyIds: [partyE] })).toEqual([]);
      await recalcPartyOutstanding(tx, partyE);
      expect((await tx.party.findUniqueOrThrow({ where: { id: partyE } })).outstandingAmount.toFixed(2)).toBe('0.00');
    });
  });
});
