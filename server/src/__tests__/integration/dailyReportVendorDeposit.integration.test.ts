/**
 * Integration test (E5-R2): supplier deposit block of GET /reports/daily.
 * - remaining = amount − active applications − refunds: a cancelled application gives its amount
 *   back, a refund does not (UM 100 jt, refund 20 jt, applied 10 jt cancelled → 80 jt);
 * - a fully refunded deposit is not listed;
 * - every listed row carries totalRefunded, and the summary carries totalRefunded.
 *
 * Fixture year 2182 (unique per file, plan §5.2). The report reads every submitted deposit in the
 * database, so rows are filtered to this file's payment numbers, and the summary is checked for at
 * least the fixture's share and for totalRemaining = Σ listed rows.
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
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import operationalRouter from '../../routes/reports/operational';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2182;

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

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

d('GET /reports/daily supplier deposits', () => {
  it('lists the remaining after refunds and active applications only', async () => {
    await inRollback(async (tx) => {
      const fy = await createFiscalYear(tx, { year: YEAR });
      const user = await createCapUser(tx, []);
      const t = tag();
      const party = await tx.party.create({ data: { name: `IT-E5R2-${t}`, partyType: 'Supplier', isActive: true } });
      const account = await tx.account.create({
        data: { accountNumber: `9.9.${t}`, name: `Kas uji ${t}`, accountType: 'ASSET', rootType: 'ASSET' },
      });
      const deposit = (n: string, amount: number, refundedAmount: number) =>
        tx.payment.create({
          data: {
            paymentNumber: `IT-UM-${n}-${t}`, date: new Date(`${YEAR}-02-01T03:00:00Z`), paymentType: 'VendorDeposit',
            partyId: party.id, accountId: account.id, amount, refundedAmount, status: 'Submitted',
            createdBy: user.userId, fiscalYearId: fy.id,
          },
        });
      const partial = await deposit('A', 100_000_000, 20_000_000);
      const refunded = await deposit('B', 5_000_000, 5_000_000);

      const invoice = await submitPurchaseInvoiceInTx(
        tx,
        { date: `${YEAR}-02-02`, partyId: party.id, items: [{ itemName: 'Jasa (uji)', itemType: 'service', quantity: 1, rate: 10_000_000 }] } as never,
        user.userId,
      );
      await tx.vendorDepositApplication.create({
        data: { depositPaymentId: partial.id, purchaseInvoiceId: invoice.id, appliedAmount: 10_000_000, isCancelled: true, cancelledAt: new Date(), createdBy: user.userId },
      });

      const r = await callRoute(operationalRouter, 'get', '/daily', { query: { date: `${YEAR}-02-10` }, ...user });
      expect(r.status).toBe(200);
      const mine = (r.body.vendorDeposits.deposits as Array<{ paymentNumber: string }>).filter((row) => row.paymentNumber.endsWith(t));
      expect(mine).toEqual([
        {
          paymentNumber: partial.paymentNumber,
          supplierName: party.name,
          amount: 100_000_000,
          totalApplied: 0,
          totalRefunded: 20_000_000,
          remaining: 80_000_000,
          date: partial.date,
        },
      ]);
      expect(mine.some((row) => row.paymentNumber === refunded.paymentNumber)).toBe(false);

      const s = r.body.vendorDeposits.summary;
      expect(s.totalRefunded).toBeGreaterThanOrEqual(25_000_000);
      expect(s.totalDeposits).toBeGreaterThanOrEqual(105_000_000);
      expect(s.totalRemaining).toBeGreaterThanOrEqual(80_000_000);
      const listed = (r.body.vendorDeposits.deposits as Array<{ remaining: number }>).reduce((sum, row) => sum + row.remaining, 0);
      expect(s.totalRemaining).toBeCloseTo(listed, 2);
    });
  });
});
