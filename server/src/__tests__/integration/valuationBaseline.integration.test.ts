/**
 * Integration test: data part of the value-ledger migration (E3-R6, PR-6.4b1, decisions #18/#19).
 * The SQL is read from prisma/migrations/20261112200000_inventory_value_ledger/migration.sql (its
 * value-ledger-data markers) and run inside a rollback transaction on fixtures made here:
 * - an STT receipt overwritten by a live purchase invoice is backfilled at the locked cost, and the
 *   invoice delta becomes one Revaluation adjusting it; no baseline row;
 * - after the invoice is cancelled, or once it has a price revision: no Revaluation, the delta goes
 *   into the baseline (a revised invoice is listed);
 * - In / Out / Adjustment / transfer / cancelled rows get their signed values;
 * - the baseline is dated at the start of the earliest open fiscal year, or the later cut-over date;
 * - drift, no active user, no open fiscal year: RAISE;
 * - run twice: numbers do not collide, an unchanged database gets no new row, also for an item the
 *   ledger took through a negative-stock window after its baseline;
 * - an item whose baseline is dated before older movements is listed (decision #19);
 * - afterwards stock_value = Σ active value_delta (the self-check).
 * Fiscal year 2109; every other year is closed inside the transaction so the baseline day is known.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import type { Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { seedStock, seedUnplacedStock } from '../helpers/inventoryFixture';
import { submitGoodsReceiptInTx } from '../../services/goodsReceiptSubmit';
import { submitPurchaseInvoiceInTx } from '../../services/purchaseInvoiceSubmit';
import { cancelPurchaseInvoiceInTx } from '../../services/invoiceCancellation';
import { reviseJournalNarration } from '../../services/purchaseInvoiceRevise';
import {
  findValueBaselineNotes,
  readValueBaselineSql,
  runValueBaselineData,
  valueLedgerMigrationPath,
  VALUE_LEDGER_MIGRATION,
} from '../../services/inventory/valueBaselineSql';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2109;
const DAY = `${YEAR}-02-10`;

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
  otherWarehouseId: string;
  supplierId: string;
  stamp: string;
}

/** FY 2109 as the only open year, no cut-over date, own warehouses and Supplier. */
async function createWorld(tx: Tx): Promise<World> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const fy = await createFiscalYear(tx, { year: YEAR });
  await tx.fiscalYear.updateMany({ where: { id: { not: fy.id }, isClosed: false }, data: { isClosed: true } });
  await tx.companySettings.updateMany({ data: { cutoverDate: null } });
  const user = await tx.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const wh = await tx.warehouse.create({ data: { code: `VB-A-${stamp}`, name: `VB A ${stamp}` } });
  const wh2 = await tx.warehouse.create({ data: { code: `VB-B-${stamp}`, name: `VB B ${stamp}` } });
  const supplier = await tx.party.create({ data: { name: `VB Supplier ${stamp}`, partyType: 'Supplier' } });
  return { fyId: fy.id, userId: user.id, warehouseId: wh.id, otherWarehouseId: wh2.id, supplierId: supplier.id, stamp };
}

async function inWorld(fn: (tx: Tx, w: World) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx, await createWorld(tx));
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** The run must fail; its transaction is aborted, so each refusal gets a transaction of its own. */
async function expectRaise(setup: (tx: Tx, w: World) => Promise<void>, pattern: RegExp) {
  let caught: unknown;
  try {
    await prisma.$transaction(async (tx) => {
      const w = await createWorld(tx);
      await setup(tx, w);
      await runValueBaselineData(tx);
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeInstanceOf(RollbackSentinel);
  expect(String((caught as Error)?.message)).toMatch(pattern);
}

const createItem = (tx: Tx, w: World, suffix: string) =>
  tx.inventoryItem.create({ data: { code: `VB-${suffix}-${w.stamp}`, name: `VB ${suffix} ${w.stamp}`, unit: 'kg' } });

const valueOf = async (tx: Tx, id: string) => Number((await tx.stockMovement.findUniqueOrThrow({ where: { id } })).valueDelta);

async function assertSelfCheck(tx: Tx, itemIds: string[]) {
  for (const itemId of itemIds) {
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
    const sum = await tx.stockMovement.aggregate({ where: { itemId, isCancelled: false }, _sum: { valueDelta: true } });
    expect(new Decimal(item.stockValue.toString()).minus(sum._sum.valueDelta?.toString() ?? 0).abs().lte('0.005')).toBe(true);
  }
}

/** STT 100 kg at a locked 10.000, then a purchase invoice at 11.000 (landed delta +100.000). */
async function sttWithInvoice(tx: Tx, w: World, itemId: string) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  const stt = await submitGoodsReceiptInTx(tx, {
    date: DAY,
    partyId: w.supplierId,
    items: [{ inventoryItemId: itemId, warehouseId: w.warehouseId, itemName: item.name, quantity: 100, unit: 'kg', lockedUnitCost: 10_000 }],
  }, w.userId);
  const grItem = await tx.goodsReceiptItem.findFirstOrThrow({ where: { goodsReceiptId: stt.id } });
  const pi = await submitPurchaseInvoiceInTx(tx, {
    date: DAY,
    partyId: w.supplierId,
    items: [{
      itemName: item.name, inventoryItemId: itemId, warehouseId: w.warehouseId, quantity: 100, unit: 'kg',
      rate: 11_000, taxPct: 0, pphPct: 0, goodsReceiptItemId: grItem.id,
    }],
  }, w.userId);
  const movementId = grItem.stockMovementId!;
  const mv = await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } });
  expect(Number(mv.totalValue)).toBe(1_100_000); // the invoice overwrote the STT value
  return { movementId, pi };
}

