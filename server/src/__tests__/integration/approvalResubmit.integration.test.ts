/**
 * Integration test: PUT /approvals/requests/:id/resubmit after the handler moved to
 * services/approvalResubmit.ts (PR-3.0, pure refactor). It pins the route's answers as they were:
 * - unknown request 404; someone else's request without approval.view_all 403;
 * - only NeedsRevision can be resubmitted; a missing payload, an unsupported document type and an
 *   invalid payload are 400 with the old messages, and leave the request untouched;
 * - a purchase invoice goes back to Pending with the raw payload stored and amount = the invoice
 *   grand total (PR-3.5; it was biayaLain alone before); a production run with amount = Σ input
 *   quantity, also when resubmitted by a holder of approval.view_all.
 *
 * No fiscal year: resubmit checks no period. Route handlers run through the route harness;
 * everything runs in a rollback transaction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type RouteResult, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import approvalsRouter from '../../routes/approvals';

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

type Actor = { userId: string; role: string };

const piPayload = (over: Record<string, unknown> = {}) => ({
  date: '2026-05-04',
  partyId: 'p-it-resubmit',
  items: [
    { itemName: 'Gabah Kering Panen', quantity: 1000, rate: 6500, amount: 6_500_000 },
    { itemName: 'Ongkos bongkar', itemType: 'service', quantity: 1, rate: 150000, amount: 150000 },
  ],
  biayaLain: -25000,
  ...over,
});

const prodPayload = () => ({
  date: '2026-05-04',
  inputs: [{ itemId: 'in-1', quantity: '1000' }, { itemId: 'in-2', quantity: 250 }],
  outputs: [{ itemId: 'out-1', quantity: 700 }],
});

/** A request in `status` owned by `owner`, rejected earlier by `rejecter`. */
async function request(tx: Tx, owner: Actor, rejecter: Actor, over: { documentType?: string; status?: string } = {}) {
  return tx.approvalRequest.create({
    data: {
      documentType: over.documentType ?? 'PurchaseInvoice',
      status: over.status ?? 'NeedsRevision',
      amount: 999,
      payload: { old: true },
      requestedBy: owner.userId,
      rejectedBy: rejecter.userId,
      decidedAt: new Date('2026-05-03T03:00:00Z'),
    },
  });
}

function resubmit(id: string, who: Actor, body: unknown): Promise<RouteResult> {
  return callRoute(approvalsRouter, 'put', '/requests/:id/resubmit', { params: { id }, body, userId: who.userId, role: who.role });
}

/** The request still has its pre-resubmit state. */
async function expectUntouched(tx: Tx, id: string, status = 'NeedsRevision') {
  const row = await tx.approvalRequest.findUniqueOrThrow({ where: { id } });
  expect(row.status).toBe(status);
  expect(Number(row.amount)).toBe(999);
  expect(row.payload).toEqual({ old: true });
  expect(row.rejectedBy).not.toBeNull();
}

d('PUT /approvals/requests/:id/resubmit', () => {
  it('answers 404 for an unknown request', async () => {
    await inRollback(async (tx) => {
      const owner = await createCapUser(tx, []);
      const r = await resubmit('00000000-0000-4000-8000-000000000000', owner, { payload: piPayload() });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: 'Request tidak ditemukan.' });
    });
  });

  it("refuses someone else's request without approval.view_all", async () => {
    await inRollback(async (tx) => {
      const owner = await createCapUser(tx, []);
      const other = await createCapUser(tx, []);
      const approver = await createCapUser(tx, ['approval.decide']);
      const req = await request(tx, owner, approver);
      const r = await resubmit(req.id, other, { payload: piPayload() });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'Bukan pengajuan Anda.' });
      await expectUntouched(tx, req.id);
    });
  });

  it('only resubmits a request in NeedsRevision', async () => {
    await inRollback(async (tx) => {
      const owner = await createCapUser(tx, []);
      const approver = await createCapUser(tx, ['approval.decide']);
      const req = await request(tx, owner, approver, { status: 'Rejected' });
      const r = await resubmit(req.id, owner, { payload: piPayload() });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Hanya pengajuan berstatus Perlu Revisi yang dapat diajukan ulang.' });
      await expectUntouched(tx, req.id, 'Rejected');
    });
  });

  it('refuses a missing payload, an unsupported type and an invalid payload', async () => {
    await inRollback(async (tx) => {
      const owner = await createCapUser(tx, []);
      const approver = await createCapUser(tx, ['approval.decide']);

      const pi = await request(tx, owner, approver);
      const noPayload = await resubmit(pi.id, owner, {});
      expect(noPayload.status).toBe(400);
      expect(noPayload.body).toEqual({ error: 'Payload tidak valid.' });

      const invalid = await resubmit(pi.id, owner, { payload: piPayload({ items: [] }) });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ error: 'Data invoice tidak valid: Minimal satu item.' });
      await expectUntouched(tx, pi.id);

      const run = await request(tx, owner, approver, { documentType: 'ProductionRun' });
      const badRun = await resubmit(run.id, owner, { payload: { ...prodPayload(), inputs: [{ itemId: 'in-1', quantity: 0 }] } });
      expect(badRun.status).toBe(400);
      expect(badRun.body).toEqual({ error: 'Data produksi tidak valid: Kuantitas harus lebih dari 0.' });
      await expectUntouched(tx, run.id);

      const dor = await request(tx, owner, approver, { documentType: 'DeliveryOrder' });
      const unsupported = await resubmit(dor.id, owner, { payload: piPayload() });
      expect(unsupported.status).toBe(400);
      expect(unsupported.body).toEqual({ error: 'Tipe dokumen tidak didukung.' });
      await expectUntouched(tx, dor.id);
    });
  });

  it('puts a purchase invoice back to Pending with the raw payload; amount = invoice grand total', async () => {
    await inRollback(async (tx) => {
      const owner = await createCapUser(tx, []);
      const approver = await createCapUser(tx, ['approval.decide']);
      const req = await request(tx, owner, approver);
      const payload = piPayload();

      const r = await resubmit(req.id, owner, { payload });
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(req.id);

      const row = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(row.status).toBe('Pending');
      expect(Number(row.amount)).toBe(6_625_000); // 6.500.000 + 150.000 - 25.000
      expect(row.payload).toEqual(payload);
      expect(row.rejectedBy).toBeNull();
      expect(row.decidedAt).toBeNull();
      expect(row.requestedBy).toBe(owner.userId);
    });
  });

  it('lets a holder of approval.view_all resubmit a production run; amount = Σ input quantity', async () => {
    await inRollback(async (tx) => {
      const owner = await createCapUser(tx, []);
      const approver = await createCapUser(tx, ['approval.decide']);
      const supervisor = await createCapUser(tx, ['approval.view_all']);
      const req = await request(tx, owner, approver, { documentType: 'ProductionRun' });

      const r = await resubmit(req.id, supervisor, { payload: prodPayload() });
      expect(r.status).toBe(200);

      const row = await tx.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(row.status).toBe('Pending');
      expect(Number(row.amount)).toBe(1250);
      expect(row.payload).toEqual(prodPayload());
      expect(row.rejectedBy).toBeNull();
      expect(row.decidedAt).toBeNull();
    });
  });
});
