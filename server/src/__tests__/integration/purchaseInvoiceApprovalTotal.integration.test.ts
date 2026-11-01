/**
 * Integration test (E5-R1): the purchase invoice approval queue carries the invoice grand total.
 * - POST /purchase/invoices by a role without approval.bypass queues the request with
 *   amount = Σ line totals (potongan per line deducted) + biayaLain; a header potongan the lines
 *   do not carry is refused (400) and nothing is queued;
 * - revise then resubmit keeps that amount (it used to drop to biayaLain alone);
 * - the request context returns piTotals computed by the posting formula;
 * - approve posts an invoice whose grandTotal equals the queued amount.
 *
 * Fixture year 2195 (unique per file, plan §5.2). Route handlers run through the route harness;
 * everything runs in a rollback transaction.
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
vi.mock('../../services/notificationService', () => ({ notifyAdmins: vi.fn(), notifyUsers: vi.fn() }));

import { invalidatePermissionCache } from '../../services/permissionService';
import purchaseRouter from '../../routes/purchase';
import approvalsRouter from '../../routes/approvals';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2195;

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

/** Service lines (no stock): 6.400.000 after a 100.000 line potongan + 3.600.000 = 10.000.000. */
function payload(partyId: string, over: Record<string, unknown> = {}) {
  return {
    date: `${YEAR}-03-10`,
    partyId,
    items: [
      { itemName: 'Jasa giling (uji)', itemType: 'service', quantity: 1000, rate: 6500, potonganItem: 100_000 },
      { itemName: 'Jasa angkut (uji)', itemType: 'service', quantity: 1, rate: 3_600_000 },
    ],
    ...over,
  };
}

async function fixture(tx: Tx) {
  await createFiscalYear(tx, { year: YEAR });
  const party = await tx.party.create({
    data: { name: `IT-E5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, partyType: 'Supplier', isActive: true },
  });
  const requester = await createCapUser(tx, []);
  const approver = await createCapUser(tx, ['approval.decide', 'approval.view_all']);
  return { party, requester, approver };
}

d('purchase invoice approval total', () => {
  it('refuses a header potongan the lines do not carry and queues nothing', async () => {
    await inRollback(async (tx) => {
      const { party, requester } = await fixture(tx);
      const r = await callRoute(purchaseRouter, 'post', '/', {
        body: payload(party.id, { items: [{ itemName: 'Jasa (uji)', itemType: 'service', quantity: 1, rate: 10_000_000 }], potongan: 500_000 }),
        ...requester,
      });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Potongan header harus sama dengan jumlah potongan per baris. Isi potongan di baris item.' });
      expect(await tx.approvalRequest.count({ where: { requestedBy: requester.userId } })).toBe(0);
    });
  });

  it('queues the grand total, keeps it through revise + resubmit, and approve posts the same total', async () => {
    await inRollback(async (tx) => {
      const { party, requester, approver } = await fixture(tx);

      const created = await callRoute(purchaseRouter, 'post', '/', { body: payload(party.id), ...requester });
      expect(created.status).toBe(202);
      const requestId: string = created.body.request.id;
      const queued = await tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(Number(queued.amount)).toBe(10_000_000);

      const ctx = await callRoute(approvalsRouter, 'get', '/requests/:id/context', { params: { id: requestId }, ...approver });
      expect(ctx.status).toBe(200);
      expect(ctx.body.piTotals).toEqual({
        subtotal: 10_000_000,
        potonganItem: 100_000,
        biayaLain: 0,
        grandTotal: 10_000_000,
        headerPotonganMismatch: false,
      });

      const revise = await callRoute(approvalsRouter, 'post', '/requests/:id/request-revision', {
        params: { id: requestId }, body: { notes: 'Tambah biaya bongkar' }, ...approver,
      });
      expect(revise.status).toBe(200);
      const resubmitted = await callRoute(approvalsRouter, 'put', '/requests/:id/resubmit', {
        params: { id: requestId }, body: { payload: payload(party.id, { biayaLain: 150_000, potongan: 100_000 }) }, ...requester,
      });
      expect(resubmitted.status).toBe(200);
      const pending = await tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(pending.status).toBe('Pending');
      expect(Number(pending.amount)).toBe(10_150_000);

      const approved = await callRoute(approvalsRouter, 'post', '/requests/:id/approve', { params: { id: requestId }, ...approver });
      expect(approved.status).toBe(200);
      const invoice = await tx.purchaseInvoice.findFirstOrThrow({ where: { partyId: party.id } });
      expect(Number(invoice.grandTotal)).toBe(Number(pending.amount));
      expect(Number(invoice.potongan)).toBe(100_000);
    });
  });

  it('context flags an old queued payload whose header potongan differs, and approve refuses it', async () => {
    await inRollback(async (tx) => {
      const { party, requester, approver } = await fixture(tx);
      const old = await tx.approvalRequest.create({
        data: {
          documentType: 'PurchaseInvoice',
          status: 'Pending',
          amount: 9_500_000,
          payload: payload(party.id, { potongan: 500_000 }),
          requestedBy: requester.userId,
        },
      });

      const ctx = await callRoute(approvalsRouter, 'get', '/requests/:id/context', { params: { id: old.id }, ...approver });
      expect(ctx.body.piTotals).toMatchObject({ grandTotal: 10_000_000, headerPotonganMismatch: true });

      const approved = await callRoute(approvalsRouter, 'post', '/requests/:id/approve', { params: { id: old.id }, ...approver });
      expect(approved.status).toBe(400);
      expect(approved.body.error).toContain('Potongan header harus sama dengan jumlah potongan per baris.');
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('Pending');
      expect(await tx.purchaseInvoice.count({ where: { partyId: party.id } })).toBe(0);
    });
  });

  it('context returns piTotals null for other document types', async () => {
    await inRollback(async (tx) => {
      const { requester, approver } = await fixture(tx);
      const run = await tx.approvalRequest.create({
        data: { documentType: 'ProductionRun', status: 'Pending', amount: 1, payload: { inputs: [] }, requestedBy: requester.userId },
      });
      const ctx = await callRoute(approvalsRouter, 'get', '/requests/:id/context', { params: { id: run.id }, ...approver });
      expect(ctx.status).toBe(200);
      expect(ctx.body.piTotals).toBeNull();
    });
  });
});
