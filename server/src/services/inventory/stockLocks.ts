/**
 * Row locks and the stock-availability check for every writer of stock (E3-R3).
 *
 * LOCK ORDER (one order for the whole app; a path that takes these in another order can deadlock
 * against one that follows it, and Postgres then aborts one of them with 40P01):
 *   1. the document: its header row lock or cancel claim (claimCancel, SELECT ... FOR UPDATE), and
 *      a document-number advisory lock taken for the document itself (STT, ST, SO, ...);
 *   2. lockInventoryRows, ONCE per transaction, with every item the operation touches (old and new
 *      items of an edit, both warehouses of a transfer);
 *   3. stock movement and journal numbers (generateDocumentNumber 'SM' / 'JV');
 *   4. the account rows that posting a journal locks (postJournal, updateAccountBalance).
 * The fiscal-year share lock of the period guards may come before step 1 or 2: it only conflicts
 * with a year close, which takes no stock lock. A sales return (submit and cancel) and the sales
 * invoice cancel lock the AR account row before their document (lockArThenSalesInvoiceInTx, the
 * order payments take), so for them that row is part of step 1: no path may lock AR while it holds
 * item rows unless it locked AR first. Delivery notes are documents of the invoice that bills them
 * (sales invoice submit and cancel lock them in id order before any item or account).
 *
 * The rows are locked FOR NO KEY UPDATE, the lock a plain UPDATE of current_stock takes: stock
 * writers still exclude each other and the item master edit (FOR UPDATE), but a document line that
 * only references the item (FK check, FOR KEY SHARE) neither waits for nor blocks a posting.
 *
 * Stock available is per warehouse (inventory_stocks); inventory_items.current_stock is the total
 * across warehouses and is used only for legacy movements that have no warehouse.
 */
import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError, STOCK_BUSY, STOCK_BUSY_MESSAGE } from '../../utils/errors';
import { isLockTimeout } from '../../utils/periodGuard';
import { getWarehouseStockMap } from '../../utils/warehouseStock';
import { logger } from '../../lib/logger';

type Tx = Prisma.TransactionClient;

/** Error code (400): a warehouse holds less than the operation takes out. */
export const STOCK_INSUFFICIENT = 'STOCK_INSUFFICIENT';
/** Error code (409): another posting held the item rows past STOCK_LOCK_WAIT_MS (or deadlocked); retry. */
export { STOCK_BUSY };
/** How long lockInventoryRows waits for rows held by another posting before STOCK_BUSY. */
export const STOCK_LOCK_WAIT_MS = 5000;

/** Stock an operation takes out of one warehouse; warehouseId null only for legacy movements. */
export interface StockNeed {
  itemId: string;
  warehouseId: string | null;
  quantity: Decimal.Value;
}

export interface LockedItem {
  id: string;
  name: string;
  unit: string;
  isActive: boolean;
  accountId: string | null;
  /** Total across warehouses. */
  currentStock: Decimal;
  averageCost: Decimal;
  /** Value ledger book value (E3-R6): Σ active value_delta of the item. */
  stockValue: Decimal;
}

export interface LockedStock {
  itemId: string;
  warehouseId: string;
  currentStock: Decimal;
}

export interface LockedInventory {
  /** Locked items by id; an id that does not exist is absent. */
  items: Map<string, LockedItem>;
  /** Locked warehouse rows by stockKey(itemId, warehouseId). */
  stocks: Map<string, LockedStock>;
}

/** A stock shortage found by assertStockAvailable. */
export interface StockShortage {
  itemId: string;
  itemName: string;
  unit: string;
  /** null: checked against the item total (legacy movement without a warehouse). */
  warehouseId: string | null;
  warehouseName: string | null;
  available: Decimal;
  needed: Decimal;
}

export interface AssertStockOptions {
  /** The caller already passed negativeStockGate (inventory.negative_stock + reason). */
  allowNegative?: boolean;
  reason?: string | null;
  /** Where the check runs, for the bypass and legacy logs (e.g. 'goodsReceipt.cancel'). */
  context: string;
  userId?: string;
  /** The stock is needed to reverse an earlier inbound (edit or cancel): words the message so. */
  reversal?: boolean;
  /** Builds the error for the first shortage, for paths whose clients read their own code. */
  error?: (shortage: StockShortage) => BusinessError;
}

