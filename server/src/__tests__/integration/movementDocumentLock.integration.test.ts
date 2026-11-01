/**
 * Integration test: stock movements owned by a document change only through it (E3-R2, I-2, I-38).
 *
 * Per-row edit/cancel of transfer, production, opname and opening-balance movements is refused
 * before any stock moves; referenceType/referenceId sent by a client are not stored, so a manual
 * movement can never lock itself; an outbound batch link must point at an active inbound movement
 * of the same item. Old data where a document movement was already cancelled per row is not
 * reversed twice by the document cancel. Fixtures are created in rollback transactions in fiscal
 * year 2185.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type FiscalYear } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { submitStockTransferInTx, STOCK_TRANSFER_CANCEL_INCOMPLETE } from '../../services/stockTransfer';
import { MOVEMENT_DOCUMENT_LOCKED } from '../../services/documentMovementLock';
import { MOVEMENT_SOURCE_BATCH_INVALID } from '../../services/inventory/batchSource';
import { findMovementReferenceIssues } from '../../services/inventory/movementReferenceAudit';
import movementsRouter from '../../routes/inventory/movements';
import stockTransfersRouter from '../../routes/stockTransfers';
import stockOpnameRouter from '../../routes/stockOpname';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const Y = 2185;
const DAY = `${Y}-03-10`;
const DATE = new Date(`${DAY}T05:00:00Z`);

let prisma: PrismaClient;
let pool: Pool;
/** Holds doc.cancel; created in each rollback transaction. */
let actor: { userId: string; role: string };
let fy: FiscalYear;

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
      try {
        actor = await createCapUser(tx, ['doc.cancel']);
        fy = await createFiscalYear(tx, { year: Y });
        await fn(tx);
      } finally {
        state.tx = null;
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function warehouse(tx: Tx, name: string) {
  const code = `IT-E3R2-${tag()}`;
  return tx.warehouse.create({ data: { code, name: `${name} ${code}` } });
}

/** An item holding `stock` kg, all of it in `warehouseId`. */
async function item(tx: Tx, name: string, warehouseId: string, stock: number) {
  const it = await tx.inventoryItem.create({
    data: { code: `IT-E3R2-${tag()}`, name: `${name} ${tag()}`, unit: 'Kg', currentStock: stock, averageCost: 0 },
  });
  await tx.inventoryStock.create({ data: { itemId: it.id, warehouseId, currentStock: stock } });
  return it;
}

let movSeq = 0;
/** A movement row as a document (or old code) would have written it; stock is not touched. */
function movement(
  tx: Tx,
  data: { itemId: string; warehouseId: string; movementType: 'In' | 'Out' | 'AdjustmentIn' | 'AdjustmentOut' | 'TransferIn' | 'TransferOut'; quantity: number; referenceType?: string | null; referenceId?: string | null; isCancelled?: boolean },
) {
  return tx.stockMovement.create({
    data: {
      movementNumber: `IT-E3R2-SM-${tag()}-${++movSeq}`,
      date: DATE,
      fiscalYearId: fy.id,
      createdById: actor.userId,
      referenceType: null,
      referenceId: null,
      ...data,
    },
  });
}

async function stockAt(tx: Tx, itemId: string, warehouseId: string): Promise<number> {
  const row = await tx.inventoryStock.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } });
  return Number(row?.currentStock ?? 0);
}

async function itemStock(tx: Tx, itemId: string): Promise<number> {
  return Number((await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).currentStock);
}

const cancelMovement = (id: string) => callRoute(movementsRouter, 'put', '/:id/cancel', { ...actor, params: { id } });
const editMovement = (id: string, body: object) => callRoute(movementsRouter, 'put', '/:id', { ...actor, params: { id }, body });
const createMovement = (body: object) => callRoute(movementsRouter, 'post', '/', { ...actor, body });

