/**
 * Integration test: the tax report needs the Reports view right (E7-R10, G-64).
 *
 * GET /api/tax/report sits under the settings reference-data mount, whose GETs are open to every
 * signed-in user, so the report route carries its own requirePerm('reports'). A role without that
 * right gets 403; a role with Reports view gets the same report as a super-admin. The tax config
 * list stays open: the settings tax tab and invoice forms read it.
 * Route handlers run against a rollback transaction (lib/prisma is swapped for it), in a far
 * future year (2190) so existing invoices cannot fall into the report range.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import taxRouter from '../../routes/tax';

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

const Y = 2190;
const RANGE = { startDate: `${Y}-10-01`, endDate: `${Y}-10-31` };
const tag = () => Math.random().toString(36).slice(2, 8);

/** A super-admin role and user, the way the built-in Admin resolves (CI has no built-in roles). */
async function createSuperAdmin(tx: Tx): Promise<{ userId: string; role: string }> {
  const key = `it-super-${tag()}`;
  await tx.role.create({ data: { key, name: `Uji ${key}`, isSuperAdmin: true } });
  const user = await tx.user.create({
    data: { username: key, fullName: `Uji ${key}`, email: `${key}@test.invalid`, passwordHash: '-', role: key },
  });
  invalidatePermissionCache();
  return { userId: user.id, role: key };
}

/** A Submitted sales invoice of 111 and purchase invoice of 222, both PPN 11% (tax-inclusive). */
async function invoices(tx: Tx, createdBy: string) {
  const fy = await createFiscalYear(tx, { year: Y });
  const customer = await tx.party.create({ data: { name: `IT-TAX Customer ${tag()}`, partyType: 'Customer' } });
  const supplier = await tx.party.create({ data: { name: `IT-TAX Supplier ${tag()}`, partyType: 'Supplier' } });
  const common = { date: new Date(`${Y}-10-15`), status: 'Submitted' as const, taxPct: 11, fiscalYearId: fy.id, createdBy };
  await tx.salesInvoice.create({
    data: { ...common, invoiceNumber: `IT-TAX-SI-${tag()}`, partyId: customer.id, grandTotal: 111, outstanding: 111 },
  });
  await tx.purchaseInvoice.create({
    data: { ...common, invoiceNumber: `IT-TAX-PI-${tag()}`, partyId: supplier.id, grandTotal: 222, outstanding: 222 },
  });
}

const report = (who: { userId: string; role: string }) =>
  callRoute(taxRouter, 'get', '/report', { query: RANGE, ...who });

d('tax report access', () => {
  it('a role without the Reports right gets 403 and no report', async () => {
    await inRollback(async (tx) => {
      const staff = await createCapUser(tx, [], { perms: { inventory: 'edit' } });
      await invoices(tx, staff.userId);

      const r = await report(staff);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'Akses ditolak: Tidak memiliki izin.' });
    });
  });

  it('a role with Reports view gets the report: output 11, input 22, net -11', async () => {
    await inRollback(async (tx) => {
      const viewer = await createCapUser(tx, [], { perms: { reports: 'view' } });
      await invoices(tx, viewer.userId);

      const r = await report(viewer);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({
        months: [{ month: `${Y}-10`, ppnKeluaran: 11, ppnMasukan: 22, pph: 0, net: -11 }],
        totals: { ppnKeluaran: 11, ppnMasukan: 22, pph: 0, net: -11 },
      });
    });
  });

  it('a super-admin and a Reports viewer get the same body for the same range', async () => {
    await inRollback(async (tx) => {
      const admin = await createSuperAdmin(tx);
      const viewer = await createCapUser(tx, [], { perms: { reports: 'view' } });
      await invoices(tx, admin.userId);

      const asAdmin = await report(admin);
      const asViewer = await report(viewer);
      expect(asAdmin.status).toBe(200);
      expect(asViewer.status).toBe(200);
      expect(asViewer.body).toEqual(asAdmin.body);
      expect(asAdmin.body.totals).toEqual({ ppnKeluaran: 11, ppnMasukan: 22, pph: 0, net: -11 });
    });
  });

  it('the tax config list stays open to a role without the Reports right', async () => {
    await inRollback(async (tx) => {
      const staff = await createCapUser(tx, []);
      const config = await tx.taxConfig.create({ data: { name: `IT-TAX PPN ${tag()}`, rate: 11, type: 'sales' } });

      const r = await callRoute(taxRouter, 'get', '/config', staff);
      expect(r.status).toBe(200);
      expect(r.body.map((c: { id: string }) => c.id)).toContain(config.id);
    });
  });
});
