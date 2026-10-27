/**
 * Integration test: journal source columns (migration 2026102700000_journal_entry_source.sql).
 *
 * The loose SQL file must be safe to run again on every boot, and the shared posting helper must
 * tag its journals (SYSTEM_DOC by default, CASH_BOOK from the cash book).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { postJournalInTx } from '../../services/paymentRequestService';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const MIGRATION = join(__dirname, '../../../prisma/migrations/2026102700000_journal_entry_source.sql');

let prisma: PrismaClient;
let pool: Pool;
let userId: string;
let accounts: { id: string }[];

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
  accounts = await prisma.account.findMany({ where: { isGroup: false, isActive: true }, select: { id: true }, take: 2 });
  if (accounts.length < 2) throw new Error('Need two detail accounts.');
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 20000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

d('journal_entry_source migration', () => {
  it('runs twice in a row without error and leaves the columns, FK and index in place', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(sql);
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'journal_entries'
           AND column_name IN ('source_type','source_key','cancelled_by_id','cancel_reason','reversed_by_id')`,
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
        ['cancel_reason', 'cancelled_by_id', 'reversed_by_id', 'source_key', 'source_type'],
      );
      const fk = await client.query(
        `SELECT confdeltype FROM pg_constraint WHERE conname = 'journal_entries_reversed_by_id_fkey'`,
      );
      expect(fk.rows).toEqual([{ confdeltype: 'n' }]); // ON DELETE SET NULL
      const idx = await client.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'journal_entries_source_type_source_key_idx'`,
      );
      expect(idx.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

d('journal source tagging', () => {
  async function post(tx: Tx, sourceType?: 'CASH_BOOK') {
    const fy = await tx.fiscalYear.create({
      data: { name: `IT-${Math.random().toString(36).slice(2, 8)}`, startDate: new Date('2099-01-01'), endDate: new Date('2099-12-31') },
    });
    const now = new Date('2099-03-01T03:00:00Z');
    return postJournalInTx(tx, {
      date: now, narration: 'Uji asal jurnal', fiscalYearId: fy.id, actorId: userId, now,
      lines: [
        { accountId: accounts[0]!.id, debit: 1000, credit: 0, description: 'uji' },
        { accountId: accounts[1]!.id, debit: 0, credit: 1000, description: 'uji' },
      ],
      ...(sourceType ? { sourceType } : {}),
    });
  }

  it('postJournalInTx tags SYSTEM_DOC by default', async () => {
    await inRollback(async (tx) => {
      const je = await post(tx);
      const row = await tx.journalEntry.findUniqueOrThrow({ where: { id: je.id } });
      expect(row.sourceType).toBe('SYSTEM_DOC');
      expect(row.sourceKey).toBeNull();
    });
  });

  it('postJournalInTx tags the given source (cash book)', async () => {
    await inRollback(async (tx) => {
      const je = await post(tx, 'CASH_BOOK');
      const row = await tx.journalEntry.findUniqueOrThrow({ where: { id: je.id } });
      expect(row.sourceType).toBe('CASH_BOOK');
    });
  });

  it('deleting a reversing journal clears reversed_by_id on the original', async () => {
    await inRollback(async (tx) => {
      const original = await post(tx);
      const reversal = await post(tx);
      await tx.journalEntry.update({ where: { id: original.id }, data: { reversedById: reversal.id } });
      await tx.accountingLedgerEntry.deleteMany({ where: { referenceId: reversal.id } });
      await tx.journalItem.deleteMany({ where: { journalEntryId: reversal.id } });
      await tx.journalEntry.delete({ where: { id: reversal.id } });
      const row = await tx.journalEntry.findUniqueOrThrow({ where: { id: original.id } });
      expect(row.reversedById).toBeNull();
    });
  });
});