d('transfer movements', () => {
  it('cancel or edit of the TransferOut / TransferIn rows of a 1,000 kg transfer is refused and stock stays put', async () => {
    await inRollback(async (tx) => {
      const a = await warehouse(tx, 'Gudang A');
      const b = await warehouse(tx, 'Gudang B');
      const beras = await item(tx, 'Beras', a.id, 5000);
      const transfer = await submitStockTransferInTx(
        tx, { date: DAY, fromWarehouseId: a.id, toWarehouseId: b.id, items: [{ itemId: beras.id, quantity: 1000 }] }, actor.userId,
      );
      const rows = await tx.stockMovement.findMany({ where: { referenceType: 'StockTransfer', referenceId: transfer.id } });
      expect(rows.map((r) => r.movementType).sort()).toEqual(['TransferIn', 'TransferOut']);

      for (const row of rows) {
        const cancel = await cancelMovement(row.id);
        expect(cancel.status, row.movementType).toBe(400);
        expect(cancel.body.code).toBe(MOVEMENT_DOCUMENT_LOCKED);
        expect(cancel.body.error).toMatch(/halaman Transfer Stok/);
        const edit = await editMovement(row.id, { movementType: 'In', quantity: 1000, date: DAY });
        expect(edit.status, row.movementType).toBe(400);
        expect(edit.body.code).toBe(MOVEMENT_DOCUMENT_LOCKED);
      }

      expect(await stockAt(tx, beras.id, a.id)).toBe(4000);
      expect(await stockAt(tx, beras.id, b.id)).toBe(1000);
      expect(await itemStock(tx, beras.id)).toBe(5000);
      expect(await tx.stockMovement.count({ where: { referenceId: transfer.id, isCancelled: false } })).toBe(2);
    });
  });

  it('old data: a transfer whose TransferOut was cancelled per row is refused with 409, nothing reversed twice', async () => {
    await inRollback(async (tx) => {
      const a = await warehouse(tx, 'Gudang A');
      const b = await warehouse(tx, 'Gudang B');
      const beras = await item(tx, 'Beras', a.id, 5000);
      const transfer = await submitStockTransferInTx(
        tx, { date: DAY, fromWarehouseId: a.id, toWarehouseId: b.id, items: [{ itemId: beras.id, quantity: 1000 }] }, actor.userId,
      );
      // What the old per-row cancel did to a TransferOut: flagged cancelled, and (wrong sign) A and the item total lost 1,000 again.
      const out = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: transfer.id, movementType: 'TransferOut' } });
      await tx.stockMovement.update({ where: { id: out.id }, data: { isCancelled: true } });
      await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: beras.id, warehouseId: a.id } }, data: { currentStock: { decrement: 1000 } } });
      await tx.inventoryItem.update({ where: { id: beras.id }, data: { currentStock: { decrement: 1000 } } });

      const res = await callRoute(stockTransfersRouter, 'patch', '/:id/cancel', { ...actor, params: { id: transfer.id } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(STOCK_TRANSFER_CANCEL_INCOMPLETE);
      expect(res.body.error).toMatch(/hanya 1 dari 2 gerakan stok/);

      expect(await stockAt(tx, beras.id, a.id)).toBe(3000);
      expect(await stockAt(tx, beras.id, b.id)).toBe(1000);
      expect(await itemStock(tx, beras.id)).toBe(4000);
      expect((await tx.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe('Submitted');
      const inRow = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: transfer.id, movementType: 'TransferIn' } });
      expect(inRow.isCancelled).toBe(false);
    });
  });

  it('a complete transfer still cancels from its active movements', async () => {
    await inRollback(async (tx) => {
      const a = await warehouse(tx, 'Gudang A');
      const b = await warehouse(tx, 'Gudang B');
      const beras = await item(tx, 'Beras', a.id, 5000);
      const transfer = await submitStockTransferInTx(
        tx, { date: DAY, fromWarehouseId: a.id, toWarehouseId: b.id, items: [{ itemId: beras.id, quantity: 1000 }] }, actor.userId,
      );
      const res = await callRoute(stockTransfersRouter, 'patch', '/:id/cancel', { ...actor, params: { id: transfer.id } });
      expect(res.status).toBe(200);
      expect(await stockAt(tx, beras.id, a.id)).toBe(5000);
      expect(await stockAt(tx, beras.id, b.id)).toBe(0);
      expect(await tx.stockMovement.count({ where: { referenceId: transfer.id, isCancelled: false } })).toBe(0);
    });
  });
});

