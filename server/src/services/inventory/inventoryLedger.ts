/**
 * Inventory value ledger (E3-R6). With services/inventory/inventoryValueMath.ts this is the one
 * value-ledger module: after the train (PR-6.4e) it is the only writer of current_stock,
 * stock_value, average_cost, inventory_stocks and stock_movements. Paths move behind it one train
 * PR at a time; postRevaluation (6.4c2) arrives with its first caller.
 *
 * Every call locks its rows through lockInventoryRows (idempotent in the transaction, so a caller
 * that locked every item of its operation first keeps the LOCK ORDER of stockLocks.ts), then reads
 * stock, stock_value and the average from the locked rows only.
 *
 * The ledger has no permission logic and posts no journal. It decides the value of an outbound row
 * (outboundValue) and returns the signed valueDelta of every posting; the caller posts exactly that
 * amount to inventoryAccountFor(item), so book = GL by construction. Stock availability, the
 * negative-stock gate, the period guard of the caller's document and active-master checks stay with
 * the caller.
 *
 * Rows it writes: value_delta (signed, 2 dp), total_value = |value_delta|, unit_cost =
 * |value_delta| / quantity (6 dp). A transfer leg carries value_delta 0 (value is per item, I-43);
 * its unit_cost / total_value are for display only. A row is never rewritten after it is posted,
 * except is_cancelled when it is reversed and an empty journal_entry_id filled once by
 * linkMovementJournal.
 *
 * Journal link: an inbound caller knows its journal first and passes journalEntryId. An outbound
 * caller only learns the amount from postOutbound, so it posts the journal of −valueDelta after it
 * and links it with linkMovementJournal; no path writes stock_movements outside this module.
 */
import { Prisma, type PrismaClient, type StockMovement } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { businessToday } from '../../utils/businessDate';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { assertPeriodOpen } from '../../utils/periodGuard';
import { logger } from '../../lib/logger';
import { lockInventoryRows, stockKey, type LockedItem } from './stockLocks';
import { UNIT_COST_DP, VALUE_DP, averageAfter, invariantTolerance, outboundValue } from './inventoryValueMath';

type Tx = Prisma.TransactionClient;

/**
 * Error code (409): reversing this row would leave the book wrong without a value true-up (PR-6.5a):
 * an inbound reversal with value after goods of the item went out (unless the stock reaches 0 and
 * is swept), one that takes stock_value below 0 or leaves stock on hand with no value, or a
 * reversal that leaves value at zero stock without sweepAtZero.
 */
export const REVERSAL_NEEDS_TRUE_UP = 'REVERSAL_NEEDS_TRUE_UP';

/** Fields of a new movement row; a new movement always names its warehouse. */
interface MovementBase {
  itemId: string;
  warehouseId: string;
  date: Date;
  fiscalYearId: string;
  createdById: string;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  /** Kept only on a row that carries value: a zero-value row has no counter entry. */
  offsetAccountId?: string | null;
  journalEntryId?: string | null;
  sourceMovementId?: string | null;
  unitCostLoaded?: Decimal.Value | null;
  /** Taken by the caller after lockInventoryRows; the ledger takes an 'SM' number otherwise. */
  movementNumber?: string;
}

export interface InboundInput extends MovementBase {
  movementType: 'In' | 'AdjustmentIn';
  quantity: Decimal.Value;
  /** The amount the caller debits to inventory, >= 0 (rounded to 2 dp). */
  value: Decimal.Value;
}

export interface OutboundInput extends MovementBase {
  movementType: 'Out' | 'AdjustmentOut';
  /** The cost is decided here (outboundValue), never by the caller. */
  quantity: Decimal.Value;
}

/** Both legs of one transfer line; the item total, stock_value and average do not move. */
export interface TransferInput {
  itemId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: Decimal.Value;
  date: Date;
  fiscalYearId: string;
  createdById: string;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceNumber?: string | null;
  /** Picked batch, stored on the TransferOut leg (batch consumption). */
  sourceMovementId?: string | null;
  /** Display only (unit_cost, total_value of both legs): a picked batch's cost; default the locked average. */
  displayUnitCost?: Decimal.Value | null;
  /**
   * Numbers taken by the caller after lockInventoryRows (the ledger takes 'SM' numbers otherwise) and
   * notes. A number is taken from the rows already written, so a caller takes at most the first one.
   */
  out: { movementNumber?: string; notes?: string | null };
  in: { movementNumber?: string; notes?: string | null };
}

