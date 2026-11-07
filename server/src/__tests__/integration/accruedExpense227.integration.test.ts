/**
 * PR-4.14: the loose SQL that creates account 2.2.7 and moves ACCRUED_EXPENSE off 2.2.6.
 * Also the seed guard for the ACCRUED_EXPENSE mapping.
 * Runs inside a rolled-back transaction, builds its own accounts; the ledger-entry case uses fixture year 2168.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { shouldSeedAccruedExpense } from '../../../prisma/seedAccruedExpense';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../prisma/migrations/2026110900000_accrued_expense_227.sql'),
  'utf8',
);

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

const LIAB = { accountType: 'LIABILITY', rootType: 'LIABILITY' } as const;

/** Empty slate: the tables this file touches have none of the rows the SQL looks at. */
async function resetScene(tx: Tx) {
  await tx.systemAccountMapping.deleteMany({ where: { role: 'ACCRUED_EXPENSE' } });
  const numbers = ['2.2.6', '2.2.7'];
  const found = await tx.account.findMany({ where: { accountNumber: { in: numbers } } });
  for (const a of found) await tx.account.update({ where: { id: a.id }, data: { accountNumber: `OLD-${a.accountNumber}-${a.id.slice(0, 6)}` } });
}

async function ensureParent(tx: Tx) {
  const found = await tx.account.findFirst({ where: { accountNumber: '2.2' } });
  if (found) {
    await tx.account.update({ where: { id: found.id }, data: { isGroup: true } });
    return found;
  }
  return tx.account.create({ data: { name: 'IT-4.14 parent', accountNumber: '2.2', ...LIAB, isGroup: true } });
}

const mapped = async (tx: Tx) =>
  (await tx.systemAccountMapping.findMany({ where: { role: 'ACCRUED_EXPENSE' }, include: { account: true } }))
    .map((m) => m.account.accountNumber);

d('accrued_expense_227 loose SQL', () => {
  it('creates 2.2.7 under 2.2 and remaps an unused 2.2.6 mapping, twice the same', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await ensureParent(tx);
      const legacy = await tx.account.create({ data: { name: 'IT-4.14 gaji', accountNumber: '2.2.6', ...LIAB, parentId: parent.id } });
      await tx.systemAccountMapping.create({ data: { role: 'ACCRUED_EXPENSE', accountId: legacy.id } });

      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mapped(tx)).toEqual(['2.2.7']);
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mapped(tx)).toEqual(['2.2.7']);

      const created = await tx.account.findMany({ where: { accountNumber: '2.2.7' } });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ name: 'Biaya Masih Harus Dibayar', isGroup: false, isActive: true, rootType: 'LIABILITY', parentId: parent.id });
    });
  });

  it('does not remap when 2.2.6 already carries a ledger entry', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await ensureParent(tx);
      const legacy = await tx.account.create({ data: { name: 'IT-4.14 gaji', accountNumber: '2.2.6', ...LIAB, parentId: parent.id } });
      await tx.systemAccountMapping.create({ data: { role: 'ACCRUED_EXPENSE', accountId: legacy.id } });
      const fy = await createFiscalYear(tx, { year: 2168 });
      await tx.accountingLedgerEntry.create({
        data: {
          accountId: legacy.id, debit: 0, credit: 10, date: new Date('2168-01-15T00:00:00Z'),
          referenceType: 'IT414', referenceId: 'IT414-1', fiscalYearId: fy.id,
        },
      });

      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mapped(tx)).toEqual(['2.2.6']);
      // The account itself is still created: only the remap is skipped.
      expect(await tx.account.count({ where: { accountNumber: '2.2.7' } })).toBe(1);
    });
  });

  it('leaves a mapping to any other account alone', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await ensureParent(tx);
      await tx.account.create({ data: { name: 'IT-4.14 gaji', accountNumber: '2.2.6', ...LIAB, parentId: parent.id } });
      const own = await tx.account.create({ data: { name: 'IT-4.14 own', accountNumber: 'IT414.OWN', ...LIAB, parentId: parent.id } });
      await tx.systemAccountMapping.create({ data: { role: 'ACCRUED_EXPENSE', accountId: own.id } });

      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mapped(tx)).toEqual(['IT414.OWN']);
    });
  });

  it('leaves ACCRUED_EXPENSE on 2.2.6 when 2.2.7 is a tenant account with another name', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await ensureParent(tx);
      const legacy = await tx.account.create({ data: { name: 'IT-4.14 gaji', accountNumber: '2.2.6', ...LIAB, parentId: parent.id } });
      await tx.account.create({ data: { name: 'Hutang BPJS', accountNumber: '2.2.7', ...LIAB, parentId: parent.id } });
      await tx.systemAccountMapping.create({ data: { role: 'ACCRUED_EXPENSE', accountId: legacy.id } });

      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mapped(tx)).toEqual(['2.2.6']);
      expect(await tx.account.findFirst({ where: { accountNumber: '2.2.7' } })).toMatchObject({ name: 'Hutang BPJS' });
    });
  });

  it('does nothing when the parent 2.2 is missing', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await tx.account.findFirst({ where: { accountNumber: '2.2' } });
      if (parent) await tx.account.update({ where: { id: parent.id }, data: { accountNumber: `OLD-2.2-${parent.id.slice(0, 6)}` } });
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await tx.account.count({ where: { accountNumber: '2.2.7' } })).toBe(0);
    });
  });
});

d('ACCRUED_EXPENSE seed guard', () => {
  const SEED_SRC = readFileSync(join(__dirname, '../../../prisma/seed.ts'), 'utf8');

  it('seed maps ACCRUED_EXPENSE to 2.2.7 only', () => {
    expect(SEED_SRC).toContain("{ role: 'ACCRUED_EXPENSE', accountNumber: '2.2.7', sortOrder: 0 }");
    expect(SEED_SRC.match(/'ACCRUED_EXPENSE'/g)).toHaveLength(2); // the entry and the guard
    expect(SEED_SRC).toContain('shouldSeedAccruedExpense');
  });

  it('maps a fresh seeded 2.2.7 and adds nothing when a mapping already exists', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await ensureParent(tx);
      const target = await tx.account.create({
        data: { name: 'Biaya Masih Harus Dibayar', accountNumber: '2.2.7', ...LIAB, parentId: parent.id },
      });
      expect(await shouldSeedAccruedExpense(tx, target.id)).toBe(true);

      const legacy = await tx.account.create({ data: { name: 'IT-4.14 gaji', accountNumber: '2.2.6', ...LIAB, parentId: parent.id } });
      await tx.systemAccountMapping.create({ data: { role: 'ACCRUED_EXPENSE', accountId: legacy.id } });
      expect(await shouldSeedAccruedExpense(tx, target.id)).toBe(false);
    });
  });

  it('does not map a tenant-owned 2.2.7 with another name', async () => {
    await inRollback(async (tx) => {
      await resetScene(tx);
      const parent = await ensureParent(tx);
      const own = await tx.account.create({ data: { name: 'Hutang BPJS', accountNumber: '2.2.7', ...LIAB, parentId: parent.id } });
      expect(await shouldSeedAccruedExpense(tx, own.id)).toBe(false);
    });
  });
});
