// Item vs warehouse quantity drift (owner decision #18, PR-6.3d): the gate before the value ledger.
// inventory_items.current_stock is the total of an item; inventory_stocks holds it per warehouse.
// Where the total is higher, the excess is stock that no warehouse holds: since the stock locks it
// cannot be taken out of any warehouse, yet it counts in the inventory value (qty x average). The
// value ledger migration (PR-6.4b1) refuses to run while any item drifts.
//
// findStockDrift lists the drifting items for the accountant; applyStockDriftPlan carries out
// the decided plan (stockDriftPlan.ts) in one transaction: the item rows are locked once up front
// (lock order, stockLocks.ts), the drift is re-read under the lock and must still equal the plan,
// then per item manualMovement.ts books `assign` quantities into warehouses and posts the
// `writeoff` Adjustment − with its journal. One audit row per item. Nothing is decided here.

import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { businessToday } from '../../utils/businessDate';
import { STOCK_DRIFT_REFERENCE } from '../documentMovementLock';
import { lockInventoryRows } from './stockLocks';
import { placeUnplacedStockInTx, writeOffUnplacedStockInTx } from './manualMovement';
import { stalePlanErrors, type DriftItemPlan } from './stockDriftPlan';

type Tx = Prisma.TransactionClient;
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

export const STOCK_DRIFT_AUDIT_ACTION = 'e3-stock-drift';

export interface StockDriftRow {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  itemQty: Decimal;
  warehouseQty: Decimal;
  /** itemQty − warehouseQty: stock that no warehouse holds (negative: the warehouses hold more). */
  drift: Decimal;
  averageCost: Decimal;
  /** round(drift x average, 2): the value carried without warehouse stock. */
  driftValue: Decimal;
  /** Active movements without a warehouse (other than this repair's and value-only Revaluation rows): where the drift usually came from. */
  unwarehousedMovements: number;
  unwarehousedNetQty: Decimal;
  /** Per warehouse holding stock, `CODE:qty` joined by ';'. */
  warehouses: string;
}

interface RawDrift {
  itemId: string; code: string; name: string; unit: string; itemQty: string; warehouseQty: string;
  drift: string; averageCost: string; driftValue: string; unwarehousedMovements: number; unwarehousedNetQty: string; warehouses: string;
}

/** Drifting items, largest value first; `itemIds` narrows the list (the apply reads its items under lock). */
export async function findStockDrift(db: Db, opts: { itemIds?: string[] } = {}): Promise<StockDriftRow[]> {
  const only = opts.itemIds ? Prisma.sql`AND i.id = ANY(${opts.itemIds}::text[])` : Prisma.empty;
  const rows = await db.$queryRaw<RawDrift[]>`
    WITH wh AS (
      SELECT s.item_id, SUM(s.current_stock) AS qty,
             string_agg(w.code || ':' || s.current_stock::text, ';' ORDER BY w.code) FILTER (WHERE s.current_stock <> 0) AS per_wh
        FROM inventory_stocks s JOIN warehouses w ON w.id = s.warehouse_id
       GROUP BY s.item_id
    ), loose AS (
      SELECT m.item_id, COUNT(*)::int AS n,
             SUM(CASE WHEN m.movement_type::text IN ('In', 'AdjustmentIn', 'TransferIn') THEN m.quantity ELSE -m.quantity END) AS net
        FROM stock_movements m
       WHERE m.warehouse_id IS NULL AND NOT m.is_cancelled AND m.reference_type IS DISTINCT FROM ${STOCK_DRIFT_REFERENCE}
         AND m.movement_type::text <> 'Revaluation'
       GROUP BY m.item_id
    )
    SELECT i.id AS "itemId", i.code, i.name, i.unit,
           i.current_stock::text AS "itemQty", COALESCE(wh.qty, 0)::text AS "warehouseQty",
           (i.current_stock - COALESCE(wh.qty, 0))::text AS drift, i.average_cost::text AS "averageCost",
           ROUND((i.current_stock - COALESCE(wh.qty, 0)) * i.average_cost, 2)::text AS "driftValue",
           COALESCE(loose.n, 0) AS "unwarehousedMovements", COALESCE(loose.net, 0)::text AS "unwarehousedNetQty",
           COALESCE(wh.per_wh, '') AS warehouses
      FROM inventory_items i
      LEFT JOIN wh ON wh.item_id = i.id
      LEFT JOIN loose ON loose.item_id = i.id
     WHERE i.current_stock <> COALESCE(wh.qty, 0) ${only}
     ORDER BY ABS((i.current_stock - COALESCE(wh.qty, 0)) * i.average_cost) DESC, ABS(i.current_stock - COALESCE(wh.qty, 0)) DESC, i.code`;
  return rows.map((r) => ({
    ...r,
    itemQty: new Decimal(r.itemQty),
    warehouseQty: new Decimal(r.warehouseQty),
    drift: new Decimal(r.drift),
    averageCost: new Decimal(r.averageCost),
    driftValue: new Decimal(r.driftValue),
    unwarehousedNetQty: new Decimal(r.unwarehousedNetQty),
  }));
}