export interface PostedTransfer {
  out: StockMovement;
  in: StockMovement;
}

export interface PostedMovement {
  movement: StockMovement;
  /** Signed: + into stock_value (inbound), − out of it (outbound: the credit to inventory). */
  valueDelta: Decimal;
  unitCost: Decimal;
  stockAfter: Decimal;
  stockValueAfter: Decimal;
  averageCostAfter: Decimal;
}

export interface ReverseOptions {
  userId: string;
  /** 'replay' (a value true-up) arrives in PR-6.5a; until then a reversal that needs one is refused. */
  trueUp?: 'none';
  /** Stock that reaches 0 hands its remaining value to the caller as toCogs (one Revaluation row). */
  sweepAtZero?: boolean;
  /** Business day (YYYY-MM-DD) of the sweep row and of the caller's COGS journal; default today (WIB). */
  journalDay?: string;
}

export interface ReverseResult {
  /** The reversed row, now cancelled. */
  movement: StockMovement;
  /** −(the row's value_delta): the inventory amount of the journal the caller voids. */
  valueDelta: Decimal;
  /** Value swept out at zero stock; the caller posts DR COGS / CR inventory of it (0: nothing swept). */
  toCogs: Decimal;
  /** The Revaluation row of the sweep, or null. */
  sweep: StockMovement | null;
  stockAfter: Decimal;
  stockValueAfter: Decimal;
  averageCostAfter: Decimal;
}

interface ItemState {
  stock: Decimal;
  value: Decimal;
  average: Decimal;
}

const INBOUND_TYPES = new Set(['In', 'AdjustmentIn']);
const OUTBOUND_TYPES = new Set(['Out', 'AdjustmentOut']);
const TRANSFER_TYPES = new Set(['TransferOut', 'TransferIn']);

const dec = (v: { toString(): string }) => new Decimal(v.toString());

function positiveQuantity(q: Decimal.Value, fn: string): Decimal {
  const qty = new Decimal(q);
  if (!qty.isFinite() || qty.lte(0)) throw new Error(`${fn}: quantity must be above 0`);
  return qty;
}

/** Locks the item (and its warehouse rows) and returns it; a missing item or warehouse is refused. */
async function lockItem(tx: Tx, itemId: string, ...warehouseIds: (string | null)[]): Promise<LockedItem> {
  const warehouses = warehouseIds.filter((w): w is string => w !== null);
  const locked = await lockInventoryRows(tx, { itemIds: [itemId], pairs: warehouses.map((warehouseId) => ({ itemId, warehouseId })) });
  const item = locked.items.get(itemId);
  if (!item) throw new BusinessError('Item stok tidak ditemukan.');
  if (warehouses.some((w) => !locked.stocks.has(stockKey(itemId, w)))) throw new BusinessError('Gudang tidak ditemukan.');
  return item;
}

function stateAfter(item: LockedItem, qtyDelta: Decimal, valueDelta: Decimal): ItemState {
  const stock = item.currentStock.plus(qtyDelta);
  const value = item.stockValue.plus(valueDelta);
  return { stock, value, average: averageAfter(stock, value, item.averageCost) };
}

/**
 * The warehouse row (none for a legacy null) and, unless `next` is null (a transfer leg, which moves
 * stock between warehouses only), the item total, book value and average under the lock.
 */
async function writeStock(tx: Tx, itemId: string, warehouseId: string | null, qtyDelta: Decimal, next: ItemState | null): Promise<void> {
  if (warehouseId && !qtyDelta.isZero()) {
    await tx.inventoryStock.update({
      where: { itemId_warehouseId: { itemId, warehouseId } },
      data: { currentStock: { increment: qtyDelta.toString() } },
    });
  }
  if (!next) return;
  await tx.inventoryItem.update({
    where: { id: itemId },
    data: { currentStock: next.stock.toString(), stockValue: next.value.toString(), averageCost: next.average.toString() },
  });
}

