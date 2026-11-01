/**
 * Integration test: atomic claim of approval decisions (E7-R1, M-26 / G-55).
 *
 * - A draft production run (GKP 10.000 kg x 6.000) approved twice at once: one 200 and one 409
 *   STALE_STATUS; one run, GKP stock down 10.000 kg once, one 60 jt production journal, the draft
 *   Posted with that run, and the request points at it.
 * - A service purchase invoice (10 jt + PPN 11%) approved twice at once: one invoice, payables up
 *   11,1 jt once.
 * - Approve racing reject, in both orders: whichever claims first wins; a request never ends
 *   Rejected while its document exists, and a rejected draft goes back to Draft.
 * - An approval whose execution fails (period locked) stays Pending with nothing moved, and can be
 *   approved once the lock is lifted.
 *
 * The races need committed rows on two connections, so fixtures are created for real in fiscal
 * year 2196 and deleted after. The first decision is held open before commit while the second one
 * starts, so the second always reads the stale Pending row and has to wait for the row lock.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FiscalYear } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';
import { systemAccountNumber } from '../helpers/systemAccountNumbers';

const state = vi.hoisted(() => ({
  client: null as PrismaClient | null,
  /** Runs once, at the end of the next decision transaction, before it commits. */
  beforeCommit: null as null | (() => Promise<void>),
}));

// Real client per `$transaction` (its own connection, as in production), not the rollback harness.
vi.mock('../../lib/prisma', () => ({
  prisma: new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const client = state.client;
      if (!client) throw new Error('approvalClaim test: no client');
      if (key === '$transaction') {
        return (fn: (t: Tx) => Promise<unknown>, opts?: { timeout?: number }) =>
          client.$transaction(async (t) => {
            const result = await fn(t as Tx);
            const hook = state.beforeCommit;
            state.beforeCommit = null;
            if (hook) await hook();
            return result;
          }, opts);
      }
      const value = (client as unknown as Record<string, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value;
    },
  }),
}));

import approvalsRouter from '../../routes/approvals';
import { decideApproval, type DecideApprovalResult } from '../../services/approvalDecision';
import { invalidatePermissionCache } from '../../services/permissionService';
import { PERIOD_LOCKED } from '../../utils/periodGuard';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const Y = 2196;
const DAY = `${Y}-05-10`;

let prisma: PrismaClient;
let pool: Pool;
let warehouseId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  state.client = prisma;
  const wh = await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!wh) throw new Error('No active warehouse.');
  warehouseId = wh.id;
});

