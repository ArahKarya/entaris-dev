/**
 * Integration test: the journal import posts through createManualJournalInTx and takes a party
 * column (E7-R9b, PR-4.8).
 *
 * Fixture year 2197 (unique to this file). Everything runs in a rollback transaction and every
 * fixture is created in it: a fiscal year (open, or closed), a receivable account (mapped as AR),
 * a revenue account, a group account, customers, and users holding (or not) journal.control. The
 * route runs through the route harness with the file reader replaced by the rows of each test.
 * - Dr Piutang 10 jt (party named by its name) / Cr Pendapatan by a journal.control holder: the
 *   customer's outstanding rises 10 jt, the journal is IMPORT with its sourceKey, party on the item
 *   and the ledger row, and 10 jt stays after recalcPartyOutstanding.
 * - Without journal.control the receivable line is an ACCOUNT_CONTROL row error and nothing posts.
 * - The same file again is skipped (also when the party is named by id); a name two customers
 *   share is a row error; a group account and a closed year are row errors.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({
  tx: null as Tx | null,
  rows: [] as Record<string, string>[],
}));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../routes/import/shared', () => ({
  upload: { single: () => (req: any, _res: any, next: any) => { req.file = { buffer: Buffer.from(''), originalname: 'x.csv' }; next(); } },
  parseFileDetailed: vi.fn(async () => ({ rows: state.rows, numericCells: state.rows.map(() => ({})) })),
  sanitizeCellValue: (v: unknown) => String(v ?? '').trim(),
}));

import importJournalsRouter from '../../routes/import/journals';
import { recalcPartyOutstanding } from '../../utils/accountBalance';

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
  state.tx = null;
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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  } finally {
    state.tx = null;
  }
}

const Y = 2197;
const DAY = `${Y}-03-10`;
const JT = 10_000_000;
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

interface Books { arNo: string; revNo: string; groupNo: string; arId: string }

async function books(tx: Tx, closed = false): Promise<Books> {
  await createFiscalYear(tx, { year: Y, isClosed: closed });
  const mk = async (rootType: 'ASSET' | 'REVENUE', opts: { role?: string; isGroup?: boolean } = {}) => {
    const acc = await tx.account.create({
      data: { name: `IT-IJ ${opts.role ?? rootType}`, accountNumber: `IT-IJ-${tag()}`, accountType: rootType, rootType, isGroup: opts.isGroup ?? false },
    });
    if (opts.role) await tx.systemAccountMapping.create({ data: { role: opts.role, accountId: acc.id, sortOrder: 99 } });
    return acc;
  };
  const ar = await mk('ASSET', { role: 'AR' });
  return { arNo: ar.accountNumber, arId: ar.id, revNo: (await mk('REVENUE')).accountNumber, groupNo: (await mk('REVENUE', { isGroup: true })).accountNumber };
}

const customer = (tx: Tx, name: string) => tx.party.create({ data: { name, partyType: 'Customer' } });

type Row = Record<string, string>;
/** Dr `debitNo` / Cr `creditNo` for 10 jt; `partyCode` on the debit row. */
const journal = (debitNo: string, creditNo: string, partyCode = '', narration = 'IT-IJ piutang'): Row[] => [
  { date: DAY, narration, accountNumber: debitNo, debit: String(JT), credit: '0', description: '', ref: '', partyCode },
  { date: DAY, narration, accountNumber: creditNo, debit: '0', credit: String(JT), description: '', ref: '', partyCode: '' },
];

const importFile = (rows: Row[], user: { userId: string; role: string }, preview = false) => {
  state.rows = rows;
  return callRoute(importJournalsRouter, 'post', '/journals', { ...user, query: preview ? { preview: 'true' } : {} });
};

const controller = (tx: Tx) => createCapUser(tx, ['journal.control'], { perms: { journal: 'edit' } });
const plain = (tx: Tx) => createCapUser(tx, [], { perms: { journal: 'edit' } });