/** The one insert of a movement row in this module. */
function insertMovement(tx: Tx, data: Prisma.StockMovementUncheckedCreateInput): Promise<StockMovement> {
  return tx.stockMovement.create({ data });
}

/** Writes one inbound or outbound posting: number, stock, item state, then the movement row. */
async function writePosting(
  tx: Tx,
  i: InboundInput | OutboundInput,
  p: { quantity: Decimal; valueDelta: Decimal; item: LockedItem },
): Promise<PostedMovement> {
  const qtyDelta = INBOUND_TYPES.has(i.movementType) ? p.quantity : p.quantity.negated();
  const next = stateAfter(p.item, qtyDelta, p.valueDelta);
  const unitCost = p.valueDelta.abs().div(p.quantity).toDecimalPlaces(UNIT_COST_DP);
  const movementNumber = i.movementNumber ?? await generateDocumentNumber(tx, 'SM', i.date, i.fiscalYearId);
  await writeStock(tx, i.itemId, i.warehouseId, qtyDelta, next);
  const movement = await insertMovement(tx, {
    movementNumber, date: i.date, itemId: i.itemId, warehouseId: i.warehouseId, movementType: i.movementType,
    quantity: p.quantity.toString(), unitCost: unitCost.toString(),
    totalValue: p.valueDelta.abs().toString(), valueDelta: p.valueDelta.toString(),
    notes: i.notes ?? null, referenceType: i.referenceType ?? null, referenceId: i.referenceId ?? null,
    referenceNumber: i.referenceNumber ?? null, offsetAccountId: p.valueDelta.isZero() ? null : i.offsetAccountId ?? null,
    journalEntryId: i.journalEntryId ?? null, sourceMovementId: i.sourceMovementId ?? null,
    unitCostLoaded: i.unitCostLoaded == null ? null : new Decimal(i.unitCostLoaded).toDecimalPlaces(UNIT_COST_DP).toString(),
    fiscalYearId: i.fiscalYearId, createdById: i.createdById,
  });
  return { movement, valueDelta: p.valueDelta, unitCost, stockAfter: next.stock, stockValueAfter: next.value, averageCostAfter: next.average };
}

/** Puts `quantity` into the warehouse at `value` (the caller's inventory debit); the average blends it. */
export async function postInbound(tx: Tx, i: InboundInput): Promise<PostedMovement> {
  if (!INBOUND_TYPES.has(i.movementType)) throw new Error(`postInbound: ${i.movementType} is not an inbound type`);
  const quantity = positiveQuantity(i.quantity, 'postInbound');
  const value = new Decimal(i.value).toDecimalPlaces(VALUE_DP);
  if (!value.isFinite() || value.lt(0)) throw new Error('postInbound: value must be 0 or more');
  const item = await lockItem(tx, i.itemId, i.warehouseId);
  return writePosting(tx, i, { quantity, valueDelta: value, item });
}

/**
 * Takes `quantity` out of the warehouse at the value outboundValue decides from the locked book;
 * valueDelta is minus that value (the caller's inventory credit and COGS). The caller checks
 * availability (assertStockAvailable) first; past zero stock the row is valued at the average.
 */
export async function postOutbound(tx: Tx, i: OutboundInput): Promise<PostedMovement> {
  if (!OUTBOUND_TYPES.has(i.movementType)) throw new Error(`postOutbound: ${i.movementType} is not an outbound type`);
  const quantity = positiveQuantity(i.quantity, 'postOutbound');
  const item = await lockItem(tx, i.itemId, i.warehouseId);
  const value = outboundValue(item.currentStock, item.stockValue, item.averageCost, quantity);
  return writePosting(tx, i, { quantity, valueDelta: value.negated(), item });
}

/**
 * Moves `quantity` of one item from one warehouse to another: a TransferOut and a TransferIn leg,
 * each value_delta 0, so the item total, stock_value and average stay as they are. The caller checks
 * the source stock (assertStockAvailable) first. unit_cost / total_value of the legs are display
 * only: displayUnitCost (a picked batch) or the locked average, total rounded to 2 dp.
 */