d('value-ledger migration data part (E3-R6)', () => {
  it('reads one DO block between the markers of the migration folder', () => {
    expect(valueLedgerMigrationPath()).toContain(`${VALUE_LEDGER_MIGRATION}/migration.sql`);
    const sql = readValueBaselineSql();
    expect(sql.startsWith('DO $value_ledger$')).toBe(true);
    expect(sql.endsWith('$value_ledger$;')).toBe(true);
  });

  it('values an STT receipt at its locked cost and turns a live invoice delta into one Revaluation', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'PI');
      const { movementId, pi } = await sttWithInvoice(tx, w, item.id);

      const report = await runValueBaselineData(tx);

      expect(await valueOf(tx, movementId)).toBe(1_000_000);
      const rows = report.newRows.filter((r) => r.itemId === item.id);
      expect(rows).toHaveLength(1);
      const reval = await tx.stockMovement.findUniqueOrThrow({ where: { id: rows[0]!.id } });
      expect(reval).toMatchObject({
        movementType: 'Revaluation', warehouseId: null, referenceType: 'PurchaseInvoice', referenceId: pi.id,
        referenceNumber: pi.invoiceNumber, adjustsMovementId: movementId, isCancelled: false, movementNumber: `SM-RV-${(await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } })).movementNumber}`,
      });
      expect(Number(reval.quantity)).toBe(0);
      expect(Number(reval.valueDelta)).toBe(100_000);
      expect(Number(reval.totalValue)).toBe(100_000);
      expect(reval.date.toISOString().slice(0, 10)).toBe(DAY);
      const after = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(Number(after.averageCost)).toBe(11_000);
      expect(Number(after.stockValue)).toBe(1_100_000);
      expect(report.newRows.some((r) => r.itemId === item.id && r.referenceType === 'ValuationBaseline')).toBe(false);
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('gives a cancelled invoice no Revaluation; its leftover delta goes into the baseline', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'PIX');
      const { movementId, pi } = await sttWithInvoice(tx, w, item.id);
      await cancelPurchaseInvoiceInTx(tx, pi.id, { cancelledById: w.userId, cancelReason: 'valuation baseline test' });
      const kept = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(Number(kept.averageCost)).toBe(11_000); // the cancel leaves STT-owned stock and average alone

      const report = await runValueBaselineData(tx);

      expect(await valueOf(tx, movementId)).toBe(1_000_000);
      const rows = report.newRows.filter((r) => r.itemId === item.id);
      expect(rows).toHaveLength(1);
      const baseline = await tx.stockMovement.findUniqueOrThrow({ where: { id: rows[0]!.id } });
      expect(baseline).toMatchObject({
        movementNumber: `SM-VB-${item.code}-1`, movementType: 'Revaluation', referenceType: 'ValuationBaseline',
        warehouseId: null, adjustsMovementId: null, fiscalYearId: w.fyId, createdById: w.userId, journalEntryId: null,
      });
      expect(Number(baseline.valueDelta)).toBe(100_000);
      expect(baseline.date.toISOString().slice(0, 10)).toBe(`${YEAR}-01-01`);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).stockValue)).toBe(1_100_000);
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('gives a revised invoice no Revaluation: its delta goes into the baseline and the invoice is listed', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'PIR');
      const { movementId, pi } = await sttWithInvoice(tx, w, item.id);
      // The revision journal as purchaseInvoiceRevise.ts writes it (its lines name no invoice line).
      await tx.journalEntry.create({
        data: {
          entryNumber: `IT-VB-JV-${w.stamp}`, date: new Date(`${DAY}T00:00:00.000Z`), status: 'Submitted', fiscalYearId: w.fyId,
          createdBy: w.userId, narration: reviseJournalNarration(pi.invoiceNumber, 'VB Supplier', 'harga dikoreksi Supplier'),
        },
      });

      const report = await runValueBaselineData(tx);

      expect(await valueOf(tx, movementId)).toBe(1_000_000);
      const rows = report.newRows.filter((r) => r.itemId === item.id);
      expect(rows.map((r) => [r.referenceType, r.valueDelta.toFixed(2)])).toEqual([['ValuationBaseline', '100000.00']]);
      const notes = await findValueBaselineNotes(tx);
      expect(notes.revisedInvoices.filter((r) => r.itemCode === item.code).map((r) => [r.invoiceNumber, r.delta.toFixed(2)]))
        .toEqual([[pi.invoiceNumber, '100000.00']]);
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('lists an item whose baseline is dated before movements that existed when it was written', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'LATE');
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 6_000 } });

      const [row] = (await runValueBaselineData(tx)).newRows.filter((r) => r.itemId === item.id);
      expect(row!.date.toISOString().slice(0, 10)).toBe(`${YEAR}-01-01`);
      const listed = (await findValueBaselineNotes(tx)).movementsAfterBaseline.filter((r) => r.itemCode === item.code);
      expect(listed.map((r) => [r.baselineNumber, r.movements])).toEqual([[row!.movementNumber, 1]]);
    });
  });

  it('backfills signed values per movement type and needs no baseline when movements explain the value', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'MIX');
      const { movementId: inId } = await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      const base = { date: new Date(`${DAY}T00:00:00.000Z`), itemId: item.id, fiscalYearId: w.fyId, createdById: w.userId };
      type Row = Pick<Prisma.StockMovementUncheckedCreateInput, 'warehouseId' | 'movementType' | 'quantity' | 'unitCost' | 'totalValue' | 'isCancelled'>;
      const mk = (n: string, data: Row) =>
        tx.stockMovement.create({ data: { ...base, movementNumber: `IT-VB-${n}-${w.stamp}`, ...data } });
      const out = await mk('OUT', { warehouseId: w.warehouseId, movementType: 'Out', quantity: 40, unitCost: 5_000, totalValue: 200_000 });
      const adjIn = await mk('AIN', { warehouseId: w.warehouseId, movementType: 'AdjustmentIn', quantity: 2, unitCost: 5_000, totalValue: 10_000 });
      const adjOut = await mk('AOUT', { warehouseId: w.warehouseId, movementType: 'AdjustmentOut', quantity: 2, unitCost: 5_000, totalValue: 10_000 });
      const tOut = await mk('TOUT', { warehouseId: w.warehouseId, movementType: 'TransferOut', quantity: 10, unitCost: 5_000, totalValue: 50_000 });
      const tIn = await mk('TIN', { warehouseId: w.otherWarehouseId, movementType: 'TransferIn', quantity: 10, unitCost: 5_000, totalValue: 50_000 });
      const cancelled = await mk('CXL', { warehouseId: w.warehouseId, movementType: 'In', quantity: 7, unitCost: 5_000, totalValue: 35_000, isCancelled: true });
      // Stock 60 (50 in A, 10 in B) at 5.000 = 300.000, as the movements say.
      await tx.inventoryItem.update({ where: { id: item.id }, data: { currentStock: 60 } });
      await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: w.warehouseId } }, data: { currentStock: 50 } });
      await tx.inventoryStock.create({ data: { itemId: item.id, warehouseId: w.otherWarehouseId, currentStock: 10 } });

      const report = await runValueBaselineData(tx);

      expect(await valueOf(tx, inId)).toBe(500_000);
      expect(await valueOf(tx, out.id)).toBe(-200_000);
      expect(await valueOf(tx, adjIn.id)).toBe(10_000);
      expect(await valueOf(tx, adjOut.id)).toBe(-10_000);
      expect(await valueOf(tx, tOut.id)).toBe(0);
      expect(await valueOf(tx, tIn.id)).toBe(0);
      expect(await valueOf(tx, cancelled.id)).toBe(35_000); // cancelled rows too, for a later reversal
      // out, adjIn, adjOut and the cancelled row; seedStock's In carries its value_delta already.
      expect(report.backfilled).toBeGreaterThanOrEqual(4);
      expect(report.newRows.filter((r) => r.itemId === item.id)).toHaveLength(0);
      expect(report.stockValueChanges.find((c) => c.itemId === item.id)?.after.toFixed(2)).toBe('300000.00');
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('dates the baseline at the cut-over date when it is later than the start of the open year', async () => {
    await inWorld(async (tx, w) => {
      await tx.companySettings.updateMany({ data: { cutoverDate: new Date(`${YEAR}-03-01`) } });
      const item = await createItem(tx, w, 'CUT');
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 6_000 } });

      const report = await runValueBaselineData(tx);

      const [row] = report.newRows.filter((r) => r.itemId === item.id);
      expect(row!.date.toISOString().slice(0, 10)).toBe(`${YEAR}-03-01`);
      expect(row!.valueDelta.toFixed(2)).toBe('100000.00');
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('numbers a second baseline after the first and adds nothing when nothing changed', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'TWICE');
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 6_000 } });
      const first = (await runValueBaselineData(tx)).newRows.filter((r) => r.itemId === item.id);
      expect(first.map((r) => [r.movementNumber, r.valueDelta.toFixed(2)])).toEqual([[`SM-VB-${item.code}-1`, '100000.00']]);

      expect((await runValueBaselineData(tx)).newRows).toHaveLength(0);

      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 5_500 } });
      const second = (await runValueBaselineData(tx)).newRows.filter((r) => r.itemId === item.id);
      expect(second.map((r) => [r.movementNumber, r.valueDelta.toFixed(2)])).toEqual([[`SM-VB-${item.code}-2`, '-50000.00']]);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).stockValue)).toBe(550_000);
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('adds nothing on a re-run for an item the ledger took through a negative-stock window after its baseline', async () => {
    await inWorld(async (tx, w) => {
      const item = await createItem(tx, w, 'NEG');
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 10_000, date: DAY });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 11_000 } });
      const first = (await runValueBaselineData(tx)).newRows.filter((r) => r.itemId === item.id);
      expect(first.map((r) => r.valueDelta.toFixed(2))).toEqual(['100000.00']);

      // As the ledger posts it (inventoryValueMath): out 150 = 1.100.000 + 50 x 11.000; stock −50,
      // value −550.000. In 30 at 12.000 (+360.000): stock −20, value −190.000, average stays 11.000,
      // so stock x average (−220.000) differs from the value: normal in the window.
      const at = (n: string, movementType: 'In' | 'Out', quantity: number, valueDelta: number) => tx.stockMovement.create({
        data: {
          movementNumber: `IT-VB-${n}-${w.stamp}`, date: new Date(`${YEAR}-03-01T00:00:00.000Z`), itemId: item.id, warehouseId: w.warehouseId,
          movementType, quantity, unitCost: Math.abs(valueDelta) / quantity, totalValue: Math.abs(valueDelta), valueDelta,
          fiscalYearId: w.fyId, createdById: w.userId,
        },
      });
      await at('NOUT', 'Out', 150, -1_650_000);
      await at('NIN', 'In', 30, 360_000);
      await tx.inventoryItem.update({ where: { id: item.id }, data: { currentStock: -20, stockValue: -190_000, averageCost: 11_000 } });
      await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: item.id, warehouseId: w.warehouseId } }, data: { currentStock: -20 } });

      const again = await runValueBaselineData(tx);

      expect(again.newRows.filter((r) => r.itemId === item.id)).toHaveLength(0);
      expect(again.stockValueChanges.filter((c) => c.itemId === item.id)).toHaveLength(0);
      expect(Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).stockValue)).toBe(-190_000);
      await assertSelfCheck(tx, [item.id]);
    });
  });

  it('refuses item vs warehouse drift (decision #18)', async () => {
    let code = '';
    await expectRaise(async (tx, w) => {
      const item = await createItem(tx, w, 'DRIFT');
      code = item.code;
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      await seedUnplacedStock(tx, { itemId: item.id, qty: 5, avg: 5_000, date: DAY });
    }, /differs from the sum of its warehouses/);
    expect(code).not.toBe('');
  });

  it('refuses a needed baseline without an active user', async () => {
    await expectRaise(async (tx, w) => {
      const item = await createItem(tx, w, 'NOUSER');
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 6_000 } });
      await tx.user.updateMany({ data: { isActive: false } });
    }, /no active user/);
  });

  it('refuses a needed baseline without an open fiscal year', async () => {
    await expectRaise(async (tx, w) => {
      const item = await createItem(tx, w, 'NOFY');
      await seedStock(tx, { itemId: item.id, warehouseId: w.warehouseId, qty: 100, avg: 5_000, date: DAY });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { averageCost: 6_000 } });
      await tx.fiscalYear.updateMany({ data: { isClosed: true } });
    }, /no open fiscal year contains the baseline date/);
  });
});
