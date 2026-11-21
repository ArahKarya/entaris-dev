/**
 * Integration test: the inventory value ledger API (E3-R6, PR-6.4b2), on fixtures made here inside a
 * rollback transaction:
 * - acceptance R6: 30.000 @5.000 + 60.000 @5.001 in, 90.000 out -> the outbound row is valued
 *   450.060.000 and stock_value ends at 0;
 * - a reversal takes the row's quantity and value_delta back exactly (outbound and inbound);
 * - reversing a row that carries no value (as the backfill left a legacy zero-cost row): the
 *   quantity comes back, the value does not move, and it is logged;
 * - reversing an inbound row after the goods were sold: REVERSAL_NEEDS_TRUE_UP, nothing changes,
 *   also when stock and value both stay positive;
 * - stock that reaches 0 with value left: refused without sweepAtZero, swept to toCogs with it; a
 *   closed sweep period refuses before the row is claimed;
 * - linkMovementJournal fills an empty journal link once;
 * - refreshAverageCost and the invariant report.
 * Every scenario ends with assertLedgerInvariant. Fiscal year 2108.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { seedStock } from '../helpers/inventoryFixture';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import {
  REVERSAL_NEEDS_TRUE_UP,
  assertLedgerInvariant as findLedgerDrifts,
  linkMovementJournal,
  postInbound,
  postOutbound,
  refreshAverageCost,
  reverseMovement,
} from '../../services/inventory/inventoryLedger';
import { logger } from '../../lib/logger';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2108;
const DAY = `${YEAR}-02-10`;
const CANCEL_DAY = `${YEAR}-03-02`;

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

interface World {
  fyId: string;
  userId: string;
  warehouseId: string;
  itemId: string;
}

async function createWorld(tx: Tx): Promise<World> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const fy = await createFiscalYear(tx, { year: YEAR });
  const user = await tx.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' } });
  const wh = await tx.warehouse.create({ data: { code: `IL-${stamp}`, name: `IL ${stamp}` } });
  const item = await tx.inventoryItem.create({ data: { code: `IL-${stamp}`, name: `Gabah IL ${stamp}`, unit: 'kg' } });
  return { fyId: fy.id, userId: user.id, warehouseId: wh.id, itemId: item.id };
}

async function inWorld(fn: (tx: Tx, w: World) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      const w = await createWorld(tx);
      await fn(tx, w);
      await assertLedgerInvariant(tx, [w.itemId], { warehouses: true });
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const base = (w: World) => ({ itemId: w.itemId, warehouseId: w.warehouseId, date: new Date(DAY), fiscalYearId: w.fyId, createdById: w.userId });
const stockIn = (tx: Tx, w: World, quantity: number, value: number) => postInbound(tx, { ...base(w), movementType: 'In', quantity, value });
const stockOut = (tx: Tx, w: World, quantity: number) => postOutbound(tx, { ...base(w), movementType: 'Out', quantity });

async function itemState(tx: Tx, w: World) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: w.itemId } });
  const wh = await tx.inventoryStock.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId: w.itemId, warehouseId: w.warehouseId } } });
  return {
    stock: item.currentStock.toFixed(3),
    value: item.stockValue.toFixed(2),
    average: item.averageCost.toFixed(6),
    warehouse: wh.currentStock.toFixed(3),
  };
}

type Refusal = Error & { code?: string; status?: number };

async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (e) {
    return e as Refusal;
  }
  throw new Error('expected a refusal');
}

d('inventoryLedger (PR-6.4b2)', () => {
  it('acceptance R6: 30.000 @5.000 + 60.000 @5.001, out 90.000 -> COGS 450.060.000, stock_value 0', async () => {
    await inWorld(async (tx, w) => {
      const a = await stockIn(tx, w, 30_000, 150_000_000);
      expect(a.valueDelta.toFixed(2)).toBe('150000000.00');
      expect(a.averageCostAfter.toFixed(6)).toBe('5000.000000');
      const b = await stockIn(tx, w, 60_000, 300_060_000);
      expect(b.stockValueAfter.toFixed(2)).toBe('450060000.00');
      expect(b.averageCostAfter.toFixed(6)).toBe('5000.666667');
      expect(b.movement.unitCost.toFixed(6)).toBe('5001.000000');

      const out = await stockOut(tx, w, 90_000);

      expect(out.valueDelta.toFixed(2)).toBe('-450060000.00');
      expect(out.movement.totalValue.toFixed(2)).toBe('450060000.00');
      expect(out.movement.valueDelta.toFixed(2)).toBe('-450060000.00');
      expect(out.movement.unitCost.toFixed(6)).toBe('5000.666667');
      expect(await itemState(tx, w)).toEqual({ stock: '0.000', value: '0.00', average: '5000.666667', warehouse: '0.000' });
    });
  });

  it('reverses an outbound and an inbound row exactly', async () => {
    await inWorld(async (tx, w) => {
      await stockIn(tx, w, 100, 1_000_000);
      const b = await stockIn(tx, w, 50, 600_000);
      const out = await stockOut(tx, w, 30);
      expect(out.valueDelta.toFixed(2)).toBe('-320000.00'); // 1.600.000 x 30 / 150

      const backOut = await reverseMovement(tx, out.movement.id, { userId: w.userId });
      expect(backOut.valueDelta.toFixed(2)).toBe('320000.00');
      expect(backOut.toCogs.toFixed(2)).toBe('0.00');
      expect(backOut.sweep).toBeNull();
      expect(await itemState(tx, w)).toEqual({ stock: '150.000', value: '1600000.00', average: '10666.666667', warehouse: '150.000' });

      const backIn = await reverseMovement(tx, b.movement.id, { userId: w.userId });
      expect(backIn.valueDelta.toFixed(2)).toBe('-600000.00');
      expect(await itemState(tx, w)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000', warehouse: '100.000' });
      const rows = await tx.stockMovement.findMany({ where: { id: { in: [out.movement.id, b.movement.id] } } });
      expect(rows.every((r) => r.isCancelled)).toBe(true);

      const again = await refusal(() => reverseMovement(tx, b.movement.id, { userId: w.userId }));
      expect(again.message).toMatch(/sudah dibatalkan/);
    });
  });

  it('reverses a backfilled row that carries no value: quantity back, value unchanged, logged', async () => {
    await inWorld(async (tx, w) => {
      await seedStock(tx, { itemId: w.itemId, warehouseId: w.warehouseId, qty: 100, avg: 10_000, date: DAY, fiscalYearId: w.fyId, userId: w.userId });
      // A legacy zero-cost receipt as the backfill left it: value_delta 0, average diluted.
      const legacy = await tx.stockMovement.create({
        data: {
          movementNumber: `IL-ZERO-${w.itemId.slice(0, 8)}`, date: new Date(DAY), itemId: w.itemId, warehouseId: w.warehouseId,
          movementType: 'In', quantity: 25, unitCost: 0, totalValue: 0, valueDelta: 0, fiscalYearId: w.fyId, createdById: w.userId,
        },
      });
      await tx.inventoryItem.update({ where: { id: w.itemId }, data: { currentStock: 125, averageCost: 8_000 } });
      await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: w.itemId, warehouseId: w.warehouseId } }, data: { currentStock: 125 } });
      const warn = vi.spyOn(logger, 'warn');

      const back = await reverseMovement(tx, legacy.id, { userId: w.userId });

      expect(back.valueDelta.toFixed(2)).toBe('0.00');
      expect(await itemState(tx, w)).toEqual({ stock: '100.000', value: '1000000.00', average: '10000.000000', warehouse: '100.000' });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ movementId: legacy.id }), 'Reversed a stock movement that carries no value');
      warn.mockRestore();
    });
  });

  it('refuses to reverse an inbound row after the goods were sold (REVERSAL_NEEDS_TRUE_UP), changing nothing', async () => {
    await inWorld(async (tx, w) => {
      await stockIn(tx, w, 100, 1_000_000);
      const b = await stockIn(tx, w, 100, 2_000_000);
      await stockOut(tx, w, 150); // 150 x 15.000 = 2.250.000; 50 left at 750.000
      const before = await itemState(tx, w);

      const err = await refusal(() => reverseMovement(tx, b.movement.id, { userId: w.userId, sweepAtZero: true }));

      expect(err).toMatchObject({ code: REVERSAL_NEEDS_TRUE_UP, status: 409 });
      expect(await itemState(tx, w)).toEqual(before);
      expect(before).toEqual({ stock: '50.000', value: '750000.00', average: '15000.000000', warehouse: '50.000' });
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: b.movement.id } })).isCancelled).toBe(false);
    });
  });

  it('refuses an inbound reversal after a partial sale even when stock and value stay positive', async () => {
    await inWorld(async (tx, w) => {
      const a = await stockIn(tx, w, 100, 1_000_000);
      await stockIn(tx, w, 100, 2_000_000);
      await stockOut(tx, w, 50); // 50 x 15.000 = 750.000; 150 left at 2.250.000
      const before = await itemState(tx, w);

      // Taken back exactly it would leave 50 at 1.250.000 (average 25.000, above any cost paid).
      const err = await refusal(() => reverseMovement(tx, a.movement.id, { userId: w.userId, sweepAtZero: true }));

      expect(err).toMatchObject({ code: REVERSAL_NEEDS_TRUE_UP, status: 409 });
      expect(await itemState(tx, w)).toEqual(before);
      expect(before).toEqual({ stock: '150.000', value: '2250000.00', average: '15000.000000', warehouse: '150.000' });
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: a.movement.id } })).isCancelled).toBe(false);
    });
  });

  it('at zero stock with value left: refused without sweepAtZero, swept to COGS with it', async () => {
    await inWorld(async (tx, w) => {
      const a = await stockIn(tx, w, 100, 1_000_000);
      await stockIn(tx, w, 100, 1_200_000);
      await stockOut(tx, w, 100); // 100 x 11.000 = 1.100.000; 100 left at 1.100.000

      const err = await refusal(() => reverseMovement(tx, a.movement.id, { userId: w.userId }));
      expect(err).toMatchObject({ code: REVERSAL_NEEDS_TRUE_UP, status: 409 });

      const back = await reverseMovement(tx, a.movement.id, { userId: w.userId, sweepAtZero: true, journalDay: CANCEL_DAY });

      expect(back.valueDelta.toFixed(2)).toBe('-1000000.00');
      expect(back.toCogs.toFixed(2)).toBe('100000.00');
      expect(back.stockValueAfter.toFixed(2)).toBe('0.00');
      expect(back.sweep).toMatchObject({
        movementType: 'Revaluation', warehouseId: null, adjustsMovementId: a.movement.id, date: new Date(CANCEL_DAY), fiscalYearId: w.fyId,
      });
      expect(back.sweep!.quantity.toFixed(3)).toBe('0.000');
      expect(back.sweep!.valueDelta.toFixed(2)).toBe('-100000.00');
      expect(await itemState(tx, w)).toEqual({ stock: '0.000', value: '0.00', average: '11000.000000', warehouse: '0.000' });
    });
  });

  it('checks the sweep period before it claims the row', async () => {
    await inWorld(async (tx, w) => {
      const a = await stockIn(tx, w, 100, 1_000_000);
      await stockIn(tx, w, 100, 1_200_000);
      await stockOut(tx, w, 100);
      const before = await itemState(tx, w);
      await tx.fiscalYear.update({ where: { id: w.fyId }, data: { isClosed: true } });

      const err = await refusal(() => reverseMovement(tx, a.movement.id, { userId: w.userId, sweepAtZero: true, journalDay: CANCEL_DAY }));

      expect(err).toMatchObject({ code: 'PERIOD_CLOSED' });
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: a.movement.id } })).isCancelled).toBe(false);
      expect(await itemState(tx, w)).toEqual(before);
      await tx.fiscalYear.update({ where: { id: w.fyId }, data: { isClosed: false } });
    });
  });

  it('links the journal of an outbound row once', async () => {
    await inWorld(async (tx, w) => {
      await stockIn(tx, w, 10, 100_000);
      const out = await stockOut(tx, w, 4);
      expect(out.movement.journalEntryId).toBeNull();
      const je = await tx.journalEntry.create({
        data: { entryNumber: `IL-JV-${w.itemId.slice(0, 8)}`, date: new Date(DAY), fiscalYearId: w.fyId, createdBy: w.userId },
      });

      await linkMovementJournal(tx, out.movement.id, je.id);

      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: out.movement.id } })).journalEntryId).toBe(je.id);
      await expect(linkMovementJournal(tx, out.movement.id, je.id)).rejects.toThrow(/already linked/);
    });
  });

  it('refreshes the average from the book and reports invariant breaks', async () => {
    await inWorld(async (tx, w) => {
      await stockIn(tx, w, 3, 10_000);
      await tx.inventoryItem.update({ where: { id: w.itemId }, data: { averageCost: 1 } });
      expect((await findLedgerDrifts(tx, [w.itemId])).map((x) => x.kind)).toEqual(['average']);

      expect((await refreshAverageCost(tx, w.itemId)).toFixed(6)).toBe('3333.333333');
      expect(await findLedgerDrifts(tx, [w.itemId])).toEqual([]);

      await tx.inventoryItem.update({ where: { id: w.itemId }, data: { stockValue: 10_001, currentStock: 4 } });
      const drifts = await findLedgerDrifts(tx, [w.itemId]);
      expect(drifts.map((x) => [x.kind, x.reportOnly, x.difference.toFixed(2)])).toEqual([
        ['valueSum', false, '1.00'],
        ['average', false, '-3332.33'],
        ['warehouseSum', true, '1.00'],
      ]);
      await tx.inventoryItem.update({ where: { id: w.itemId }, data: { stockValue: 10_000, currentStock: 3 } });
    });
  });
});