export async function postTransfer(tx: Tx, i: TransferInput): Promise<PostedTransfer> {
  const quantity = positiveQuantity(i.quantity, 'postTransfer');
  if (i.fromWarehouseId === i.toWarehouseId) throw new Error('postTransfer: source and destination are the same warehouse');
  const item = await lockItem(tx, i.itemId, i.fromWarehouseId, i.toWarehouseId);
  const unitCost = new Decimal(i.displayUnitCost ?? item.averageCost).toDecimalPlaces(UNIT_COST_DP);
  const totalValue = quantity.times(unitCost).toDecimalPlaces(VALUE_DP);
  const leg = async (
    movementType: 'TransferOut' | 'TransferIn',
    warehouseId: string,
    side: TransferInput['out'],
    sourceMovementId: string | null,
  ): Promise<StockMovement> => {
    const movementNumber = side.movementNumber ?? await generateDocumentNumber(tx, 'SM', i.date, i.fiscalYearId);
    await writeStock(tx, i.itemId, warehouseId, movementType === 'TransferOut' ? quantity.negated() : quantity, null);
    return insertMovement(tx, {
      movementNumber, date: i.date, itemId: i.itemId, warehouseId, movementType,
      quantity: quantity.toString(), unitCost: unitCost.toString(), totalValue: totalValue.toString(), valueDelta: 0,
      notes: side.notes ?? null, referenceType: i.referenceType ?? null, referenceId: i.referenceId ?? null,
      referenceNumber: i.referenceNumber ?? null, sourceMovementId, fiscalYearId: i.fiscalYearId, createdById: i.createdById,
    });
  };
  const out = await leg('TransferOut', i.fromWarehouseId, i.out, i.sourceMovementId ?? null);
  const inLeg = await leg('TransferIn', i.toWarehouseId, i.in, null);
  return { out, in: inLeg };
}

/**
 * Links the journal the caller posted for a ledger row (the outbound pattern in the header). Only an
 * empty journal_entry_id is filled; a row that is cancelled or already linked is refused.
 */
export async function linkMovementJournal(tx: Tx, movementId: string, journalEntryId: string): Promise<void> {
  const { count } = await tx.stockMovement.updateMany({
    where: { id: movementId, journalEntryId: null, isCancelled: false },
    data: { journalEntryId },
  });
  if (count !== 1) throw new Error(`linkMovementJournal: movement ${movementId} is missing, cancelled or already linked`);
}

/**
 * True when an active Out / AdjustmentOut of the item was posted at or after the row (createdAt; a
 * tie counts, so the check errs towards refusing). Those rows were valued at an average that
 * included this row, so taking its value back exactly leaves an average no cost explains.
 */
async function soldSince(tx: Tx, movement: StockMovement): Promise<boolean> {
  const later = await tx.stockMovement.findFirst({
    where: {
      itemId: movement.itemId, isCancelled: false, movementType: { in: ['Out', 'AdjustmentOut'] },
      id: { not: movement.id }, createdAt: { gte: movement.createdAt },
    },
    select: { id: true },
  });
  return later !== null;
}

function needsTrueUp(itemName: string, next: ItemState): BusinessError {
  return new BusinessError(
    `Pembatalan ditolak: '${itemName}' sudah sebagian keluar, jadi nilai persediaannya perlu dikoreksi `
      + `(stok sesudahnya ${next.stock.toString()}, nilai ${next.value.toFixed(VALUE_DP)}). Koreksi nilai otomatis belum tersedia; hubungi akuntan.`,
    REVERSAL_NEEDS_TRUE_UP,
    409,
  );
}

/**
 * The value to sweep after a reversal, or a refusal (train guard until PR-6.5a); a Revaluation row
 * counts as inbound here:
 * - an inbound reversal that moves value after goods went out (soldSince), except when the stock
 *   reaches 0 and is swept: then the sweep makes the total COGS exact;
 * - an inbound reversal that moves value and leaves stock_value < 0, or stock > 0 with value <= 0;
 * - stock 0 with value left: swept when opts.sweepAtZero, refused otherwise.
 * A row that carries no value moves none, so it never trips the first two rules.
 */