d('source batch of a manual outbound movement', () => {
  it('rejects a batch of another item, a cancelled batch and a non-inbound batch; accepts an active inbound batch', async () => {
    await inRollback(async (tx) => {
      const wh = await warehouse(tx, 'Gudang');
      const beras = await item(tx, 'Beras', wh.id, 1000);
      const bekatul = await item(tx, 'Bekatul', wh.id, 1000);
      const berasBatch = await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'In', quantity: 1000 });
      const cancelledBatch = await movement(tx, { itemId: bekatul.id, warehouseId: wh.id, movementType: 'In', quantity: 100, isCancelled: true });
      const outBatch = await movement(tx, { itemId: bekatul.id, warehouseId: wh.id, movementType: 'Out', quantity: 10 });
      const bekatulBatch = await movement(tx, { itemId: bekatul.id, warehouseId: wh.id, movementType: 'In', quantity: 1000 });

      const out = (sourceMovementId: string) =>
        createMovement({ itemId: bekatul.id, warehouseId: wh.id, movementType: 'Out', quantity: 50, date: DAY, sourceMovementId });

      for (const [batch, why] of [[berasBatch, /tidak cocok/], [cancelledBatch, /sudah dibatalkan/], [outBatch, /bukan stok masuk/]] as const) {
        const res = await out(batch.id);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(MOVEMENT_SOURCE_BATCH_INVALID);
        expect(res.body.error).toMatch(why);
      }
      expect(await stockAt(tx, bekatul.id, wh.id)).toBe(1000);

      const ok = await out(bekatulBatch.id);
      expect(ok.status).toBe(201);
      expect(ok.body.sourceMovementId).toBe(bekatulBatch.id);
      expect(await stockAt(tx, bekatul.id, wh.id)).toBe(950);
    });
  });
});

d('references sent by a client', () => {
  it('POST In with referenceType SalesReturn stores no reference, and the movement can still be cancelled', async () => {
    await inRollback(async (tx) => {
      const wh = await warehouse(tx, 'Gudang');
      const beras = await item(tx, 'Beras', wh.id, 0);
      const created = await createMovement({
        itemId: beras.id, warehouseId: wh.id, movementType: 'In', quantity: 20, date: DAY,
        referenceType: 'SalesReturn', referenceId: '00000000-0000-4000-8000-000000000001', referenceNumber: 'NOTA-9',
      });
      expect(created.status).toBe(201);
      const row = await tx.stockMovement.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row).toMatchObject({ referenceType: null, referenceId: null, referenceNumber: 'NOTA-9' });

      const cancel = await cancelMovement(row.id);
      expect(cancel.status).toBe(200);
      expect(await stockAt(tx, beras.id, wh.id)).toBe(0);
    });
  });

  it('PUT with referenceType in the body leaves the column unchanged (also on an old manual row that has one)', async () => {
    await inRollback(async (tx) => {
      const wh = await warehouse(tx, 'Gudang');
      const beras = await item(tx, 'Beras', wh.id, 100);
      const manual = await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'In', quantity: 10 });
      // Before E3-R2 the modal offered PurchaseInvoice/SalesInvoice: a reference type without a referenceId.
      const legacy = await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'In', quantity: 10, referenceType: 'PurchaseInvoice' });

      for (const [row, expected] of [[manual, null], [legacy, 'PurchaseInvoice']] as const) {
        const res = await editMovement(row.id, { movementType: 'In', quantity: 12, date: DAY, referenceType: 'GoodsReceipt' });
        expect(res.status).toBe(200);
        const after = await tx.stockMovement.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.referenceType).toBe(expected);
        expect(after.referenceId).toBeNull();
        expect(Number(after.quantity)).toBe(12);
      }
    });
  });
});

