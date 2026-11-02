/**
 * System account mapping validation and audit against a real database (E2-R8, PR-4.11).
 *
 * - PUT /system-accounts refuses a group account for a new mapping (ACCOUNT_GROUP) and leaves the
 *   stored mappings untouched; moving a legacy COGS -> group mapping to a detail account works while
 *   an unchanged legacy mapping next to a real change is not re-checked.
 * - The audit reports the group mapping with its ledger balance per fiscal year (cancelled rows
 *   excluded) and the detail accounts under the group as candidates.
 *
 * Everything runs in a rollback transaction on fixtures made here, in fiscal year 2167.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { auditSystemAccounts } from '../../services/systemAccountAudit';
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
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function account(tx: Tx, name: string, over: { isGroup?: boolean; parentId?: string; isActive?: boolean } = {}) {
  return tx.account.create({
    data: { name: `IT-SAM ${name}`, accountNumber: `IT-SAM-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE', ...over },
  });
}

const put = (body: unknown) => callRoute(router, 'put', '/', { body, userId: 'u-it', role: 'Admin' });

d('system account mapping validation and audit', () => {
  it('refuses a group account for a new mapping and leaves the stored mapping alone', async () => {
    await inRollback(async (tx) => {
      const group = await account(tx, 'group', { isGroup: true });
      const detail = await account(tx, 'detail', { parentId: group.id });
      await tx.systemAccountMapping.deleteMany({ where: { role: 'COGS' } });
      await tx.systemAccountMapping.create({ data: { role: 'COGS', accountId: detail.id } });

      const r = await put({ mappings: [{ role: 'COGS', accountId: group.id }] });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ACCOUNT_GROUP');

      const stored = await tx.systemAccountMapping.findMany({ where: { role: 'COGS' } });
      expect(stored.map((m) => m.accountId)).toEqual([detail.id]);
    });
  });

  it('moves a legacy group mapping to a detail account; an unchanged legacy mapping next to a change passes', async () => {
    await inRollback(async (tx) => {
      const group = await account(tx, 'group', { isGroup: true });
      const detail = await account(tx, 'detail', { parentId: group.id });
      const other = await account(tx, 'other');
      await tx.systemAccountMapping.deleteMany({ where: { role: { in: ['COGS', 'OTHER_EXPENSE'] } } });
      await tx.systemAccountMapping.create({ data: { role: 'COGS', accountId: group.id } });
      await tx.systemAccountMapping.create({ data: { role: 'OTHER_EXPENSE', accountId: other.id } });

      // COGS re-sent on the group (unchanged) while OTHER_EXPENSE really changes.
      const keep = await put({
        mappings: [{ role: 'COGS', accountId: group.id }, { role: 'OTHER_EXPENSE', accountId: detail.id }],
      });
      expect(keep.status).toBe(200);

      const move = await put({ mappings: [{ role: 'COGS', accountId: other.id }] });
      expect(move.status).toBe(200);
      const cogs = await tx.systemAccountMapping.findMany({ where: { role: 'COGS' } });
      expect(cogs.map((m) => m.accountId)).toEqual([other.id]);
    });
  });

  it('audit reports COGS on a group account with its balance per year and the detail children as candidates', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: 2167 });
      const group = await account(tx, 'group', { isGroup: true });
      const detail = await account(tx, 'detail 1', { parentId: group.id });
      const counter = await account(tx, 'counter');
      await tx.systemAccountMapping.deleteMany({ where: { role: 'COGS' } });
      await tx.systemAccountMapping.create({ data: { role: 'COGS', accountId: group.id } });

      // Every referenceType/referenceId group balances, so a deferred ledger-balance check passes.
      const pair = async (ref: string, debitId: string, creditId: string, amount: number, isCancelled = false) => {
        const row = (accountId: string, debit: number, credit: number) =>
          tx.accountingLedgerEntry.create({
            data: {
              date: new Date('2167-03-01'), accountId, debit, credit, referenceType: 'IT-SAM', referenceId: ref,
              fiscalYearId: fy.id, isCancelled,
            },
          });
        await row(debitId, amount, 0);
        await row(creditId, 0, amount);
      };
      await pair(`${tag()}-a`, group.id, counter.id, 1500);
      await pair(`${tag()}-b`, counter.id, group.id, 200);
      await pair(`${tag()}-c`, group.id, counter.id, 9999, true);

      const findings = await auditSystemAccounts(tx);
      const f = findings.find((x) => x.role === 'COGS' && x.issue === 'GROUP_ACCOUNT');
      expect(f).toBeDefined();
      expect(f).toMatchObject({ posting: true, aleRows: 2, netAllYears: '1300.00', netByYear: `${fy.name}=1300.00` });
      expect(f!.candidates).toEqual([`${detail.accountNumber} ${detail.name}`]);
    });
  });
});
