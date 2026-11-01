/**
 * Integration test: core of scripts/repair/e5-pi-approval-amount.ts (services/piApprovalAmountRepair).
 * - the plan lists open purchase invoice requests whose amount is not the grand total (fix), whose
 *   header potongan disagrees with the lines (potonganMismatch) or whose payload no longer parses;
 *   correct requests, decided requests and other document types are not listed;
 * - apply refuses to run without an approver name; with one it changes only `amount` of the fix
 *   rows, leaves the mismatch and invalid rows untouched, and skips a request decided meanwhile;
 *   each corrected request gets one audit row (via 'repair') with the old and new amount and the
 *   approver name, a skipped one gets none.
 *
 * No fiscal year: nothing here posts. Assertions only look at this file's fixture rows (the plan
 * is filtered by request id) since the database may hold other queued requests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { applyPiApprovalAmountFixes, planPiApprovalAmountFixes } from '../../services/piApprovalAmountRepair';

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
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** Grand total 10.000.000 (6.400.000 after a 100.000 line potongan + 3.600.000). */
const piPayload = (over: Record<string, unknown> = {}) => ({
  date: '2026-03-10',
  partyId: 'p-it-e5',
  items: [
    { itemName: 'Gabah (uji)', quantity: 1000, rate: 6500, potonganItem: 100_000 },
    { itemName: 'Jasa angkut (uji)', itemType: 'service', quantity: 1, rate: 3_600_000 },
  ],
  ...over,
});

async function seed(tx: Tx) {
  const owner = await createCapUser(tx, []);
  const make = (status: string, amount: number | null, payload: object, documentType = 'PurchaseInvoice') =>
    tx.approvalRequest.create({ data: { documentType, status, amount, payload, requestedBy: owner.userId } });
  return {
    // Old queue amount: header potongan subtracted a second time.
    doubleCut: await make('Pending', 9_900_000, piPayload({ potongan: 100_000 })),
    // Old resubmit amount: biayaLain alone.
    resubmitted: await make('NeedsRevision', 50_000, piPayload({ biayaLain: 50_000 })),
    correct: await make('Pending', 10_000_000, piPayload()),
    mismatch: await make('Pending', 9_500_000, piPayload({ potongan: 500_000 })),
    invalid: await make('Pending', 1, { date: '2026-03-10', partyId: 'p', items: [] }),
    decided: await make('Approved', 1, piPayload()),
    otherType: await make('Pending', 1, { inputs: [] }, 'ProductionRun'),
  };
}

d('e5-pi-approval-amount core', () => {
  it('plans fixes and manual-look rows for open purchase invoice requests only', async () => {
    await inRollback(async (tx) => {
      const r = await seed(tx);
      const ids = new Set(Object.values(r).map((x) => x.id));
      const plan = (await planPiApprovalAmountFixes(tx)).filter((row) => ids.has(row.requestId));
      const byId = new Map(plan.map((row) => [row.requestId, row]));

      expect(byId.get(r.doubleCut.id)).toMatchObject({ action: 'fix', storedAmount: 9_900_000, computedAmount: 10_000_000 });
      expect(byId.get(r.resubmitted.id)).toMatchObject({ action: 'fix', status: 'NeedsRevision', storedAmount: 50_000, computedAmount: 10_050_000 });
      expect(byId.get(r.mismatch.id)).toMatchObject({
        action: 'potonganMismatch', computedAmount: 10_000_000, headerPotongan: 500_000, potonganItemTotal: 100_000,
      });
      expect(byId.get(r.invalid.id)).toMatchObject({ action: 'invalidPayload', computedAmount: null, error: 'Minimal satu item.' });
      expect(byId.has(r.correct.id)).toBe(false);
      expect(byId.has(r.decided.id)).toBe(false);
      expect(byId.has(r.otherType.id)).toBe(false);
    });
  });

  it('apply needs an approver and changes only the amount of the fix rows', async () => {
    await inRollback(async (tx) => {
      const r = await seed(tx);
      const ids = new Set(Object.values(r).map((x) => x.id));
      const plan = (await planPiApprovalAmountFixes(tx)).filter((row) => ids.has(row.requestId));

      await expect(applyPiApprovalAmountFixes(tx, plan, '  ')).rejects.toThrow('--apply needs --approved-by');
      expect(Number((await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.doubleCut.id } })).amount)).toBe(9_900_000);

      // Decided between the plan and the apply: skipped.
      await tx.approvalRequest.update({ where: { id: r.resubmitted.id }, data: { status: 'Rejected' } });
      const before = await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.doubleCut.id } });

      const result = await applyPiApprovalAmountFixes(tx, plan, ' Siti Akuntan ');
      expect(result).toEqual({ approvedBy: 'Siti Akuntan', applied: [r.doubleCut.id], skipped: [r.resubmitted.id] });

      const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.doubleCut.id } });
      expect(Number(after.amount)).toBe(10_000_000);
      expect({ ...after, amount: null }).toEqual({ ...before, amount: null });
      expect(Number((await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.resubmitted.id } })).amount)).toBe(50_000);
      const mismatch = await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.mismatch.id } });
      expect(Number(mismatch.amount)).toBe(9_500_000);
      expect(mismatch.payload).toEqual(piPayload({ potongan: 500_000 }));
      expect(Number((await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.invalid.id } })).amount)).toBe(1);

      // The approver is recorded in the database, one audit row per corrected request only.
      const audits = await tx.auditLog.findMany({
        where: { entityType: 'ApprovalRequest', entityId: { in: [r.doubleCut.id, r.resubmitted.id] }, via: 'repair' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entityId: r.doubleCut.id,
        userId: r.doubleCut.requestedBy,
        action: 'e5-pi-approval-amount',
        oldValues: { amount: 9_900_000 },
        newValues: { amount: 10_000_000, approvedBy: 'Siti Akuntan' },
        viaMeta: { script: 'e5-pi-approval-amount', approvedBy: 'Siti Akuntan' },
      });

      // A second plan finds nothing left to fix among the fixture rows.
      const again = (await planPiApprovalAmountFixes(tx)).filter((row) => ids.has(row.requestId) && row.action === 'fix');
      expect(again).toEqual([]);
    });
  });
});