export interface DriftItemResult {
  itemId: string;
  code: string;
  assigned: { warehouseCode: string; quantity: Decimal }[];
  writtenOff: Decimal;
  /** Value of the write-off journal (0 without one). */
  writeOffValue: Decimal;
  movementId: string | null;
  journalEntryId: string | null;
}

export interface DriftApplyResult {
  approvedBy: string;
  day: string;
  items: DriftItemResult[];
}

/** Warehouse ids by code; an unknown code refuses the plan. */
async function warehousesByCode(tx: Tx, items: readonly DriftItemPlan[]): Promise<Map<string, string>> {
  const codes = [...new Set(items.flatMap((p) => p.assignments.map((a) => a.warehouseCode)))];
  const found = await tx.warehouse.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const byCode = new Map(found.map((w) => [w.code, w.id]));
  const unknown = codes.filter((c) => !byCode.has(c));
  if (unknown.length > 0) throw new Error(`Unknown warehouse_code: ${unknown.join(', ')}. Nothing was applied.`);
  return byCode;
}

async function repairItem(
  tx: Tx,
  p: DriftItemPlan,
  ctx: { before: StockDriftRow; warehouseIds: Map<string, string>; day: string; approvedBy: string; userId: string },
): Promise<DriftItemResult> {
  for (const a of p.assignments) {
    await placeUnplacedStockInTx(tx, { itemId: p.itemId, warehouseId: ctx.warehouseIds.get(a.warehouseCode)!, quantity: a.quantity });
  }
  const movement = p.writeOff.gt(0)
    ? await writeOffUnplacedStockInTx(tx, {
      itemId: p.itemId, quantity: p.writeOff, day: ctx.day,
      notes: `Perbaikan selisih stok vs gudang (stok tidak ada di gudang mana pun), disetujui ${ctx.approvedBy}`,
    }, ctx.userId)
    : null;
  const result: DriftItemResult = {
    itemId: p.itemId,
    code: ctx.before.code,
    assigned: p.assignments.map((a) => ({ warehouseCode: a.warehouseCode, quantity: a.quantity })),
    writtenOff: p.writeOff,
    writeOffValue: movement ? new Decimal(movement.totalValue.toString()) : new Decimal(0),
    movementId: movement?.id ?? null,
    journalEntryId: movement?.journalEntryId ?? null,
  };
  await tx.auditLog.create({
    data: {
      userId: ctx.userId,
      action: STOCK_DRIFT_AUDIT_ACTION,
      entityType: 'InventoryItem',
      entityId: p.itemId,
      oldValues: {
        currentStock: ctx.before.itemQty.toString(), warehouseQty: ctx.before.warehouseQty.toString(), drift: ctx.before.drift.toString(),
        averageCost: ctx.before.averageCost.toString(), warehouses: ctx.before.warehouses,
      },
      newValues: {
        assigned: result.assigned.map((a) => ({ warehouseCode: a.warehouseCode, quantity: a.quantity.toString() })),
        writtenOff: result.writtenOff.toString(), writeOffValue: result.writeOffValue.toFixed(2),
        movementId: result.movementId, journalEntryId: result.journalEntryId, day: ctx.day, lines: p.lines,
      },
      via: 'repair',
      viaMeta: { script: STOCK_DRIFT_AUDIT_ACTION, approvedBy: ctx.approvedBy },
    },
  });
  return result;
}

/**
 * Applies a validated plan (parseDriftPlanCsv without errors) in the caller's transaction: all or
 * nothing. Throws when the plan is stale (drift changed since the dry run), a warehouse code is
 * unknown, the Inventory Variance account is unusable (INVENTORY_VARIANCE_UNSAFE) or the day's
 * period is closed. `day` (YYYY-MM-DD, default today in WIB) dates the write-off journals.
 */
export async function applyStockDriftPlan(
  tx: Tx,
  items: readonly DriftItemPlan[],
  opts: { approvedBy: string; day?: string },
): Promise<DriftApplyResult> {
  const approvedBy = opts.approvedBy.trim();
  if (!approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  const day = opts.day ?? businessToday();
  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');
  const warehouseIds = await warehousesByCode(tx, items);

  const itemIds = items.map((p) => p.itemId);
  const pairs = items.flatMap((p) => p.assignments.map((a) => ({ itemId: p.itemId, warehouseId: warehouseIds.get(a.warehouseCode)! })));
  await lockInventoryRows(tx, { itemIds, pairs });
  const before = new Map((await findStockDrift(tx, { itemIds })).map((r) => [r.itemId, r]));
  const stale = stalePlanErrors(items, new Map([...before].map(([id, r]) => [id, r.drift])));
  if (stale.length > 0) throw new Error(`The plan is stale; nothing was applied. ${stale.join(' ')}`);

  const results: DriftItemResult[] = [];
  for (const p of items) {
    results.push(await repairItem(tx, p, { before: before.get(p.itemId)!, warehouseIds, day, approvedBy, userId: admin.id }));
  }
  const left = await findStockDrift(tx, { itemIds });
  if (left.length > 0) throw new Error(`Drift left after the repair on ${left.map((r) => r.code).join(', ')}; nothing was applied.`);
  return { approvedBy, day, items: results };
}
