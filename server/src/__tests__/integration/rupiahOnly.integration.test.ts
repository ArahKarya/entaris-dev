/**
 * Integration test: bookkeeping is rupiah only (E2-R7, G-89).
 *
 * PUT /api/settings/company rejects a foreign currency, always stores IDR (so an old USD row is
 * normalised by the next save) and keeps its full-upsert contract for the fiscal start month.
 * The core of scripts/repair/e2-rupiah-only-check.ts lists non-IDR rows on a dry run and, with
 * the accountant's name, sets them to IDR.
 * Route handlers run against a rollback transaction (lib/prisma is swapped for it); no fiscal year
 * is needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import settingsRouter from '../../routes/settings';
import { applyRupiahOnlyFixes, planRupiahOnlyFixes } from '../../services/rupiahOnlyRepair';

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

/** Runs fn in a transaction that is always rolled back, with route handlers bound to it. */
async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 30000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => Math.random().toString(36).slice(2, 8);

/** The default settings row as it is before the call, created when the CI database has none. */
async function seedSettings(tx: Tx, data: { defaultCurrency: string; fiscalYearStartMonth?: number }) {
  return tx.companySettings.upsert({
    where: { slug: 'default' },
    update: data,
    create: { slug: 'default', companyName: 'PT Uji Rupiah', ...data },
  });
}

const putCompany = (actor: { userId: string; role: string }, body: Record<string, unknown>) =>
  callRoute(settingsRouter, 'put', '/company', { ...actor, body });

d('PUT /settings/company is rupiah only', () => {
  it('rejects USD with 400 and leaves the row unchanged', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, [], { perms: { settings: 'edit' } });
      await seedSettings(tx, { defaultCurrency: 'IDR', fiscalYearStartMonth: 7 });

      for (const body of [{ companyName: 'PT Uji', defaultCurrency: 'USD' }, { companyName: 'PT Uji', currency: 'usd' }]) {
        const r = await putCompany(actor, body);
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: 'Mata uang perusahaan hanya IDR (pembukuan hanya rupiah).' });
      }
      const row = await tx.companySettings.findUniqueOrThrow({ where: { slug: 'default' } });
      expect(row.defaultCurrency).toBe('IDR');
      expect(row.fiscalYearStartMonth).toBe(7);
    });
  });

  it('normalises an old USD row to IDR on a save without currency', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, [], { perms: { settings: 'edit' } });
      await seedSettings(tx, { defaultCurrency: 'USD' });

      const r = await putCompany(actor, { companyName: 'PT Uji' });
      expect(r.status).toBe(200);
      expect(r.body.defaultCurrency).toBe('IDR');
      const row = await tx.companySettings.findUniqueOrThrow({ where: { slug: 'default' } });
      expect(row.defaultCurrency).toBe('IDR');
    });
  });

  it('accepts IDR in any case', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, [], { perms: { settings: 'edit' } });
      await seedSettings(tx, { defaultCurrency: 'IDR' });

      for (const defaultCurrency of ['IDR', 'idr']) {
        const r = await putCompany(actor, { companyName: 'PT Uji', defaultCurrency });
        expect(r.status).toBe(200);
        expect(r.body.defaultCurrency).toBe('IDR');
      }
    });
  });

  it('stays a full upsert: the sent fiscal start month is stored, a missing one falls back to 1', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, [], { perms: { settings: 'edit' } });
      await seedSettings(tx, { defaultCurrency: 'IDR', fiscalYearStartMonth: 1 });

      const sent = await putCompany(actor, { companyName: 'PT Uji', fiscalYearStartMonth: 4 });
      expect(sent.status).toBe(200);
      expect((await tx.companySettings.findUniqueOrThrow({ where: { slug: 'default' } })).fiscalYearStartMonth).toBe(4);

      const omitted = await putCompany(actor, { companyName: 'PT Uji' });
      expect(omitted.status).toBe(200);
      expect((await tx.companySettings.findUniqueOrThrow({ where: { slug: 'default' } })).fiscalYearStartMonth).toBe(1);
    });
  });

  it('refuses a role without the settings edit right', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, [], { perms: { settings: 'view' } });
      const r = await putCompany(actor, { companyName: 'PT Uji' });
      expect(r.status).toBe(403);
    });
  });
});

d('e2-rupiah-only-check core', () => {
  it('lists non-IDR rows on a dry run and sets them to IDR with the accountant name', async () => {
    await inRollback(async (tx) => {
      const usd = await tx.account.create({
        data: { accountNumber: `9.99.${tag()}`, name: 'Kas Valas Uji', accountType: 'ASSET', rootType: 'ASSET', currency: 'USD' },
      });
      const idr = await tx.account.create({
        data: { accountNumber: `9.99.${tag()}`, name: 'Kas Rupiah Uji', accountType: 'ASSET', rootType: 'ASSET' },
      });
      const settings = await seedSettings(tx, { defaultCurrency: 'SGD' });

      const plan = await planRupiahOnlyFixes(tx);
      expect(plan).toEqual(expect.arrayContaining([
        { table: 'accounts', id: usd.id, label: `${usd.accountNumber} Kas Valas Uji`, currency: 'USD' },
        { table: 'company_settings', id: settings.id, label: 'default', currency: 'SGD' },
      ]));
      expect(plan.some((r) => r.id === idr.id)).toBe(false);
      // The dry run writes nothing.
      expect((await tx.account.findUniqueOrThrow({ where: { id: usd.id } })).currency).toBe('USD');

      await expect(applyRupiahOnlyFixes(tx, plan, '  ')).rejects.toThrow('--apply needs --approved-by');
      expect((await tx.account.findUniqueOrThrow({ where: { id: usd.id } })).currency).toBe('USD');

      // A row changed after the plan is skipped, not overwritten.
      const stale = plan.map((r) => (r.id === settings.id ? { ...r, currency: 'EUR' } : r));
      const result = await applyRupiahOnlyFixes(tx, stale, ' Siti Akuntan ');
      expect(result.approvedBy).toBe('Siti Akuntan');
      expect(result.applied).toContain(usd.id);
      expect(result.skipped).toEqual([settings.id]);
      expect((await tx.account.findUniqueOrThrow({ where: { id: usd.id } })).currency).toBe('IDR');
      expect((await tx.companySettings.findUniqueOrThrow({ where: { id: settings.id } })).defaultCurrency).toBe('SGD');

      const after = await applyRupiahOnlyFixes(tx, await planRupiahOnlyFixes(tx), 'Siti Akuntan');
      expect(after.applied).toContain(settings.id);
      expect(await planRupiahOnlyFixes(tx)).toEqual([]);
    });
  });
});