export const stockKey = (itemId: string, warehouseId: string) => `${itemId}::${warehouseId}`;

const formatQty = (d: Decimal) => d.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Runs `fn` with lock_timeout bounded by STOCK_LOCK_WAIT_MS and puts the caller's value back. */
async function withStockLockWait<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const before = await tx.$queryRaw<{ lock_timeout?: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${STOCK_LOCK_WAIT_MS}ms`}, true)`;
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    if (!isLockTimeout(err)) throw err;
    throw new BusinessError(STOCK_BUSY_MESSAGE, STOCK_BUSY, 409);
  }
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${before[0]?.lock_timeout ?? '0'}, true)`;
  return result;
}

/**
 * Locks the item rows (ORDER BY id FOR NO KEY UPDATE), creates the (item, warehouse) rows that do not
 * exist yet (ON CONFLICT DO NOTHING) so they can be locked too, then locks those rows (ORDER BY id).
 * Call it once per transaction, before the first stock write and before any SM/JV number or
 * account lock (see LOCK ORDER above). Idempotent within a transaction. The returned rows are read
 * after the locks, so callers read stock and average cost from here, not from an earlier read.
 * Pairs whose item or warehouse does not exist are skipped; the caller reports them.
 * createMissing: false locks only the pairs that already have a row and leaves the others out of
 * `stocks` (stock 0): for a reader of many items, such as an opname count, that writes few. The
 * item lock still serializes them, and the writer creates the row when it moves stock.
 */
export async function lockInventoryRows(
  tx: Tx,
  rows: { itemIds: string[]; pairs?: { itemId: string; warehouseId: string }[]; createMissing?: boolean },
): Promise<LockedInventory> {
  const pairs = rows.pairs ?? [];
  const itemIds = [...new Set([...rows.itemIds, ...pairs.map((p) => p.itemId)])].sort();
  if (itemIds.length === 0) return { items: new Map(), stocks: new Map() };

  return withStockLockWait(tx, async () => {
    await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ANY(${itemIds}::text[]) ORDER BY id FOR NO KEY UPDATE`;
    const itemRows = await tx.inventoryItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, name: true, unit: true, isActive: true, accountId: true, currentStock: true, averageCost: true, stockValue: true },
    });
    const items = new Map<string, LockedItem>(itemRows.map((i) => [i.id, {
      ...i,
      currentStock: new Decimal(i.currentStock.toString()),
      averageCost: new Decimal(i.averageCost.toString()),
      stockValue: new Decimal(i.stockValue.toString()),
    }]));

    const warehouseIds = [...new Set(pairs.map((p) => p.warehouseId))];
    const known = new Set((await tx.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true } })).map((w) => w.id));
    const wanted = [...new Map(pairs
      .filter((p) => items.has(p.itemId) && known.has(p.warehouseId))
      .map((p) => [stockKey(p.itemId, p.warehouseId), p])).values()];
    const stocks = new Map<string, LockedStock>();
    if (wanted.length === 0) return { items, stocks };

    if (rows.createMissing !== false) {
      await tx.inventoryStock.createMany({
        data: wanted.map((p) => ({ itemId: p.itemId, warehouseId: p.warehouseId, currentStock: 0 })),
        skipDuplicates: true,
      });
    }
    const where = { OR: wanted.map((p) => ({ itemId: p.itemId, warehouseId: p.warehouseId })) };
    const ids = (await tx.inventoryStock.findMany({ where, select: { id: true } })).map((r) => r.id);
    if (ids.length === 0) return { items, stocks };
    await tx.$queryRaw`SELECT id FROM inventory_stocks WHERE id = ANY(${ids}::text[]) ORDER BY id FOR NO KEY UPDATE`;
    for (const r of await tx.inventoryStock.findMany({ where, select: { itemId: true, warehouseId: true, currentStock: true } })) {
      stocks.set(stockKey(r.itemId, r.warehouseId), { ...r, currentStock: new Decimal(r.currentStock.toString()) });
    }
    return { items, stocks };
  });
}