d('production, opname and opening balance movements', () => {
  it('per-row cancel is refused before any stock moves', async () => {
    await inRollback(async (tx) => {
      const wh = await warehouse(tx, 'Gudang');
      const beras = await item(tx, 'Beras', wh.id, 100);
      const run = await tx.productionRun.create({ data: { runNumber: `IT-E3R2-PR-${tag()}`, date: DATE, fiscalYearId: fy.id, createdById: actor.userId } });
      const so = await tx.stockOpname.create({
        data: { opnameNumber: `IT-E3R2-SO-${tag()}`, date: DATE, status: 'Submitted', fiscalYearId: fy.id, createdById: actor.userId, submittedAt: DATE },
      });
      const rows = [
        [await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'In', quantity: 5, referenceType: 'ProductionRun', referenceId: run.id }), /halaman Produksi/],
        [await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'AdjustmentIn', quantity: 5, referenceType: 'StockOpname', referenceId: so.id }), /halaman Stok Opname/],
        [await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'In', quantity: 5, referenceType: 'OpeningBalance' }), /Penyesuaian Stok/],
      ] as const;
      for (const [row, where] of rows) {
        const res = await cancelMovement(row.id);
        expect(res.status, row.referenceType!).toBe(400);
        expect(res.body.code).toBe(MOVEMENT_DOCUMENT_LOCKED);
        expect(res.body.error).toMatch(where);
        expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: row.id } })).isCancelled).toBe(false);
      }
      expect(await stockAt(tx, beras.id, wh.id)).toBe(100);
      expect(await itemStock(tx, beras.id)).toBe(100);
    });
  });

  it('old data: an opname whose movement was already cancelled per row reverses only its active line', async () => {
    await inRollback(async (tx) => {
      const wh = await warehouse(tx, 'Gudang');
      const beras = await item(tx, 'Beras', wh.id, 100);
      const bekatul = await item(tx, 'Bekatul', wh.id, 100);
      const so = await tx.stockOpname.create({
        data: { opnameNumber: `IT-E3R2-SO-${tag()}`, date: DATE, status: 'Submitted', fiscalYearId: fy.id, createdById: actor.userId, submittedAt: DATE, warehouseId: wh.id },
      });
      // Opname: beras +10 (surplus), bekatul −20 (shortage), applied to stock.
      const surplus = await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'AdjustmentIn', quantity: 10, referenceType: 'StockOpname', referenceId: so.id });
      const shortage = await movement(tx, { itemId: bekatul.id, warehouseId: wh.id, movementType: 'AdjustmentOut', quantity: 20, referenceType: 'StockOpname', referenceId: so.id });
      await tx.stockOpnameItem.createMany({
        data: [
          { stockOpnameId: so.id, itemId: beras.id, warehouseId: wh.id, systemStock: 100, actualStock: 110, difference: 10, movementId: surplus.id },
          { stockOpnameId: so.id, itemId: bekatul.id, warehouseId: wh.id, systemStock: 100, actualStock: 80, difference: -20, movementId: shortage.id },
        ],
      });
      for (const [id, delta] of [[beras.id, 10], [bekatul.id, -20]] as const) {
        await tx.inventoryItem.update({ where: { id }, data: { currentStock: { increment: delta } } });
        await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: id, warehouseId: wh.id } }, data: { currentStock: { increment: delta } } });
      }
      // Old per-row cancel of the shortage movement: flagged cancelled and its 20 kg already put back.
      await tx.stockMovement.update({ where: { id: shortage.id }, data: { isCancelled: true } });
      await tx.inventoryItem.update({ where: { id: bekatul.id }, data: { currentStock: { increment: 20 } } });
      await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: bekatul.id, warehouseId: wh.id } }, data: { currentStock: { increment: 20 } } });

      const res = await callRoute(stockOpnameRouter, 'put', '/:id/cancel', { ...actor, params: { id: so.id } });
      expect(res.status).toBe(200);

      expect(await stockAt(tx, beras.id, wh.id)).toBe(100);
      expect(await itemStock(tx, beras.id)).toBe(100);
      // Not 120: the cancelled line is not reversed a second time.
      expect(await stockAt(tx, bekatul.id, wh.id)).toBe(100);
      expect(await itemStock(tx, bekatul.id)).toBe(100);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: surplus.id } })).isCancelled).toBe(true);
      expect((await tx.stockOpname.findUniqueOrThrow({ where: { id: so.id } })).status).toBe('Cancelled');
    });
  });

  it('old data: an opname movement edited in place to 30 kg is reversed by its own 30 kg, not the line difference of 100', async () => {
    await inRollback(async (tx) => {
      const wh = await warehouse(tx, 'Gudang');
      const beras = await item(tx, 'Beras', wh.id, 500);
      const so = await tx.stockOpname.create({
        data: { opnameNumber: `IT-E3R2-SO-${tag()}`, date: DATE, status: 'Submitted', fiscalYearId: fy.id, createdById: actor.userId, submittedAt: DATE, warehouseId: wh.id },
      });
      // Opname +100 (500 -> 600), then the old per-row edit rewrote the movement to 30 kg in place
      // (600 - 100 + 30 = 530), keeping referenceType StockOpname and the referenceId.
      const mov = await movement(tx, { itemId: beras.id, warehouseId: wh.id, movementType: 'AdjustmentIn', quantity: 30, referenceType: 'StockOpname', referenceId: so.id });
      await tx.stockOpnameItem.create({
        data: { stockOpnameId: so.id, itemId: beras.id, warehouseId: wh.id, systemStock: 500, actualStock: 600, difference: 100, movementId: mov.id },
      });
      await tx.inventoryItem.update({ where: { id: beras.id }, data: { currentStock: 530 } });
      await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: beras.id, warehouseId: wh.id } }, data: { currentStock: 530 } });

      const res = await callRoute(stockOpnameRouter, 'put', '/:id/cancel', { ...actor, params: { id: so.id } });
      expect(res.status).toBe(200);
      // Not 430: undoing the opname returns the stock to 500.
      expect(await stockAt(tx, beras.id, wh.id)).toBe(500);
      expect(await itemStock(tx, beras.id)).toBe(500);
      expect((await tx.stockMovement.findUniqueOrThrow({ where: { id: mov.id } })).isCancelled).toBe(true);
    });
  });
});