afterAll(async () => {
  state.client = null;
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const num = (v: unknown) => Number(v);

/** Holds the next decision transaction open before commit; `applied` resolves once it got there. */
function holdNextCommit() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let markApplied!: () => void;
  const applied = new Promise<void>((r) => { markApplied = r; });
  state.beforeCommit = async () => {
    markApplied();
    await held;
  };
  return { applied, release };
}

/** Reports whether `p` is still unsettled after `ms`: the second decision must be waiting. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

/**
 * Committed fixture: fiscal year 2196, a requester without capabilities and a separate approver
 * holding approval.decide (approving one's own request stays possible today, but the test must
 * not depend on it). `cleanup` deletes everything created in the year and restores account balances.
 */
async function seedBase() {
  const fy = await createFiscalYear(prisma as unknown as Tx, { year: Y });
  const requester = await createCapUser(prisma as unknown as Tx, []);
  const approver = await createCapUser(prisma as unknown as Tx, ['approval.decide']);
  const balances = await prisma.account.findMany({ select: { id: true, balance: true } });
  const extra: Array<() => Promise<unknown>> = [];
  const cleanup = async () => {
    state.beforeCommit = null;
    await purgeYear(fy);
    for (const fn of extra.reverse()) await fn();
    const now = await prisma.account.findMany({ select: { id: true, balance: true } });
    const before = new Map(balances.map((b) => [b.id, b.balance.toString()]));
    for (const acc of now) {
      const old = before.get(acc.id);
      if (old !== undefined && old !== acc.balance.toString()) await prisma.account.update({ where: { id: acc.id }, data: { balance: old } });
    }
    await prisma.notification.deleteMany({ where: { userId: { in: [requester.userId, approver.userId] } } });
    for (const u of [requester, approver]) {
      await prisma.user.delete({ where: { id: u.userId } });
      await prisma.role.delete({ where: { key: u.role } });
    }
    await prisma.fiscalYear.delete({ where: { id: fy.id } });
    invalidatePermissionCache();
  };
  return { fy, requester, approver, onCleanup: (fn: () => Promise<unknown>) => extra.push(fn), cleanup };
}

/** Deletes every document, movement and journal of the test year (children cascade). */
async function purgeYear(fy: FiscalYear) {
  await prisma.accountingLedgerEntry.deleteMany({ where: { fiscalYearId: fy.id } });
  await prisma.journalEntry.deleteMany({ where: { fiscalYearId: fy.id } });
  await prisma.stockMovement.deleteMany({ where: { fiscalYearId: fy.id } });
  await prisma.productionRun.deleteMany({ where: { fiscalYearId: fy.id } });
  await prisma.purchaseInvoice.deleteMany({ where: { fiscalYearId: fy.id } });
}

/** GKP 10.000 kg @ 6.000 in stock, an empty Beras item, and a production draft queued for approval. */
async function seedProductionRequest(base: Awaited<ReturnType<typeof seedBase>>) {
  const gkp = await prisma.inventoryItem.create({
    data: { code: `IT-E7R1-GKP-${tag()}`, name: `Uji GKP ${tag()}`, unit: 'kg', currentStock: 10_000, averageCost: 6_000, isActive: true },
  });
  await prisma.inventoryStock.create({ data: { itemId: gkp.id, warehouseId, currentStock: 10_000 } });
  const beras = await prisma.inventoryItem.create({
    data: { code: `IT-E7R1-BRS-${tag()}`, name: `Uji Beras ${tag()}`, unit: 'kg', currentStock: 0, averageCost: 0, isActive: true },
  });
  const payload = {
    date: DAY,
    warehouseId,
    inputs: [{ itemId: gkp.id, quantity: 10_000 }],
    outputs: [{ itemId: beras.id, quantity: 6_000 }],
  };
  const request = await prisma.approvalRequest.create({
    data: { documentType: 'ProductionRun', payload, amount: 10_000, requestedBy: base.requester.userId, status: 'Pending' },
  });
  const draft = await prisma.productionRunDraft.create({
    data: {
      draftNumber: `DPR-E7R1-${tag()}`, date: new Date(DAY), payload, status: 'PendingApproval',
      createdById: base.requester.userId, approvalRequestId: request.id,
    },
  });
  base.onCleanup(async () => {
    await prisma.productionRunDraft.delete({ where: { id: draft.id } });
    await prisma.approvalRequest.delete({ where: { id: request.id } });
    await prisma.inventoryStock.deleteMany({ where: { itemId: { in: [gkp.id, beras.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: [gkp.id, beras.id] } } });
  });
  return { gkp, beras, request, draft };
}

const stockOf = async (itemId: string) => num((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).currentStock);
const runsOf = (fy: FiscalYear) => prisma.productionRun.findMany({ where: { fiscalYearId: fy.id } });

async function journalTotal(entryNumber: string): Promise<number> {
  const je = await prisma.journalEntry.findUniqueOrThrow({ where: { entryNumber }, include: { items: true } });
  return je.items.reduce((s, i) => s + num(i.debit), 0);
}

const decide = (requestId: string, action: 'approve' | 'reject', actorUserId: string): Promise<DecideApprovalResult> =>
  decideApproval({ requestId, action, actorUserId, note: action === 'reject' ? 'Data keliru' : undefined });

d('production draft approved twice at once', () => {
  it('one 200 and one 409 STALE_STATUS; one run, stock down once, one 60 jt journal', async () => {
    const base = await seedBase();
    try {
      const { gkp, request, draft } = await seedProductionRequest(base);
      const { applied, release } = holdNextCommit();
      const first = callRoute(approvalsRouter, 'post', '/requests/:id/approve', { params: { id: request.id }, ...base.approver });
      await applied;
      const second = callRoute(approvalsRouter, 'post', '/requests/:id/approve', { params: { id: request.id }, ...base.approver });
      expect(await stillPending(second)).toBe(true);

      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(b).toEqual({ status: 409, body: { error: 'Pengajuan sudah diproses.', code: 'STALE_STATUS' } });

      const runs = await runsOf(base.fy);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(a.body).toMatchObject({ ok: true, status: 'Approved', docNumber: run.runNumber });
      expect(await stockOf(gkp.id)).toBe(0);
      expect(await prisma.journalEntry.count({ where: { fiscalYearId: base.fy.id } })).toBe(1);
      expect(await journalTotal(`JV-${run.runNumber}`)).toBe(60_000_000);
      expect(await prisma.productionRunDraft.findUniqueOrThrow({ where: { id: draft.id } }))
        .toMatchObject({ status: 'Posted', postedRunId: run.id, postedById: base.approver.userId });
      expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .toMatchObject({ status: 'Approved', approvedBy: base.approver.userId, documentId: run.id, documentNumber: run.runNumber });
    } finally {
      await base.cleanup();
    }
  });
});

d('service purchase invoice approved twice at once', () => {
  it('one invoice; payables up 11,1 jt once', async () => {
    const base = await seedBase();
    const supplier = await prisma.party.create({ data: { name: `IT-E7R1-Supplier-${tag()}`, partyType: 'Supplier', isActive: true } });
    base.onCleanup(() => prisma.party.delete({ where: { id: supplier.id } }));
    const ap = await prisma.account.findFirstOrThrow({ where: { accountNumber: await systemAccountNumber(prisma, 'AP') } });
    try {
      const request = await prisma.approvalRequest.create({
        data: {
          documentType: 'PurchaseInvoice',
          amount: 10_000_000,
          requestedBy: base.requester.userId,
          status: 'Pending',
          payload: { date: DAY, partyId: supplier.id, items: [{ itemName: 'Jasa angkut gabah', quantity: 1, unit: 'trip', rate: 10_000_000, taxPct: 11 }] },
        },
      });
      base.onCleanup(() => prisma.approvalRequest.delete({ where: { id: request.id } }));
      const apBefore = num((await prisma.account.findUniqueOrThrow({ where: { id: ap.id } })).balance);

      const { applied, release } = holdNextCommit();
      const first = decide(request.id, 'approve', base.approver.userId);
      await applied;
      const second = decide(request.id, 'approve', base.approver.userId);
      expect(await stillPending(second)).toBe(true);
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(a).toMatchObject({ ok: true, status: 'Approved' });
      expect(b).toEqual({ ok: false, error: 'Pengajuan sudah diproses.', code: 'STALE_STATUS' });
      const invoices = await prisma.purchaseInvoice.findMany({ where: { fiscalYearId: base.fy.id } });
      expect(invoices).toHaveLength(1);
      expect(num(invoices[0]!.grandTotal)).toBe(11_100_000);
      expect(num((await prisma.account.findUniqueOrThrow({ where: { id: ap.id } })).balance)).toBe(apBefore + 11_100_000);
      expect(num((await prisma.party.findUniqueOrThrow({ where: { id: supplier.id } })).outstandingAmount)).toBe(11_100_000);
    } finally {
      await base.cleanup();
    }
  });
});

d('approve racing reject', () => {
  it('approve first: reject gets STALE_STATUS; Approved with its run, never Rejected', async () => {
    const base = await seedBase();
    try {
      const { request, draft } = await seedProductionRequest(base);
      const { applied, release } = holdNextCommit();
      const approve = decide(request.id, 'approve', base.approver.userId);
      await applied;
      const reject = decide(request.id, 'reject', base.approver.userId);
      expect(await stillPending(reject)).toBe(true);
      release();

      expect(await approve).toMatchObject({ ok: true, status: 'Approved' });
      expect(await reject).toMatchObject({ ok: false, code: 'STALE_STATUS' });
      const runs = await runsOf(base.fy);
      expect(runs).toHaveLength(1);
      expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .toMatchObject({ status: 'Approved', rejectedBy: null, documentId: runs[0]!.id });
      expect((await prisma.productionRunDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('Posted');
    } finally {
      await base.cleanup();
    }
  });

  it('reject first: approve gets STALE_STATUS; Rejected, no run, the draft back to Draft', async () => {
    const base = await seedBase();
    try {
      const { gkp, request, draft } = await seedProductionRequest(base);
      const { applied, release } = holdNextCommit();
      const reject = decide(request.id, 'reject', base.approver.userId);
      await applied;
      const approve = decide(request.id, 'approve', base.approver.userId);
      expect(await stillPending(approve)).toBe(true);
      release();

      expect(await reject).toMatchObject({ ok: true, status: 'Rejected' });
      expect(await approve).toMatchObject({ ok: false, code: 'STALE_STATUS' });
      expect(await runsOf(base.fy)).toHaveLength(0);
      expect(await stockOf(gkp.id)).toBe(10_000);
      expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .toMatchObject({ status: 'Rejected', approvedBy: null, documentId: null });
      expect(await prisma.productionRunDraft.findUniqueOrThrow({ where: { id: draft.id } }))
        .toMatchObject({ status: 'Draft', approvalRequestId: null, lastError: 'Ditolak: Data keliru' });
    } finally {
      await base.cleanup();
    }
  });
});

d('approval whose execution fails', () => {
  it('stays Pending with nothing moved while the period is locked, and approves once it is lifted', async () => {
    const base = await seedBase();
    const [lock] = await prisma.$queryRaw<{ lock_date: string | null }[]>`SELECT lock_date::text AS lock_date FROM period_lock WHERE id = 1`;
    const restoreLock = () => prisma.$executeRaw`UPDATE period_lock SET lock_date = ${lock?.lock_date ?? null}::date WHERE id = 1`;
    try {
      const { gkp, request, draft } = await seedProductionRequest(base);
      if (!lock) await prisma.$executeRaw`INSERT INTO period_lock (id, lock_date) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`;
      await prisma.$executeRaw`UPDATE period_lock SET lock_date = ${`${Y}-12-31`}::date WHERE id = 1`;

      const failed = await decide(request.id, 'approve', base.approver.userId);
      expect(failed).toMatchObject({ ok: false, code: PERIOD_LOCKED });
      expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .toMatchObject({ status: 'Pending', approvedBy: null, decidedAt: null, documentId: null });
      expect(await runsOf(base.fy)).toHaveLength(0);
      expect(await stockOf(gkp.id)).toBe(10_000);
      expect(await prisma.journalEntry.count({ where: { fiscalYearId: base.fy.id } })).toBe(0);
      expect((await prisma.productionRunDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('PendingApproval');

      await restoreLock();
      const ok = await decide(request.id, 'approve', base.approver.userId);
      expect(ok).toMatchObject({ ok: true, status: 'Approved' });
      expect(await runsOf(base.fy)).toHaveLength(1);
      expect(await stockOf(gkp.id)).toBe(0);
    } finally {
      try {
        await restoreLock();
      } finally {
        await base.cleanup();
      }
    }
  });
});
