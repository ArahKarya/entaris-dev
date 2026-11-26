import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { batchUnitCosts } from './inventoryLedger';

type Db = Pick<Prisma.TransactionClient, 'inventoryItem' | 'inventoryStock' | 'stockMovement' | 'warehouse'>;

/**
 * Remaining quantity per inbound batch (E6-R3, PR-6.9): one rule for the batch picker
 * (GET /inventory/items/:id/batches) and the production check, so the form never offers what the
 * server refuses. A batch is an active inbound movement (In, AdjustmentIn, TransferIn: a transfer
 * carries its goods into the destination warehouse). Its consumption is every active outbound
 * movement that links back to it through source_movement_id (production inputs, transfers). Stock
 * that went out without a link (a delivery order, a manual Stock Out) is absorbed from the oldest
 * batches first, so the batches never add up to more than the stock held.
 */

export const PRODUCTION_BATCH_QTY_INSUFFICIENT = 'PRODUCTION_BATCH_QTY_INSUFFICIENT';
export const PRODUCTION_BATCH_WAREHOUSE = 'PRODUCTION_BATCH_WAREHOUSE';

const INBOUND_TYPES = ['In', 'AdjustmentIn', 'TransferIn'] as const;
const OUTBOUND_TYPES = ['Out', 'AdjustmentOut', 'TransferOut'] as const;

/** A batch before the untracked outbound is absorbed, oldest first. */
export interface InboundBatch {
  id: string;
  movementNumber: string;
  date: Date;
  warehouseId: string | null;
  quantity: Decimal;
  unitCost: Decimal;
  /** Σ active outbound linked to the batch. */
  consumedTracked: Decimal;
  referenceType: string | null;
  referenceId: string | null;
  referenceNumber: string | null;
}

export interface BatchAvailability extends InboundBatch {
  /** Tracked plus the untracked outbound absorbed from it. */
  consumed: Decimal;
  available: Decimal;
}

/**
 * Pure: absorbs the untracked outbound, max(0, Σ tracked availability − stock held), from the
 * oldest batches (`batches` in date order). A batch already used up by its links absorbs nothing.
 */
export function absorbUntrackedOutbound(batches: readonly InboundBatch[], currentStock: Decimal.Value): BatchAvailability[] {
  const trackedTotal = batches.reduce((s, b) => s.plus(b.quantity.minus(b.consumedTracked)), new Decimal(0));
  let untracked = Decimal.max(0, trackedTotal.minus(currentStock));
  return batches.map((b) => {
    const tracked = b.quantity.minus(b.consumedTracked);
    const absorb = untracked.gt(0) && tracked.gt(0) ? Decimal.min(tracked, untracked) : new Decimal(0);
    untracked = untracked.minus(absorb);
    return { ...b, consumed: b.consumedTracked.plus(absorb), available: tracked.minus(absorb) };
  });
}

/** One production input line that takes from a picked batch. */
export interface BatchNeed {
  /** 1-based input line, named in the refusal. */
  inputLine: number;
  sourceMovementId: string;
  quantity: Decimal.Value;
}

export interface BatchShortfall {
  sourceMovementId: string;
  /** The first input line on the batch. */
  inputLine: number;
  needed: Decimal;
  available: Decimal;
}

/**
 * Pure: the batches asked for more than they hold, lines on one batch summed. A batch missing from
 * `available` holds nothing.
 */
export function batchShortfalls(needs: readonly BatchNeed[], available: ReadonlyMap<string, Decimal>): BatchShortfall[] {
  const summed = new Map<string, { inputLine: number; needed: Decimal }>();
  for (const n of needs) {
    const prev = summed.get(n.sourceMovementId);
    summed.set(n.sourceMovementId, {
      inputLine: prev?.inputLine ?? n.inputLine,
      needed: (prev?.needed ?? new Decimal(0)).plus(n.quantity),
    });
  }
  const out: BatchShortfall[] = [];
  for (const [sourceMovementId, s] of summed) {
    const held = available.get(sourceMovementId) ?? new Decimal(0);
    if (s.needed.gt(held)) out.push({ sourceMovementId, inputLine: s.inputLine, needed: s.needed, available: held });
  }
  return out;
}

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v == null ? 0 : v.toString());

/** Stock held where the batches are counted: the warehouse row, or the item total without a warehouse. */
async function stockHeld(db: Db, itemId: string, warehouseId: string | null, itemTotal: Decimal): Promise<Decimal> {
  if (!warehouseId) return itemTotal;
  const row = await db.inventoryStock.findFirst({ where: { itemId, warehouseId }, select: { currentStock: true } });
  return dec(row?.currentStock);
}

export interface ItemBatchAvailability {
  item: { id: string; code: string; name: string; unit: string };
  /** Stock held in the warehouse (the item total without one). */
  currentStock: Decimal;
  /** Every batch, the used-up ones included, oldest first. */
  batches: BatchAvailability[];
}

/**
 * The batches of an item in one warehouse (all warehouses when `warehouseId` is null, against the
 * item total), with their remaining quantity. Null when the item does not exist.
 */