d('e3-movement-reference-audit', () => {
  it('lists typed references, cancelled rows of active documents, bad batch links and orphan document ids', async () => {
    await inRollback(async (tx) => {
      const a = await warehouse(tx, 'Gudang A');
      const b = await warehouse(tx, 'Gudang B');
      const beras = await item(tx, 'Beras', a.id, 5000);
      const bekatul = await item(tx, 'Bekatul', a.id, 100);
      const transfer = await submitStockTransferInTx(
        tx, { date: DAY, fromWarehouseId: a.id, toWarehouseId: b.id, items: [{ itemId: beras.id, quantity: 1000 }] }, actor.userId,
      );
      const out = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: transfer.id, movementType: 'TransferOut' } });
      await tx.stockMovement.update({ where: { id: out.id }, data: { isCancelled: true } });

      const typed = await movement(tx, { itemId: beras.id, warehouseId: a.id, movementType: 'In', quantity: 1, referenceType: 'SalesInvoice' });
      const opening = await movement(tx, { itemId: beras.id, warehouseId: a.id, movementType: 'In', quantity: 1, referenceType: 'OpeningBalance' });
      const berasBatch = await movement(tx, { itemId: beras.id, warehouseId: a.id, movementType: 'In', quantity: 10 });
      const wrongBatch = await tx.stockMovement.update({
        where: { id: (await movement(tx, { itemId: bekatul.id, warehouseId: a.id, movementType: 'Out', quantity: 1 })).id },
        data: { sourceMovementId: berasBatch.id },
      });
      const okBatch = await tx.stockMovement.update({
        where: { id: (await movement(tx, { itemId: beras.id, warehouseId: a.id, movementType: 'Out', quantity: 1 })).id },
        data: { sourceMovementId: berasBatch.id },
      });
      const inboundLinked = await tx.stockMovement.update({
        where: { id: (await movement(tx, { itemId: beras.id, warehouseId: a.id, movementType: 'In', quantity: 1 })).id },
        data: { sourceMovementId: berasBatch.id },
      });
      const orphanId = await movement(tx, { itemId: beras.id, warehouseId: a.id, movementType: 'In', quantity: 1, referenceId: transfer.id });
      const missingDoc = await movement(tx, {
        itemId: beras.id, warehouseId: a.id, movementType: 'In', quantity: 1, referenceType: 'GoodsReceipt', referenceId: '00000000-0000-4000-8000-0000000000ff',
      });

      const mine = new Set([out.id, typed.id, opening.id, berasBatch.id, wrongBatch.id, okBatch.id, inboundLinked.id, orphanId.id, missingDoc.id]);
      const found = (await findMovementReferenceIssues(tx)).filter((r) => mine.has(r.id));
      const byList = (l: string) => found.filter((r) => r.list === l).map((r) => [r.id, r.note]);
      expect(byList('a')).toEqual([[typed.id, expect.stringMatching(/client/)]]);
      expect(byList('b')).toEqual([[out.id, expect.stringMatching(/^certain/)]]);
      expect(byList('c').sort()).toEqual([
        [wrongBatch.id, 'batch of another item'],
        [inboundLinked.id, 'inbound row links a batch'],
      ].sort());
      expect(byList('d').sort()).toEqual([
        [orphanId.id, expect.stringMatching(/without reference type/)],
        [missingDoc.id, 'no GoodsReceipt with this id'],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    });
  });
  it('lists opname and transfer movements edited away from their line, and a cancelled transfer that left stock short', async () => {
    await inRollback(async (tx) => {
      const a = await warehouse(tx, 'Gudang A');
      const b = await warehouse(tx, 'Gudang B');
      const beras = await item(tx, 'Beras', a.id, 5000);
      const jagung = await item(tx, 'Jagung', a.id, 5000);
      const gabah = await item(tx, 'Gabah', a.id, 500);
      // Opening rows so each warehouse's stock matches its movements before the old damage.
      for (const it of [beras, jagung]) await movement(tx, { itemId: it.id, warehouseId: a.id, movementType: 'In', quantity: 5000 });
      await movement(tx, { itemId: gabah.id, warehouseId: a.id, movementType: 'In', quantity: 500 });

      // (e) opname line +100 whose movement the old edit rewrote to 30 kg; a matching line is not listed.
      const so = await tx.stockOpname.create({
        data: { opnameNumber: `IT-E3R2-SO-${tag()}`, date: DATE, status: 'Submitted', fiscalYearId: fy.id, createdById: actor.userId, submittedAt: DATE, warehouseId: a.id },
      });
      const edited = await movement(tx, { itemId: gabah.id, warehouseId: a.id, movementType: 'AdjustmentIn', quantity: 30, referenceType: 'StockOpname', referenceId: so.id });
      const intact = await movement(tx, { itemId: jagung.id, warehouseId: a.id, movementType: 'AdjustmentOut', quantity: 20, referenceType: 'StockOpname', referenceId: so.id });
      await tx.stockOpnameItem.createMany({
        data: [
          { stockOpnameId: so.id, itemId: gabah.id, warehouseId: a.id, systemStock: 500, actualStock: 600, difference: 100, movementId: edited.id },
          { stockOpnameId: so.id, itemId: jagung.id, warehouseId: a.id, systemStock: 5000, actualStock: 4980, difference: -20, movementId: intact.id },
        ],
      });

      // (e) active transfer whose TransferOut the old edit turned into an Out of 300 kg.
      const t1 = await submitStockTransferInTx(
        tx, { date: DAY, fromWarehouseId: a.id, toWarehouseId: b.id, items: [{ itemId: jagung.id, quantity: 1000 }] }, actor.userId,
      );
      const t1Out = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: t1.id, movementType: 'TransferOut' } });
      const t1In = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: t1.id, movementType: 'TransferIn' } });
      await tx.stockMovement.update({ where: { id: t1Out.id }, data: { movementType: 'Out', quantity: 300 } });

      // (f) transfer 1,000 kg A -> B; its TransferOut cancelled per row with the wrong sign (A -1,000),
      // then the old transfer cancel reversed the whole transfer (A +1,000, B -1,000) and flagged every row.
      const t2 = await submitStockTransferInTx(
        tx, { date: DAY, fromWarehouseId: a.id, toWarehouseId: b.id, items: [{ itemId: beras.id, quantity: 1000 }] }, actor.userId,
      );
      const t2Out = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: t2.id, movementType: 'TransferOut' } });
      const t2In = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: t2.id, movementType: 'TransferIn' } });
      const shift = async (warehouseId: string, delta: number) => {
        await tx.inventoryItem.update({ where: { id: beras.id }, data: { currentStock: { increment: delta } } });
        await tx.inventoryStock.update({ where: { itemId_warehouseId: { itemId: beras.id, warehouseId } }, data: { currentStock: { increment: delta } } });
      };
      await shift(a.id, -1000);
      await shift(a.id, 1000);
      await shift(b.id, -1000);
      await tx.stockMovement.updateMany({ where: { referenceId: t2.id }, data: { isCancelled: true } });
      await tx.stockTransfer.update({ where: { id: t2.id }, data: { status: 'Cancelled', cancelledAt: DATE } });

      const mine = new Set([edited.id, intact.id, t1Out.id, t1In.id, t2Out.id, t2In.id]);
      const found = (await findMovementReferenceIssues(tx)).filter((r) => mine.has(r.id));
      const byList = (l: string) => found.filter((r) => r.list === l).map((r) => [r.id, r.note]);
      expect(byList('e').sort()).toEqual([
        [edited.id, 'opname line difference 100.000'],
        [t1Out.id, 'transfer line quantity 1000.000'],
      ].sort());
      // Only the source warehouse is short; B's stock still matches its (all cancelled) movements.
      expect(byList('f')).toEqual([[t2Out.id, expect.stringMatching(/^review: .* -1000(\.0+)? off/)]]);
      expect(found.filter((r) => r.list !== 'e' && r.list !== 'f')).toEqual([]);
    });
  });
});