d('journal import posts through createManualJournalInTx', () => {
  it('Dr Piutang 10 jt for a party named by name raises its outstanding by 10 jt and survives a recalc', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await controller(tx);
      const name = `IT-IJ Customer ${tag()}`;
      const party = await customer(tx, name);

      const res = await importFile(journal(b.arNo, b.revNo, name.toUpperCase()), user);
      expect(res.body).toMatchObject({ success: 1, failed: 0, errors: [] });
      expect(res.body.journals).toHaveLength(1);

      const je = await tx.journalEntry.findUniqueOrThrow({ where: { id: res.body.journals[0].id }, include: { items: true } });
      expect(je).toMatchObject({ sourceType: 'IMPORT', status: 'Submitted', createdBy: user.userId });
      expect(je.sourceKey).toMatch(/^IMPORT:/);
      expect(je.items.filter((i) => i.partyId === party.id)).toHaveLength(1);
      const ale = await tx.accountingLedgerEntry.findMany({ where: { referenceType: 'JournalEntry', referenceId: je.id, accountId: b.arId } });
      expect(ale.map((r) => r.partyId)).toEqual([party.id]);

      const outstanding = async () => (await tx.party.findUniqueOrThrow({ where: { id: party.id } })).outstandingAmount.toFixed(2);
      expect(await outstanding()).toBe('10000000.00');
      await recalcPartyOutstanding(tx, party.id);
      expect(await outstanding()).toBe('10000000.00');
    });
  });

  it('without journal.control the receivable line is an ACCOUNT_CONTROL row error and nothing posts', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await plain(tx);
      const name = `IT-IJ Customer ${tag()}`;
      await customer(tx, name);
      const res = await importFile(journal(b.arNo, b.revNo, name), user);
      expect(res.body.success).toBe(0);
      expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_CONTROL' })]);
      expect(await tx.journalEntry.count({ where: { sourceType: 'IMPORT', narration: 'IT-IJ piutang' } })).toBe(0);
    });
  });

  it('importing the same file again is skipped, also when the party is named by id', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await controller(tx);
      const party = await customer(tx, `IT-IJ Customer ${tag()}`);
      expect((await importFile(journal(b.arNo, b.revNo, party.name), user)).body.success).toBe(1);
      const again = await importFile(journal(b.arNo, b.revNo, party.id), user);
      expect(again.body).toMatchObject({ success: 0, failed: 0, totalJournals: 1 });
      expect(again.body.alreadyImported).toHaveLength(1);
      expect(await tx.journalEntry.count({ where: { sourceType: 'IMPORT', narration: 'IT-IJ piutang' } })).toBe(1);
    });
  });

  it('a name two customers share is a row error; its id posts', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await controller(tx);
      const name = `IT-IJ Kembar ${tag()}`;
      const first = await customer(tx, name);
      await customer(tx, name.toLowerCase());
      const res = await importFile(journal(b.arNo, b.revNo, name), user);
      expect(res.body.success).toBe(0);
      expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_AMBIGUOUS_NAME' })]);
      expect((await importFile(journal(b.arNo, b.revNo, first.id), user)).body.success).toBe(1);
    });
  });

  it('a receivable line without a party is PARTY_REQUIRED on its row', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await controller(tx);
      const res = await importFile(journal(b.arNo, b.revNo), user);
      expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_REQUIRED' })]);
    });
  });

  it('an already-imported control journal is skipped for a user without journal.control, next to a new journal', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const boss = await controller(tx);
      const party = await customer(tx, `IT-IJ Customer ${tag()}`);
      const file = journal(b.arNo, b.revNo, party.name);
      expect((await importFile(file, boss)).body.success).toBe(1);
      const other = await tx.account.create({
        data: { name: 'IT-IJ lain', accountNumber: `IT-IJ-${tag()}`, accountType: 'REVENUE', rootType: 'REVENUE' },
      });
      const fresh = journal(other.accountNumber, b.revNo, '', 'IT-IJ baru');
      const res = await importFile([...file, ...fresh], await plain(tx));
      expect(res.body).toMatchObject({ success: 1, failed: 0, errors: [], totalJournals: 2 });
      expect(res.body.alreadyImported).toHaveLength(1);
      expect(await tx.journalEntry.count({ where: { sourceType: 'IMPORT', narration: 'IT-IJ piutang' } })).toBe(1);
      expect(await tx.journalEntry.count({ where: { sourceType: 'IMPORT', narration: 'IT-IJ baru' } })).toBe(1);
    });
  });

  it('a group account is refused on its row', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx);
      const user = await controller(tx);
      const res = await importFile(journal(b.groupNo, b.revNo), user);
      expect(res.body.success).toBe(0);
      expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_GROUP' })]);
    });
  });

  it('a closed fiscal year refuses the journal on every row of it', async () => {
    await inRollback(async (tx) => {
      const b = await books(tx, true);
      const user = await controller(tx);
      const party = await customer(tx, `IT-IJ Customer ${tag()}`);
      const res = await importFile(journal(b.arNo, b.revNo, party.name), user);
      expect(res.body.success).toBe(0);
      expect(res.body.errors.map((e: any) => e.row)).toEqual([2, 3]);
      expect(res.body.errors[0].message).toContain('ditutup');
      expect(await tx.journalEntry.count({ where: { sourceType: 'IMPORT', narration: 'IT-IJ piutang' } })).toBe(0);
    });
  });
});