async function reversalSweep(
  tx: Tx,
  movement: StockMovement,
  itemName: string,
  next: ItemState,
  valueDelta: Decimal,
  sweepAtZero: boolean,
): Promise<Decimal> {
  // A Revaluation row changed the value of goods on hand like an inbound row, so taking it back has
  // the same exposure to goods that went out since.
  const inboundWithValue = (INBOUND_TYPES.has(movement.movementType) || movement.movementType === 'Revaluation') && !valueDelta.isZero();
  if (inboundWithValue && (next.value.lt(0) || (next.stock.gt(0) && next.value.lte(0)))) {
    throw needsTrueUp(itemName, next);
  }
  const sweptToZero = next.stock.isZero() && sweepAtZero;
  if (inboundWithValue && !sweptToZero && await soldSince(tx, movement)) throw needsTrueUp(itemName, next);
  if (!next.stock.isZero() || next.value.isZero()) return new Decimal(0);
  if (!sweepAtZero) throw needsTrueUp(itemName, next);
  return next.value;
}

interface SweepPeriod {
  date: Date;
  fiscalYearId: string;
}

/** The day and open fiscal year of the sweep row, checked before the reversal writes anything. */
async function sweepPeriod(tx: Tx, opts: ReverseOptions): Promise<SweepPeriod> {
  const date = new Date(opts.journalDay ?? businessToday());
  const fiscalYear = await assertPeriodOpen(tx, { date }, 'mutasi stok');
  return { date, fiscalYearId: fiscalYear.id };
}

/** The Revaluation row that takes `residue` out of the book at zero stock, owned by the reversed row's document. */
async function writeSweepRow(tx: Tx, movement: StockMovement, residue: Decimal, period: SweepPeriod, userId: string): Promise<StockMovement> {
  const { date, fiscalYearId } = period;
  const movementNumber = await generateDocumentNumber(tx, 'SM', date, fiscalYearId);
  return insertMovement(tx, {
    movementNumber, date, itemId: movement.itemId, warehouseId: null, movementType: 'Revaluation',
    quantity: 0, unitCost: 0, totalValue: residue.abs().toString(), valueDelta: residue.negated().toString(),
    adjustsMovementId: movement.id, referenceType: movement.referenceType, referenceId: movement.referenceId,
    referenceNumber: movement.referenceNumber, notes: `Sisa nilai saat stok 0 (pembatalan ${movement.movementNumber})`,
    fiscalYearId, createdById: userId,
  });
}

/** Claims the row for this reversal: a concurrent reversal of the same row finds it cancelled. */
async function claimReversal(tx: Tx, movementId: string): Promise<void> {
  const { count } = await tx.stockMovement.updateMany({ where: { id: movementId, isCancelled: false }, data: { isCancelled: true } });
  if (count !== 1) throw new BusinessError('Gerakan stok sudah dibatalkan.');
}

/**
 * A transfer leg back at its warehouse (TransferOut returns to the source, TransferIn leaves the
 * destination); the item total and value never moved, so only the warehouse row changes. The caller
 * reverses both legs of a line and checks the destination stock first.
 */
async function reverseTransferLeg(tx: Tx, movement: StockMovement, item: LockedItem): Promise<ReverseResult> {
  if (!movement.warehouseId) throw new Error(`reverseMovement: transfer leg ${movement.id} has no warehouse`);
  const quantity = dec(movement.quantity);
  await claimReversal(tx, movement.id);
  await writeStock(tx, movement.itemId, movement.warehouseId, movement.movementType === 'TransferOut' ? quantity : quantity.negated(), null);
  return {
    movement: { ...movement, isCancelled: true }, valueDelta: new Decimal(0), toCogs: new Decimal(0), sweep: null,
    stockAfter: item.currentStock, stockValueAfter: item.stockValue, averageCostAfter: item.averageCost,
  };
}