export async function listBatchAvailability(db: Db, itemId: string, warehouseId: string | null): Promise<ItemBatchAvailability | null> {
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: { id: true, code: true, name: true, unit: true, currentStock: true },
  });
  if (!item) return null;
  const currentStock = await stockHeld(db, itemId, warehouseId, dec(item.currentStock));
  const itemFields = { id: item.id, code: item.code, name: item.name, unit: item.unit };

  const inbound = await db.stockMovement.findMany({
    where: { itemId, isCancelled: false, movementType: { in: [...INBOUND_TYPES] }, ...(warehouseId ? { warehouseId } : {}) },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, movementNumber: true, date: true, warehouseId: true, quantity: true, unitCost: true, totalValue: true, valueDelta: true,
      referenceType: true, referenceId: true, referenceNumber: true,
    },
  });
  if (inbound.length === 0) return { item: itemFields, currentStock, batches: [] };

  const consumed = await db.stockMovement.groupBy({
    by: ['sourceMovementId'],
    where: { sourceMovementId: { in: inbound.map((m) => m.id) }, isCancelled: false, movementType: { in: [...OUTBOUND_TYPES] } },
    _sum: { quantity: true },
  });
  const consumedById = new Map(consumed.map((c) => [c.sourceMovementId, dec(c._sum.quantity)]));
  // The batch cost includes the purchase invoice Revaluations that adjust the row (never rewritten).
  const costs = await batchUnitCosts(db as Prisma.TransactionClient, inbound);

  const batches = inbound.map((m): InboundBatch => ({
    id: m.id,
    movementNumber: m.movementNumber,
    date: m.date,
    warehouseId: m.warehouseId,
    quantity: dec(m.quantity),
    unitCost: costs.get(m.id) ?? dec(m.unitCost),
    consumedTracked: consumedById.get(m.id) ?? new Decimal(0),
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    referenceNumber: m.referenceNumber,
  }));
  return { item: itemFields, currentStock, batches: absorbUntrackedOutbound(batches, currentStock) };
}

const qtyText = (n: Decimal) => n.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

export interface AssertBatchQuantitiesOptions {
  /** The production warehouse: a picked batch must be there. */
  warehouseId: string;
  /** Batches the edited run already took from, kept even outside the production warehouse (old runs). */
  keepBatchIds?: ReadonlySet<string>;
}

/**
 * Production input lines that pick a batch (each already checked by assertBatchSource): the batch
 * must sit in the production warehouse (owner decision #10; an edit keeps the batches its run
 * already used), and it must still hold what its lines ask for, lines on one batch summed. Call it
 * under the item lock and before the inputs are posted; an edit calls it after its old movements
 * are reversed, so the run's own consumption is back in the batch.
 */
export async function assertBatchQuantities(tx: Db, needs: readonly BatchNeed[], opts: AssertBatchQuantitiesOptions): Promise<void> {
  if (needs.length === 0) return;
  const ids = [...new Set(needs.map((n) => n.sourceMovementId))];
  const rows = await tx.stockMovement.findMany({
    where: { id: { in: ids } },
    select: { id: true, itemId: true, warehouseId: true, movementNumber: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const misplaced = needs.find((n) => {
    const batch = byId.get(n.sourceMovementId);
    return batch && batch.warehouseId !== opts.warehouseId && !opts.keepBatchIds?.has(batch.id);
  });
  if (misplaced) {
    const batch = byId.get(misplaced.sourceMovementId)!;
    const warehouse = await tx.warehouse.findUnique({ where: { id: opts.warehouseId }, select: { name: true } });
    throw new BusinessError(
      `Batch ${batch.movementNumber} (input ke-${misplaced.inputLine}) tidak berada di gudang produksi ${warehouse?.name ?? opts.warehouseId}. Pilih batch dari gudang produksi.`,
      PRODUCTION_BATCH_WAREHOUSE,
    );
  }

  // Availability is counted where each batch sits (its warehouse; the item total for a legacy row without one).
  const available = new Map<string, Decimal>();
  const units = new Map<string, string>();
  const scopes = new Map<string, { itemId: string; warehouseId: string | null }>();
  for (const r of rows) scopes.set(`${r.itemId}:${r.warehouseId ?? ''}`, { itemId: r.itemId, warehouseId: r.warehouseId });
  for (const scope of scopes.values()) {
    const listed = await listBatchAvailability(tx, scope.itemId, scope.warehouseId);
    if (!listed) continue;
    for (const b of listed.batches) {
      available.set(b.id, b.available);
      units.set(b.id, listed.item.unit);
    }
  }

  const [short] = batchShortfalls(needs, available);
  if (short) {
    const unit = units.get(short.sourceMovementId) ?? '';
    throw new BusinessError(
      `Sisa batch ${byId.get(short.sourceMovementId)?.movementNumber ?? short.sourceMovementId} (input ke-${short.inputLine}) tidak cukup: tersedia ${qtyText(short.available)} ${unit}, diminta ${qtyText(short.needed)} ${unit}.`,
      PRODUCTION_BATCH_QTY_INSUFFICIENT,
    );
  }
}
