/**
 * Integration test: the one cut-over date of the opening balances (E2-R11, PR-5.7a, owner
 * decisions #1 and #10).
 *
 * Fixture: fiscal year 2152 (this file's year, plan §6.3). Inside the rollback transaction every
 * other open fiscal year is closed, so 2152 is the earliest open one, and company_settings.cutover_date
 * starts empty.
 * - Reading (GET /coa, peekCutoverDate) twice writes nothing; the first posted opening balance
 *   stores 2152-01-01 with one SET_CUTOVER_DATE audit row; a later posting adds none; the date
 *   stays after the year is closed.
 * - Cut-over on or before the lock date: without throughLock PERIOD_LOCKED; with throughLock a
 *   period.lock holder posts, and the reason lands in the audit trail.
 * - Deleting demo data clears the cut-over date (its reset step; the full wipe needs an empty
 *   database, see demoData.integration.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import {
  OPENING_THROUGH_LOCK_ACTION,
  peekCutoverDate,
  SET_CUTOVER_DATE_ACTION,
} from '../../services/ledger/openingBalance';
import { PERIOD_LOCKED } from '../../utils/periodGuard';
import { resetDerivedBalances } from '../../services/demoData/wipe';
import coaRouter from '../../routes/coa';

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
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const Y = 2152;
const JT = 1_000_000;
let seq = 0;

function asset(tx: Tx) {
  return tx.account.create({
    data: { name: `IT-CUT ${Date.now()}-${++seq}`, accountNumber: `1.97${Date.now() % 100000}${seq}`, accountType: 'ASSET', rootType: 'ASSET' },
  });
}

/** 2152 becomes the earliest open fiscal year and the cut-over date starts empty. */
async function onlyOpenYear(tx: Tx) {
  await tx.fiscalYear.updateMany({ where: { isClosed: false }, data: { isClosed: true } });
  const fy = await createFiscalYear(tx, { year: Y });
  await tx.companySettings.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', companyName: '' } });
  await tx.$executeRaw`UPDATE company_settings SET cutover_date = NULL WHERE slug = 'default'`;
  return fy;
}

async function storedCutover(tx: Tx): Promise<string | null> {
  const rows = await tx.$queryRaw<{ d: string | null }[]>`SELECT cutover_date::text AS d FROM company_settings WHERE slug = 'default'`;
  return rows[0]?.d ?? null;
}

const cutoverAudits = (tx: Tx, userId: string) => tx.auditLog.count({ where: { action: SET_CUTOVER_DATE_ACTION, userId } });

d('cut-over date', () => {
  it('is stored by the first posting, not by reading, with one audit row, and survives the year close', async () => {
    await inRollback(async (tx) => {
      const fy = await onlyOpenYear(tx);
      const user = await createCapUser(tx, []);
      const kas = await asset(tx);
      const kas2 = await asset(tx);

      for (let i = 0; i < 2; i++) {
        expect((await callRoute(coaRouter, 'get', '/', { userId: user.userId, role: user.role })).status).toBe(200);
        await expect(peekCutoverDate(tx)).resolves.toEqual({ day: `${Y}-01-01`, stored: false });
      }
      expect(await storedCutover(tx)).toBeNull();
      expect(await cutoverAudits(tx, user.userId)).toBe(0);

      const r = await callRoute(coaRouter, 'patch', '/:id/balance', { ...user, params: { id: kas.id }, body: { balance: 100 * JT } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await storedCutover(tx)).toBe(`${Y}-01-01`);
      expect(await cutoverAudits(tx, user.userId)).toBe(1);

      const again = await callRoute(coaRouter, 'patch', '/:id/balance', { ...user, params: { id: kas2.id }, body: { balance: 50 * JT } });
      expect(again.status).toBe(200);
      expect(await cutoverAudits(tx, user.userId)).toBe(1);

      await tx.fiscalYear.update({ where: { id: fy.id }, data: { isClosed: true, closedAt: new Date() } });
      await expect(peekCutoverDate(tx)).resolves.toEqual({ day: `${Y}-01-01`, stored: true });
    });
  });

  it('refuses a locked cut-over month unless a period.lock holder posts through the lock with a reason', async () => {
    await inRollback(async (tx) => {
      await onlyOpenYear(tx);
      await tx.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, ${`${Y}-01-31`}::date)
        ON CONFLICT (id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      const holder = await createCapUser(tx, ['period.lock']);
      const kas = await asset(tx);

      const locked = await callRoute(coaRouter, 'patch', '/:id/balance', { ...holder, params: { id: kas.id }, body: { balance: 100 * JT } });
      expect(locked.status).toBe(400);
      expect(locked.body.code).toBe(PERIOD_LOCKED);
      expect(await storedCutover(tx)).toBeNull();

      const reason = 'Saldo awal dari laporan auditor 2151';
      const through = await callRoute(coaRouter, 'patch', '/:id/balance', {
        ...holder, params: { id: kas.id }, body: { balance: 100 * JT, throughLock: { reason } },
      });
      expect(through.status, JSON.stringify(through.body)).toBe(200);
      expect(through.body.opening.action).toBe('posted');
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: OPENING_THROUGH_LOCK_ACTION, entityId: kas.id } });
      expect(audit.newValues).toMatchObject({ reason, journalNumber: through.body.opening.journalNumber, asOfDate: `${Y}-01-01` });

      const noRight = await createCapUser(tx, []);
      const denied = await callRoute(coaRouter, 'patch', '/:id/balance', {
        ...noRight, params: { id: kas.id }, body: { balance: 200 * JT, throughLock: { reason } },
      });
      expect(denied.status).toBe(403);
    });
  });

  it('is cleared by deleting demo data', async () => {
    await inRollback(async (tx) => {
      await onlyOpenYear(tx);
      await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${`${Y}-01-01`}::date WHERE slug = 'default'`;
      await resetDerivedBalances(tx);
      expect(await storedCutover(tx)).toBeNull();
    });
  });
});