/**
 * Takes a row back exactly and marks it cancelled:
 * - In / AdjustmentIn / Out / AdjustmentOut: its quantity at its warehouse (the item total for a
 *   legacy row without one) and its value_delta;
 * - Revaluation (quantity 0, no warehouse): its value_delta only, e.g. a purchase invoice price
 *   delta when the invoice is cancelled (its journal is voided by the caller);
 * - TransferOut / TransferIn: the quantity at its warehouse only (value_delta 0).
 * The caller checks the stock an inbound reversal needs (assertStockAvailable, reversal) and voids
 * the row's journal, whose inventory amount is −valueDelta. Refused with REVERSAL_NEEDS_TRUE_UP where
 * the book would need a true-up (reversalSweep).
 */
export async function reverseMovement(tx: Tx, movementId: string, opts: ReverseOptions): Promise<ReverseResult> {
  const ref = await tx.stockMovement.findUnique({ where: { id: movementId }, select: { itemId: true, warehouseId: true } });
  if (!ref) throw new BusinessError('Gerakan stok tidak ditemukan.');
  const item = await lockItem(tx, ref.itemId, ref.warehouseId);
  const movement = await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } });
  if (movement.isCancelled) throw new BusinessError('Gerakan stok sudah dibatalkan.');
  if (TRANSFER_TYPES.has(movement.movementType)) return reverseTransferLeg(tx, movement, item);
  const inbound = INBOUND_TYPES.has(movement.movementType);
  if (!inbound && !OUTBOUND_TYPES.has(movement.movementType) && movement.movementType !== 'Revaluation') {
    throw new Error(`reverseMovement: ${movement.movementType} rows are not reversed by this function`);
  }
  const quantity = dec(movement.quantity);
  const qtyDelta = inbound ? quantity.negated() : quantity;
  const valueDelta = dec(movement.valueDelta).negated();
  const reversed = stateAfter(item, qtyDelta, valueDelta);
  const residue = await reversalSweep(tx, movement, item.name, reversed, valueDelta, opts.sweepAtZero === true);
  // Every guard runs before the first write: a caller that catches a refusal keeps a whole book.
  const period = residue.isZero() ? null : await sweepPeriod(tx, opts);

  await claimReversal(tx, movement.id);
  const sweep = period ? await writeSweepRow(tx, movement, residue, period, opts.userId) : null;
  const next = sweep ? { ...reversed, value: reversed.value.minus(residue) } : reversed;
  await writeStock(tx, movement.itemId, movement.warehouseId, qtyDelta, next);
  if (valueDelta.isZero() && !quantity.isZero()) {
    logger.warn({ movementId: movement.id, movementNumber: movement.movementNumber, itemId: movement.itemId }, 'Reversed a stock movement that carries no value');
  }
  return {
    movement: { ...movement, isCancelled: true }, valueDelta, toCogs: residue, sweep,
    stockAfter: next.stock, stockValueAfter: next.value, averageCostAfter: next.average,
  };
}

export interface DocumentRef {
  referenceType: string;
  referenceId: string;
}

/**
 * Reverses every active row a document owns (reference_type / reference_id), in id order, after
 * one lockInventoryRows call for all their items and warehouses (LOCK ORDER of stockLocks.ts). A
 * sweep row an earlier reversal of the document wrote (a Revaluation adjusting a cancelled row of
 * the same document) is already the settlement of that row and is left alone. A refusal of any
 * row is thrown after earlier rows were written: the caller's transaction rolls back as a whole.
 */
export async function reverseDocumentMovements(tx: Tx, ref: DocumentRef, opts: ReverseOptions): Promise<ReverseResult[]> {
  const rows = await tx.stockMovement.findMany({
    where: { referenceType: ref.referenceType, referenceId: ref.referenceId, isCancelled: false },
    orderBy: { id: 'asc' },
    select: {
      id: true, itemId: true, warehouseId: true,
      adjustsMovement: { select: { isCancelled: true, referenceType: true, referenceId: true } },
    },
  });
  const owned = rows.filter((r) => !(r.adjustsMovement?.isCancelled
    && r.adjustsMovement.referenceType === ref.referenceType && r.adjustsMovement.referenceId === ref.referenceId));
  await lockInventoryRows(tx, {
    itemIds: owned.map((r) => r.itemId),
    pairs: owned.flatMap((r) => (r.warehouseId ? [{ itemId: r.itemId, warehouseId: r.warehouseId }] : [])),
  });
  const results: ReverseResult[] = [];
  for (const row of owned) results.push(await reverseMovement(tx, row.id, opts));
  return results;
}

