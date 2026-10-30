/**
 * Integration test: atomic cancel claims and the cancel trail (E1-R4).
 *
 * - Migration 2026103000000_cancel_trail.sql runs twice without error.
 * - Two concurrent cancels of one 5 jt receivables journal from the Journal menu: one 200, one 400
 *   STALE_STATUS; the AR balance and the customer's outstanding move back once. The cancelled
 *   journal stores who cancelled it and why.
 * - Two concurrent cancels of one 10 t STT: stock and PO qtyReceived drop by 10 t once; the STT
 *   stores who cancelled it.
 *
 * Both races need committed rows on two connections, so their fixtures are created for real in a
 * far-future year and deleted after. The first cancel is held open before commit while the second
 * one starts, so the second always reads the stale "Submitted" row and loses at the claim.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { systemAccountNumber } from '../helpers/systemAccountNumbers';
import { BusinessError } from '../../utils/errors';

const state = vi.hoisted(() => ({
  client: null as PrismaClient | null,
  /** Runs once, at the end of the next route transaction, before it commits. */
  beforeCommit: null as null | (() => Promise<void>),
}));

// Route handlers use a real client here (not the rollback harness): each `$transaction` is its own
// connection, as in production.
vi.mock('../../lib/prisma', () => ({
  prisma: new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const client = state.client;
      if (!client) throw new Error('cancelClaim test: no client');
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

import journalsRouter from '../../routes/journals';
import { cancelGoodsReceiptInTx } from '../../services/goodsReceiptCancel';
import { STALE_STATUS } from '../../utils/cancelClaim';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const MIGRATION = join(__dirname, '../../../prisma/migrations/2026103000000_cancel_trail.sql');

let prisma: PrismaClient;
let pool: Pool;
let userId: string;
let warehouseId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  state.client = prisma;
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
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

/** Holds the next transaction open before commit; `applied` resolves once it got there. */
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

/** Starts `p` and reports whether it settled within `ms`; the second cancel must be waiting. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  void p.finally(() => { settled = true; }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

d('cancel_trail migration', () => {
  it('runs twice in a row and leaves both columns on all four tables', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(sql);
      const cols = await client.query(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns
         WHERE table_name IN ('goods_receipts','payments','project_guarantees','project_guarantee_settlements')
           AND column_name IN ('cancelled_by_id','cancel_reason')
         ORDER BY table_name, column_name`,
      );
      expect(cols.rows).toHaveLength(8);
      expect(cols.rows.every((r) => r.is_nullable === 'YES')).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

d('journal menu cancel run twice at once', () => {
  it('one 200 and one 400 STALE_STATUS; the 5 jt receivable is reversed once and the trail is stored', async () => {
    const fy = await createFiscalYear(prisma as unknown as Tx, { year: 2088 });
    const customer = await prisma.party.create({ data: { name: `IT-E1R4-Customer-${tag()}`, partyType: 'Customer', isActive: true } });
    const ar = await prisma.account.findFirstOrThrow({ where: { accountNumber: await systemAccountNumber(prisma, 'AR') } });
    const equity = await prisma.account.findFirstOrThrow({ where: { accountNumber: await systemAccountNumber(prisma, 'OPENING_EQUITY') } });
    const balancesBefore = await prisma.account.findMany({ where: { id: { in: [ar.id, equity.id] } }, select: { id: true, balance: true } });
    const balance = async (id: string) => Number((await prisma.account.findUniqueOrThrow({ where: { id } })).balance);
    const arBefore = await balance(ar.id);
    let journalId: string | undefined;
    try {
      const created = await callRoute(journalsRouter, 'post', '/', {
        body: {
          date: '2088-05-10',
          narration: `Uji batal ganda ${tag()}`,
          items: [
            { accountId: ar.id, partyId: customer.id, debit: 5_000_000, credit: 0 },
            { accountId: equity.id, debit: 0, credit: 5_000_000 },
          ],
        },
        userId,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      journalId = created.body.id as string;
      expect(await balance(ar.id)).toBe(arBefore + 5_000_000);

      const { applied, release } = holdNextCommit();
      const first = callRoute(journalsRouter, 'patch', '/:id/cancel', {
        params: { id: journalId },
        body: { reason: '  Salah input customer  ' },
        userId,
      });
      await applied;
      const second = callRoute(journalsRouter, 'patch', '/:id/cancel', { params: { id: journalId }, userId });
      expect(await stillPending(second)).toBe(true);

      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(b.status, JSON.stringify(b.body)).toBe(400);
      expect(b.body.code).toBe(STALE_STATUS);

      expect(await balance(ar.id)).toBe(arBefore);
      expect(Number((await prisma.party.findUniqueOrThrow({ where: { id: customer.id } })).outstandingAmount)).toBe(0);
      const journal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: journalId } });
      expect(journal.status).toBe('Cancelled');
      expect(journal.cancelledById).toBe(userId);
      expect(journal.cancelReason).toBe('Salah input customer');
      expect(await prisma.accountingLedgerEntry.count({ where: { referenceId: journalId, isCancelled: false } })).toBe(0);
    } finally {
      state.beforeCommit = null;
      if (journalId) {
        await prisma.accountingLedgerEntry.deleteMany({ where: { referenceId: journalId } });
        await prisma.journalItem.deleteMany({ where: { journalEntryId: journalId } });
        await prisma.journalEntry.delete({ where: { id: journalId } });
      }
      // Net zero when the test passes; restores the shared accounts when it fails halfway.
      for (const acc of balancesBefore) {
        await prisma.account.update({ where: { id: acc.id }, data: { balance: acc.balance } });
      }
      await prisma.party.delete({ where: { id: customer.id } });
      await prisma.fiscalYear.delete({ where: { id: fy.id } });
    }
  });

  it('rejects a reason longer than 500 characters before touching the journal', async () => {
    const res = await callRoute(journalsRouter, 'patch', '/:id/cancel', {
      params: { id: '00000000-0000-0000-0000-000000000000' },
      body: { reason: 'x'.repeat(501) },
      userId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Alasan pembatalan maksimal 500 karakter.');
  });
});

d('STT cancel run twice at once', () => {
  it('stock and PO qtyReceived drop by 10 t once; the loser gets STALE_STATUS', async () => {
    const fy = await createFiscalYear(prisma as unknown as Tx, { year: 2088 });
    const supplier = await prisma.party.create({ data: { name: `IT-E1R4-Supplier-${tag()}`, partyType: 'Supplier', isActive: true } });
    const item = await prisma.inventoryItem.create({
      data: { code: `IT-E1R4-${tag()}`, name: `Uji STT ganda ${tag()}`, unit: 'kg', currentStock: 10_000, averageCost: 9_000, isActive: true },
    });
    // State right after a 10 t STT against a PO line (no journal: the cancel then posts none).
    await prisma.inventoryStock.create({ data: { itemId: item.id, warehouseId, currentStock: 10_000 } });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-E1R4-${tag()}`, date: new Date('2088-04-01'), partyId: supplier.id, fiscalYearId: fy.id, createdBy: userId,
        items: { create: [{ itemName: item.name, inventoryItemId: item.id, quantity: 10_000, unit: 'kg', qtyReceived: 10_000 }] },
      },
      include: { items: true },
    });
    const movement = await prisma.stockMovement.create({
      data: {
        movementNumber: `SM-E1R4-${tag()}`, date: new Date('2088-04-02'), itemId: item.id, movementType: 'In', quantity: 10_000,
        unitCost: 9_000, warehouseId, fiscalYearId: fy.id, createdById: userId, referenceType: 'GoodsReceipt',
      },
    });
    const stt = await prisma.goodsReceipt.create({
      data: {
        sttNumber: `STT-E1R4-${tag()}`, date: new Date('2088-04-02'), partyId: supplier.id, fiscalYearId: fy.id, createdBy: userId,
        status: 'Submitted', submittedAt: new Date(),
        items: {
          create: [{
            inventoryItemId: item.id, warehouseId, itemName: item.name, quantity: 10_000, unit: 'kg',
            purchaseOrderItemId: po.items[0]!.id, stockMovementId: movement.id,
          }],
        },
      },
    });
    await prisma.stockMovement.update({ where: { id: movement.id }, data: { referenceId: stt.id } });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let markApplied!: () => void;
      const applied = new Promise<void>((r) => { markApplied = r; });
      const first = prisma.$transaction(async (t) => {
        await cancelGoodsReceiptInTx(t, stt.id, userId, { reason: 'Barang dikembalikan' });
        markApplied();
        await held; // keep the first cancel uncommitted while the second one starts
      }, { timeout: 20000 });
      await applied;

      const second = prisma.$transaction((t) => cancelGoodsReceiptInTx(t, stt.id, userId), { timeout: 20000 })
        .then(() => 'NO_ERROR', (e: unknown) => (e instanceof BusinessError ? e.code : String(e)));
      expect(await stillPending(second)).toBe(true);

      release();
      await first;
      expect(await second).toBe(STALE_STATUS);

      expect(Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock)).toBe(0);
      const stock = await prisma.inventoryStock.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId: item.id, warehouseId } } });
      expect(Number(stock.currentStock)).toBe(0);
      expect(Number((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: po.items[0]!.id } })).qtyReceived)).toBe(0);
      const after = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: stt.id } });
      expect(after.status).toBe('Cancelled');
      expect(after.cancelledById).toBe(userId);
      expect(after.cancelReason).toBe('Barang dikembalikan');
    } finally {
      await prisma.goodsReceipt.delete({ where: { id: stt.id } });
      await prisma.stockMovement.delete({ where: { id: movement.id } });
      await prisma.purchaseOrder.delete({ where: { id: po.id } });
      await prisma.inventoryStock.deleteMany({ where: { itemId: item.id } });
      await prisma.inventoryItem.delete({ where: { id: item.id } });
      await prisma.party.delete({ where: { id: supplier.id } });
      await prisma.fiscalYear.delete({ where: { id: fy.id } });
    }
  });
});