/** Sums the needs per (item, warehouse); quantities <= 0 take nothing out and are dropped. */
export function sumStockNeeds(needs: StockNeed[]): StockNeed[] {
  const byKey = new Map<string, { itemId: string; warehouseId: string | null; quantity: Decimal }>();
  for (const n of needs) {
    const qty = new Decimal(n.quantity);
    if (qty.lte(0)) continue;
    const key = `${n.itemId}::${n.warehouseId ?? ''}`;
    const prev = byKey.get(key);
    byKey.set(key, { itemId: n.itemId, warehouseId: n.warehouseId, quantity: prev ? prev.quantity.plus(qty) : qty });
  }
  return [...byKey.values()];
}

function shortageError(s: StockShortage, reversal: boolean): BusinessError {
  const where = s.warehouseName ?? 'semua gudang';
  const available = formatQty(s.available);
  const needed = formatQty(s.needed);
  return new BusinessError(
    reversal
      ? `Stok '${s.itemName}' di ${where} tidak cukup untuk pembalikan: tersedia ${available} ${s.unit}, dibutuhkan ${needed} ${s.unit}.`
      : `Stok '${s.itemName}' di ${where} tidak cukup: tersedia ${available} ${s.unit}, dibutuhkan ${needed} ${s.unit}.`,
    STOCK_INSUFFICIENT,
  );
}

/** Available stock for each summed need: per warehouse, or the item total for a legacy null warehouse. */
async function availableFor(tx: Tx, needs: StockNeed[]): Promise<Decimal[]> {
  const pairs = needs.filter((n): n is StockNeed & { warehouseId: string } => n.warehouseId !== null);
  const perWarehouse = await getWarehouseStockMap(tx, pairs.map((n) => ({ itemId: n.itemId, warehouseId: n.warehouseId })));
  const legacyIds = needs.filter((n) => n.warehouseId === null).map((n) => n.itemId);
  const totals = legacyIds.length === 0
    ? new Map<string, Decimal>()
    : new Map((await tx.inventoryItem.findMany({ where: { id: { in: legacyIds } }, select: { id: true, currentStock: true } }))
      .map((i) => [i.id, new Decimal(i.currentStock.toString())]));
  return needs.map((n) => n.warehouseId === null
    ? totals.get(n.itemId) ?? new Decimal(0)
    : new Decimal(perWarehouse.get(stockKey(n.itemId, n.warehouseId)) ?? 0));
}

async function describeShortage(tx: Tx, need: StockNeed, available: Decimal): Promise<StockShortage> {
  const item = await tx.inventoryItem.findUnique({ where: { id: need.itemId }, select: { name: true, unit: true } });
  const wh = need.warehouseId ? await tx.warehouse.findUnique({ where: { id: need.warehouseId }, select: { name: true } }) : null;
  return {
    itemId: need.itemId,
    itemName: item?.name ?? need.itemId,
    unit: item?.unit ?? '',
    warehouseId: need.warehouseId,
    warehouseName: need.warehouseId ? wh?.name ?? need.warehouseId : null,
    available,
    needed: new Decimal(need.quantity),
  };
}

/**
 * Sums the needs per (item, warehouse) and compares them with the stock the transaction sees now
 * (call it after lockInventoryRows, so the figures cannot change before commit). Throws
 * STOCK_INSUFFICIENT for the first shortage, unless opts.allowNegative: then every shortage is
 * logged with opts.context and the reason. A need without a warehouse (legacy movement) is checked
 * against the item total and logged.
 */
export async function assertStockAvailable(tx: Tx, needs: StockNeed[], opts: AssertStockOptions): Promise<void> {
  const summed = sumStockNeeds(needs);
  if (summed.length === 0) return;
  const available = await availableFor(tx, summed);
  for (const [i, need] of summed.entries()) {
    if (need.warehouseId === null) {
      logger.warn({ context: opts.context, itemId: need.itemId }, 'Stock check of a movement without a warehouse uses the item total');
    }
    if (available[i].gte(need.quantity)) continue;
    const shortage = await describeShortage(tx, need, available[i]);
    if (!opts.allowNegative) throw opts.error ? opts.error(shortage) : shortageError(shortage, opts.reversal === true);
    logger.warn(
      {
        context: opts.context, userId: opts.userId, reason: opts.reason, itemId: need.itemId, warehouseId: need.warehouseId,
        available: shortage.available.toNumber(), needed: shortage.needed.toNumber(),
      },
      'Stock check bypassed: negative stock allowed',
    );
  }
}