/** Re-derives average_cost from the locked stock and stock_value (averageAfter) and returns it. */
export async function refreshAverageCost(tx: Tx, itemId: string): Promise<Decimal> {
  const item = await lockItem(tx, itemId, null);
  const average = averageAfter(item.currentStock, item.stockValue, item.averageCost);
  if (!average.eq(item.averageCost)) {
    await tx.inventoryItem.update({ where: { id: itemId }, data: { averageCost: average.toString() } });
  }
  return average;
}

/**
 * Which invariant an item breaks: valueSum (a) stock_value vs Σ active value_delta, average (b)
 * stock > 0 and |stock x average − stock_value| over invariantTolerance, warehouseSum (c, report
 * only) current_stock vs Σ inventory_stocks.
 */
export type LedgerDriftKind = 'valueSum' | 'average' | 'warehouseSum';

export interface LedgerDrift {
  itemId: string;
  code: string;
  kind: LedgerDriftKind;
  /** (c) is reported, it does not fail the check. */
  reportOnly: boolean;
  /** stock_value for (a) and (b), current_stock for (c). */
  actual: Decimal;
  /** Σ active value_delta (a), stock x average (b), Σ inventory_stocks (c). */
  expected: Decimal;
  difference: Decimal;
}

interface InvariantRow {
  id: string;
  code: string;
  stock: string;
  stock_value: string;
  average_cost: string;
  movement_value: string;
  warehouse_stock: string;
}

const VALUE_SUM_TOLERANCE = new Decimal('0.005');
const WAREHOUSE_SUM_TOLERANCE = new Decimal('0.0005');

function driftsOf(r: InvariantRow): LedgerDrift[] {
  const stock = new Decimal(r.stock);
  const value = new Decimal(r.stock_value);
  const drift = (kind: LedgerDriftKind, actual: Decimal, expected: Decimal): LedgerDrift => ({
    itemId: r.id, code: r.code, kind, reportOnly: kind === 'warehouseSum', actual, expected, difference: actual.minus(expected),
  });
  const found: LedgerDrift[] = [];
  const movementValue = new Decimal(r.movement_value);
  if (value.minus(movementValue).abs().gt(VALUE_SUM_TOLERANCE)) found.push(drift('valueSum', value, movementValue));
  const atAverage = stock.times(r.average_cost);
  if (stock.gt(0) && value.minus(atAverage).abs().gt(invariantTolerance(stock))) found.push(drift('average', value, atAverage));
  const warehouseStock = new Decimal(r.warehouse_stock);
  if (stock.minus(warehouseStock).abs().gt(WAREHOUSE_SUM_TOLERANCE)) found.push(drift('warehouseSum', stock, warehouseStock));
  return found;
}

/**
 * The value-ledger invariants of the given items (all items when omitted), by item code. Returns the
 * breaks instead of throwing: tests assert through __tests__/helpers/ledgerInvariant.ts, and the
 * health check (PR-6.13a) reports them. Reads only; take lockInventoryRows first for a stable read.
 */
export async function assertLedgerInvariant(db: Tx | PrismaClient, itemIds?: readonly string[]): Promise<LedgerDrift[]> {
  if (itemIds && itemIds.length === 0) return [];
  const filter = itemIds ? Prisma.sql`WHERE i.id = ANY(${[...itemIds]}::text[])` : Prisma.empty;
  const rows = await db.$queryRaw<InvariantRow[]>`
    SELECT i.id, i.code, i.current_stock::text AS stock, i.stock_value::text AS stock_value,
           i.average_cost::text AS average_cost,
           COALESCE((SELECT SUM(m.value_delta) FROM stock_movements m
                     WHERE m.item_id = i.id AND m.is_cancelled = false), 0)::text AS movement_value,
           COALESCE((SELECT SUM(s.current_stock) FROM inventory_stocks s WHERE s.item_id = i.id), 0)::text AS warehouse_stock
    FROM inventory_items i
    ${filter}
    ORDER BY i.code`;
  return rows.flatMap(driftsOf);
}
