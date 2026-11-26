/**
 * Inventory value ledger (E3-R6). With services/inventory/inventoryValueMath.ts this is the one
 * value-ledger module: after the train (PR-6.4e) it is the only writer of current_stock,
 * stock_value, average_cost, inventory_stocks and stock_movements. Paths move behind it one train
 * PR at a time.
 *
 * Every call locks its rows through lockInventoryRows (idempotent in the transaction, so a caller
 * that locked every item of its operation first keeps the LOCK ORDER of stockLocks.ts), then reads
 * stock, stock_value and the average from the locked rows only.
 *
 * The ledger has no permission logic and posts no journal of the caller's document. It decides the
 * value of an outbound row (outboundValue) and returns the signed valueDelta of every posting; the
 * caller posts exactly that amount to inventoryAccountFor(item), so book = GL by construction. Stock
 * availability, the negative-stock gate, the period guard of the caller's document and active-master
 * checks stay with the caller. The one journal it posts is the negative-stock settlement of an
 * inbound row (E3-R9, negativeStockSettle.ts): it belongs to the row, whatever path wrote it.
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
import { Prisma, type StockMovement } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { businessToday } from '../../utils/businessDate';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { assertPeriodOpen } from '../../utils/periodGuard';
import { logger } from '../../lib/logger';
import { addsUncostedWindow, replayItemValue, type ReplayRevision } from '../../utils/weightedAverageReplay';
import {
  increaseAfterInbound, needsTrueUp, negativeStockNoCost, preBaseline, pricedPastZero, residueAtZero, unexplained,
} from './reversalErrors';
import { lockInventoryRows, stockKey, type LockedItem } from './stockLocks';
import {
  INVENTORY_VALUE_NEGATIVE, NEGATIVE_STOCK_SETTLE_REFERENCE, UNIT_COST_DP, VALUE_DP, averageAfter, negativeSettlement, outboundValue,
  revaluationSplit, revisedOutboundValue,
} from './inventoryValueMath';
import { hasOpenLegacyCogsQueue, postNegativeSettleJournal } from './negativeStockSettle';

type Tx = Prisma.TransactionClient;

export {
  NEGATIVE_STOCK_NO_COST, OUTBOUND_INCREASE_AFTER_INBOUND, REVERSAL_NEEDS_TRUE_UP, TRUE_UP_PRE_BASELINE, TRUE_UP_UNEXPLAINED,
} from './reversalErrors';
export { assertLedgerInvariant, type LedgerDrift, type LedgerDriftKind } from './ledgerInvariant';

/** Fields of a new movement row; a new movement names its warehouse (OutboundInput has one exception). */
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

export interface OutboundInput extends Omit<MovementBase, 'warehouseId'> {
  movementType: 'Out' | 'AdjustmentOut';
  /**
   * null only for stock that no warehouse holds (the item vs warehouse drift write-off, PR-6.3d):
   * the row then takes the quantity off the item total alone.
   */
  warehouseId: string | null;
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

/** The negative-stock settlement an inbound row wrote (E3-R9): its Revaluation row and journal. */
export interface NegativeSettlement {
  movement: StockMovement;
  /** The change to stock_value (− DR COGS / CR inventory); the journal already posts it. */
  valueDelta: Decimal;
  journalEntryId: string;
}

export interface PostedInbound extends PostedMovement {
  /** Set when the row came into stock below 0; stockValueAfter / averageCostAfter include it. */
  settlement: NegativeSettlement | null;
}

export interface ReverseOptions {
  userId: string;
  /**
   * 'replay': the value true-up of a cancel (E3-R8). When goods of the item went out after the row,
   * the item's rows are replayed from its last ValuationBaseline with and without it
   * (replayItemValue), and the difference the row made to what went out comes back to the book
   * (returned as trueUp, posted against COGS by postReversalValueJournals). 'none' (default): the
   * row comes back exactly, and a reversal that would need a true-up is refused (REVERSAL_NEEDS_TRUE_UP).
   */
  trueUp?: 'none' | 'replay';
  /** Stock that reaches 0 hands its remaining value to the caller as toCogs (one Revaluation row). */
  sweepAtZero?: boolean;
  /** Business day (YYYY-MM-DD) of the true-up / sweep row and its journal; default today (WIB, owner decision #3). */
  journalDay?: string;
  /** The reversal undoes a document for an edit: a refusal says so instead of naming a cancel. */
  forEdit?: boolean;
}

export interface ReverseResult {
  /** The reversed row, now cancelled. */
  movement: StockMovement;
  /** −(the row's value_delta): the inventory amount of the journal the caller voids. */
  valueDelta: Decimal;
  /** Value true-up (trueUp 'replay'): + back into the book, − out of it, against COGS (0: none). */
  trueUp: Decimal;
  /** Value swept out at zero stock; the caller posts DR COGS / CR inventory of it (0: nothing swept). */
  toCogs: Decimal;
  /**
   * The Revaluation row of the true-up and the sweep together (value_delta = trueUp − toCogs, the
   * inventory amount of postReversalValueJournals), or null when both are 0.
   */
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

/**
 * The negative-stock settlement of an inbound row (E3-R9): when the item's stock was below 0 before
 * the row, the goods it covers are re-valued at its price (negativeSettlement) in one Revaluation row
 * (NEGATIVE_STOCK_SETTLE_REFERENCE, adjusting the row, dated its day) and its journal
 * (postNegativeSettleJournal). Skipped below half a cent, and for an item with legacy deferred-COGS
 * rows still open (owner decision #6).
 */
async function settleNegativeWindow(
  tx: Tx,
  i: InboundInput,
  before: LockedItem,
  posted: PostedMovement,
): Promise<NegativeSettlement | null> {
  if (!before.currentStock.lt(0)) return null;
  const quantity = dec(posted.movement.quantity);
  const delta = negativeSettlement(before.currentStock, before.stockValue, quantity, posted.valueDelta);
  if (delta.isZero()) return null;
  if (await hasOpenLegacyCogsQueue(tx, i.itemId)) {
    logger.warn({ itemId: i.itemId, movementId: posted.movement.id }, 'Negative-stock settlement skipped: legacy COGS queue rows are open');
    return null;
  }
  const covered = Decimal.min(before.currentStock.negated(), quantity);
  const movementNumber = await generateDocumentNumber(tx, 'SM', i.date, i.fiscalYearId);
  const journalEntryId = await postNegativeSettleJournal(tx, {
    item: before, amount: delta, inbound: posted.movement, covered, date: i.date, fiscalYearId: i.fiscalYearId, userId: i.createdById,
  });
  const value = posted.stockValueAfter.plus(delta);
  const next = { stock: posted.stockAfter, value, average: averageAfter(posted.stockAfter, value, posted.averageCostAfter) };
  await writeStock(tx, i.itemId, null, new Decimal(0), next);
  const movement = await insertMovement(tx, {
    movementNumber, date: i.date, itemId: i.itemId, warehouseId: null, movementType: 'Revaluation',
    quantity: 0, unitCost: 0, totalValue: delta.abs().toString(), valueDelta: delta.toString(),
    adjustsMovementId: posted.movement.id, referenceType: NEGATIVE_STOCK_SETTLE_REFERENCE, referenceId: posted.movement.id,
    referenceNumber: posted.movement.referenceNumber ?? posted.movement.movementNumber,
    notes: `Penyelesaian stok minus ${covered.toString()} ${before.unit} pada harga masuk (${posted.movement.movementNumber})`,
    journalEntryId, fiscalYearId: i.fiscalYearId, createdById: i.createdById,
  });
  return { movement, valueDelta: delta, journalEntryId };
}

/**
 * Puts `quantity` into the warehouse at `value` (the caller's inventory debit); the average blends it.
 * Into stock below 0 the row also settles the window (settleNegativeWindow): valueDelta stays the
 * caller's debit, the settlement posts its own journal.
 */
export async function postInbound(tx: Tx, i: InboundInput): Promise<PostedInbound> {
  if (!INBOUND_TYPES.has(i.movementType)) throw new Error(`postInbound: ${i.movementType} is not an inbound type`);
  const quantity = positiveQuantity(i.quantity, 'postInbound');
  const value = new Decimal(i.value).toDecimalPlaces(VALUE_DP);
  if (!value.isFinite() || value.lt(0)) throw new Error('postInbound: value must be 0 or more');
  const item = await lockItem(tx, i.itemId, i.warehouseId);
  const posted = await writePosting(tx, i, { quantity, valueDelta: value, item });
  const settlement = await settleNegativeWindow(tx, i, item, posted);
  if (!settlement) return { ...posted, settlement: null };
  const stockValueAfter = posted.stockValueAfter.plus(settlement.valueDelta);
  return {
    ...posted, settlement, stockValueAfter,
    averageCostAfter: averageAfter(posted.stockAfter, stockValueAfter, posted.averageCostAfter),
  };
}

/** Goods taken past zero stock (item total) while the average is 0 have no cost: refused (E3-R9). */
function assertCostedPastZero(item: LockedItem, quantity: Decimal): void {
  if (item.currentStock.minus(quantity).gte(0) || item.averageCost.gt(0)) return;
  throw negativeStockNoCost(item.name);
}

/**
 * Takes `quantity` out of the warehouse at the value outboundValue decides from the locked book;
 * valueDelta is minus that value (the caller's inventory credit and COGS). The caller checks
 * availability (assertStockAvailable) first; past zero stock the row is valued at the average, and
 * refused when that is 0 (NEGATIVE_STOCK_NO_COST, also through the negative-stock bypass).
 */
export async function postOutbound(tx: Tx, i: OutboundInput): Promise<PostedMovement> {
  if (!OUTBOUND_TYPES.has(i.movementType)) throw new Error(`postOutbound: ${i.movementType} is not an outbound type`);
  const quantity = positiveQuantity(i.quantity, 'postOutbound');
  const item = await lockItem(tx, i.itemId, i.warehouseId);
  assertCostedPastZero(item, quantity);
  const value = outboundValue(item.currentStock, item.stockValue, item.averageCost, quantity);
  return writePosting(tx, i, { quantity, valueDelta: value.negated(), item });
}

/**
 * A value change of one item with no quantity (a Revaluation row: quantity 0, no warehouse). The
 * row belongs to its document (referenceType / referenceId), so reverseDocumentMovements takes it
 * back with the document.
 */
export interface RevaluationInput {
  itemId: string;
  date: Date;
  fiscalYearId: string;
  createdById: string;
  /** The value change the caller journals against its counter account: + raises, − lowers (2 dp, not 0). */
  delta: Decimal.Value;
  referenceType: string;
  referenceId?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  /** The movement whose value this row adjusts (e.g. a receipt a purchase invoice reprices). */
  adjustsMovementId?: string | null;
  journalEntryId?: string | null;
  /** Taken by the caller after lockInventoryRows; the ledger takes an 'SM' number otherwise. */
  movementNumber?: string;
  /**
   * The whole delta moves stock_value, with no revaluationSplit (toCogs 0). The legacy COGS settle
   * only: its differential re-values units sold below zero that the triggering stock-in has just
   * covered, so it belongs to the book whatever stock is left (0, or still negative).
   */
  wholeToInventory?: boolean;
}

export interface PostedRevaluation extends PostedMovement {
  /**
   * The part of delta stock could not absorb (revaluationSplit): the caller posts it to COGS
   * (cogsAccountFor) in the same journal. valueDelta (+ toCogs = delta) goes to inventory.
   */
  toCogs: Decimal;
}

/**
 * Changes the value of the item's stock by `delta` through revaluationSplit: the part stock can
 * absorb moves stock_value (valueDelta, the caller's inventory amount), the rest is returned as
 * toCogs (no stock on hand, or a decrease larger than stock_value); wholeToInventory skips the
 * split. The row is written even when valueDelta is 0 (all to COGS) so the document owns a trace of
 * its journal line.
 */
export async function postRevaluation(tx: Tx, i: RevaluationInput): Promise<PostedRevaluation> {
  const delta = new Decimal(i.delta).toDecimalPlaces(VALUE_DP);
  if (!delta.isFinite() || delta.isZero()) throw new Error('postRevaluation: delta must be a non-zero amount');
  const item = await lockItem(tx, i.itemId, null);
  const { toInventory, toCogs } = i.wholeToInventory
    ? { toInventory: delta, toCogs: new Decimal(0) }
    : revaluationSplit(item.currentStock, item.stockValue, delta);
  const next = stateAfter(item, new Decimal(0), toInventory);
  const movementNumber = i.movementNumber ?? await generateDocumentNumber(tx, 'SM', i.date, i.fiscalYearId);
  await writeStock(tx, i.itemId, null, new Decimal(0), next);
  const movement = await insertMovement(tx, {
    movementNumber, date: i.date, itemId: i.itemId, warehouseId: null, movementType: 'Revaluation',
    quantity: 0, unitCost: 0, totalValue: toInventory.abs().toString(), valueDelta: toInventory.toString(),
    adjustsMovementId: i.adjustsMovementId ?? null, notes: i.notes ?? null, referenceType: i.referenceType,
    referenceId: i.referenceId ?? null, referenceNumber: i.referenceNumber ?? null,
    journalEntryId: i.journalEntryId ?? null, fiscalYearId: i.fiscalYearId, createdById: i.createdById,
  });
  return {
    movement, valueDelta: toInventory, unitCost: new Decimal(0), toCogs,
    stockAfter: next.stock, stockValueAfter: next.value, averageCostAfter: next.average,
  };
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
 * Item vs warehouse drift repair `assign` (PR-6.3d): books `quantity` of stock that no warehouse
 * holds into `warehouseId`; a negative quantity takes a warehouse's excess over the item total back
 * out of it. Only the warehouse row moves: the item total, stock_value and average stay, and no
 * movement row is written. The caller checks under the lock that the quantity fits the drift.
 */
export async function placeUnplacedStock(tx: Tx, i: { itemId: string; warehouseId: string; quantity: Decimal.Value }): Promise<void> {
  const quantity = new Decimal(i.quantity);
  if (!quantity.isFinite() || quantity.isZero()) throw new Error('placeUnplacedStock: quantity must be a non-zero amount');
  await lockItem(tx, i.itemId, i.warehouseId);
  await writeStock(tx, i.itemId, i.warehouseId, quantity, null);
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
 * Number prefix of the purchase invoice Revaluations the value-ledger backfill wrote (migration
 * 20261112200000, step 3). A live posting takes an 'SM-YYYYMM-' number.
 */
const BACKFILL_REVALUATION_PREFIX = 'SM-RV-';

/**
 * When the row's value entered the book: its createdAt, or for a backfilled purchase invoice
 * Revaluation the earlier createdAt of the row it adjusts. The backfill stamped those rows with the
 * deploy time although the old code had put the delta into the average at the invoice, before sales
 * that came after it. A Revaluation posted live (PR-6.4c3) entered the book when it was written:
 * goods that went out before it were valued without it.
 */
async function valueEnteredAt(tx: Tx, movement: StockMovement): Promise<Date> {
  if (movement.movementType !== 'Revaluation' || !movement.adjustsMovementId) return movement.createdAt;
  if (!movement.movementNumber.startsWith(BACKFILL_REVALUATION_PREFIX)) return movement.createdAt;
  const adjusted = await tx.stockMovement.findUnique({ where: { id: movement.adjustsMovementId }, select: { createdAt: true } });
  return adjusted && adjusted.createdAt < movement.createdAt ? adjusted.createdAt : movement.createdAt;
}

/**
 * True when an active Out / AdjustmentOut of the item was posted at or after the row's value entered
 * the book (valueEnteredAt; a tie counts, so the check errs towards refusing). Those rows were valued
 * at an average that included this row, so taking its value back exactly leaves an average no cost
 * explains.
 */
async function soldSince(tx: Tx, movement: StockMovement): Promise<boolean> {
  const since = await valueEnteredAt(tx, movement);
  const later = await tx.stockMovement.findFirst({
    where: {
      itemId: movement.itemId, isCancelled: false, movementType: { in: ['Out', 'AdjustmentOut'] },
      id: { not: movement.id }, createdAt: { gte: since },
    },
    select: { id: true },
  });
  return later !== null;
}

/**
 * True when an active negative-stock settlement of the item (NEGATIVE_STOCK_SETTLE_REFERENCE) was
 * written at or after the row's value entered the book (a tie counts, as in soldSince), the row's own
 * included: it re-valued goods that went out past zero on a book this row was part of (an outbound
 * row that opened the window, an inbound row that settled it), so taking the row back exactly leaves
 * the settlement wrong.
 */
async function settledSince(tx: Tx, movement: StockMovement): Promise<boolean> {
  const since = await valueEnteredAt(tx, movement);
  const later = await tx.stockMovement.findFirst({
    where: {
      itemId: movement.itemId, isCancelled: false, movementType: 'Revaluation', referenceType: NEGATIVE_STOCK_SETTLE_REFERENCE,
      id: { not: movement.id }, createdAt: { gte: since },
    },
    select: { id: true },
  });
  return later !== null;
}

/**
 * True when value entered the item's book at or after the row was posted (a tie counts, as in
 * soldSince): an active In / AdjustmentIn, or a Revaluation other than the settlement of a cancelled
 * row of its own document (the rows the replay skips). Goods a raised quantity takes out now at the
 * average now would stand before that value when the row keeps its createdAt.
 */
async function valueEnteredAfter(tx: Tx, movement: StockMovement): Promise<boolean> {
  const after = { itemId: movement.itemId, isCancelled: false, id: { not: movement.id }, createdAt: { gte: movement.createdAt } };
  const inbound = await tx.stockMovement.findFirst({ where: { ...after, movementType: { in: ['In', 'AdjustmentIn'] } }, select: { id: true } });
  if (inbound) return true;
  const revaluations = await tx.stockMovement.findMany({
    where: { ...after, movementType: 'Revaluation' },
    select: { referenceType: true, referenceId: true, adjustsMovement: { select: { isCancelled: true, referenceType: true, referenceId: true } } },
  });
  return revaluations.some((r) => !(r.adjustsMovement?.isCancelled
    && r.adjustsMovement.referenceType === r.referenceType && r.adjustsMovement.referenceId === r.referenceId));
}

/**
 * The value to sweep after a reversal without trueUp 'replay', or a refusal (train guard); a Revaluation row
 * counts as inbound here:
 * - an inbound reversal that moves value after goods went out (soldSince), except when the stock
 *   reaches 0 and is swept: then the sweep makes the total COGS exact;
 * - an inbound reversal that moves value and leaves stock_value < 0, or stock > 0 with value <= 0;
 * - stock 0 with value left: swept when opts.sweepAtZero, refused otherwise (residueAtZero);
 * - any row a negative-stock settlement came after (settledSince): only a replay re-values it.
 * An inbound row that carries no value (a by-product at NRV 0, an output at HPP 0) still moved the
 * average by its quantity, so taking it back after goods went out is refused the same way while
 * value stays on hand; it moves no value, so the sign rules do not apply to it.
 */
async function reversalSweep(
  tx: Tx,
  movement: StockMovement,
  itemName: string,
  next: ItemState,
  valueDelta: Decimal,
  opts: ReverseOptions,
): Promise<Decimal> {
  const sweepAtZero = opts.sweepAtZero === true;
  const forEdit = opts.forEdit === true;
  if (await settledSince(tx, movement)) throw needsTrueUp(itemName, next, forEdit);
  // A Revaluation row changed the value of goods on hand like an inbound row, so taking it back has
  // the same exposure to goods that went out since.
  const inboundWithValue = (INBOUND_TYPES.has(movement.movementType) || movement.movementType === 'Revaluation') && !valueDelta.isZero();
  if (inboundWithValue && (next.value.lt(0) || (next.stock.gt(0) && next.value.lte(0)))) {
    throw needsTrueUp(itemName, next, forEdit);
  }
  // A zero-value inbound row diluted the average the later outbound rows were valued at; taking its
  // quantity back raises the average of what is left unless no value is left to spread.
  const dilutedAverage = INBOUND_TYPES.has(movement.movementType) && valueDelta.isZero()
    && !dec(movement.quantity).isZero() && !next.value.isZero();
  const sweptToZero = next.stock.isZero() && sweepAtZero;
  if ((inboundWithValue || dilutedAverage) && !sweptToZero && await soldSince(tx, movement)) throw needsTrueUp(itemName, next, forEdit);
  if (!next.stock.isZero() || next.value.isZero()) return new Decimal(0);
  if (!sweepAtZero) throw residueAtZero(itemName, next, forEdit);
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

/**
 * The Revaluation row of a reversal's true-up and zero-stock sweep (value_delta = trueUp − residue),
 * owned by the reversed row's document and adjusting the reversed row.
 */
async function writeSettlementRow(
  tx: Tx,
  movement: StockMovement,
  amounts: { trueUp: Decimal; residue: Decimal },
  period: SweepPeriod,
  userId: string,
  action: 'pembatalan' | 'edit' = 'pembatalan',
): Promise<StockMovement> {
  const { date, fiscalYearId } = period;
  const valueDelta = amounts.trueUp.minus(amounts.residue);
  const movementNumber = await generateDocumentNumber(tx, 'SM', date, fiscalYearId);
  const notes = amounts.trueUp.isZero()
    ? `Sisa nilai saat stok 0 (${action} ${movement.movementNumber})`
    : `Koreksi nilai persediaan (${action} ${movement.movementNumber})`;
  return insertMovement(tx, {
    movementNumber, date, itemId: movement.itemId, warehouseId: null, movementType: 'Revaluation',
    quantity: 0, unitCost: 0, totalValue: valueDelta.abs().toString(), valueDelta: valueDelta.toString(),
    adjustsMovementId: movement.id, referenceType: movement.referenceType, referenceId: movement.referenceId,
    referenceNumber: movement.referenceNumber, notes, fiscalYearId, createdById: userId,
  });
}

const STOCK_EXPLAINED_TOLERANCE = new Decimal('0.0005');

/**
 * Value true-up of taking `movement` out of the item's history (trueUp 'replay'), or of re-posting it
 * at `revised` (reviseOutbound), 2 dp, + into the book. 0 when no goods of the item went out since
 * the row's value entered the book and no negative-stock settlement came after it (settledSince):
 * then the exact reversal already leaves the book the row's absence would have. Otherwise the replay with the row must reproduce current_stock (TRUE_UP_UNEXPLAINED)
 * and the row must lie after the baseline (TRUE_UP_PRE_BASELINE), and without the row (or with the
 * revised one) no goods may go out past zero at average 0 (or a Revaluation land at no stock) where
 * they did not with it (addsUncostedWindow, TRUE_UP_UNEXPLAINED). Both replays settle negative-stock
 * windows at the next inbound as postInbound does, so a cancel also takes back or changes the
 * settlements the row caused (PR-6.6). The true-up is what the outbound
 * rows since took differently: replay(other) − (replay(with) − the row's value_delta + the revised
 * row's). Taking the difference of two replays, not of the replay and stock_value, keeps older
 * settlement rows of the book out of it.
 */
async function replayTrueUp(tx: Tx, movement: StockMovement, item: LockedItem, revised?: Omit<ReplayRevision, 'movementId'>): Promise<Decimal> {
  if (!(await soldSince(tx, movement)) && !(await settledSince(tx, movement))) return new Decimal(0);
  try {
    const withRow = await replayItemValue(tx, movement.itemId);
    if (!withRow.replayedIds.has(movement.id)) throw withRow.baselineId ? preBaseline(item.name, movement) : unexplained(item.name);
    if (withRow.stock.minus(item.currentStock).abs().gt(STOCK_EXPLAINED_TOLERANCE)) throw unexplained(item.name);
    const other = await replayItemValue(tx, movement.itemId, revised
      ? { revise: { movementId: movement.id, ...revised } }
      : { excludeMovementIds: [movement.id] });
    if (addsUncostedWindow(withRow, other)) throw pricedPastZero(item.name);
    const bookChange = dec(revised?.valueDelta ?? 0).minus(dec(movement.valueDelta));
    return other.value.minus(withRow.value.plus(bookChange)).toDecimalPlaces(VALUE_DP);
  } catch (e) {
    // A replayed book that values stock on hand below 0 explains nothing either.
    if (e instanceof BusinessError && e.code === INVENTORY_VALUE_NEGATIVE) throw unexplained(item.name);
    throw e;
  }
}

/** The value to sweep after a replayed reversal: residue at zero stock (sweepAtZero), never stock on hand below 0. */
function replaySweep(itemName: string, next: ItemState, sweepAtZero: boolean): Decimal {
  if (next.stock.gt(0) && next.value.lt(0)) throw unexplained(itemName);
  if (!next.stock.isZero() || next.value.isZero()) return new Decimal(0);
  if (!sweepAtZero) throw residueAtZero(itemName, next);
  return next.value;
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
    movement: { ...movement, isCancelled: true }, valueDelta: new Decimal(0), trueUp: new Decimal(0), toCogs: new Decimal(0), sweep: null,
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
 * the row's journal, whose inventory amount is −valueDelta. With trueUp 'replay' the row's effect on
 * goods that went out since comes back as trueUp (replayTrueUp) and, with sweepAtZero, value left at
 * zero stock as toCogs: one Revaluation row (sweep) dated opts.journalDay in an open period, whose
 * journal the caller posts with postReversalValueJournals. Without it a reversal that needs a
 * true-up is refused with REVERSAL_NEEDS_TRUE_UP (reversalSweep).
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
  const sweepAtZero = opts.sweepAtZero === true;
  const trueUp = opts.trueUp === 'replay' ? await replayTrueUp(tx, movement, item) : new Decimal(0);
  const reversed = stateAfter(item, qtyDelta, valueDelta.plus(trueUp));
  const residue = opts.trueUp === 'replay'
    ? replaySweep(item.name, reversed, sweepAtZero)
    : await reversalSweep(tx, movement, item.name, reversed, valueDelta, opts);
  // Every guard runs before the first write: a caller that catches a refusal keeps a whole book.
  const period = trueUp.isZero() && residue.isZero() ? null : await sweepPeriod(tx, opts);

  await claimReversal(tx, movement.id);
  const sweep = period ? await writeSettlementRow(tx, movement, { trueUp, residue }, period, opts.userId) : null;
  const next = residue.isZero() ? reversed : { ...reversed, value: reversed.value.minus(residue) };
  await writeStock(tx, movement.itemId, movement.warehouseId, qtyDelta, next);
  if (valueDelta.isZero() && !quantity.isZero()) {
    logger.warn({ movementId: movement.id, movementNumber: movement.movementNumber, itemId: movement.itemId }, 'Reversed a stock movement that carries no value');
  }
  return {
    movement: { ...movement, isCancelled: true }, valueDelta, trueUp, toCogs: residue, sweep,
    stockAfter: next.stock, stockValueAfter: next.value, averageCostAfter: next.average,
  };
}

export interface DocumentRef {
  /** One type, or several a document owns rows under (a purchase invoice: landed cost and revisions). */
  referenceType: string | readonly string[];
  referenceId: string;
}

/**
 * Reverses every active row a document owns (reference_type / reference_id) after one
 * lockInventoryRows call for all their items and warehouses (LOCK ORDER of stockLocks.ts): its
 * Out / AdjustmentOut rows first, then the others, each group newest first (createdAt, then
 * movement number): a later row was posted on the book the earlier one left, so taking it back
 * first walks the book through states that existed. The document's own outbound rows are not goods
 * that went out after its inbound or Revaluation rows (a stock count writes both for one item in
 * one transaction), so they are back before reversalSweep looks for sales since. A sweep row an
 * earlier reversal of the document wrote (a Revaluation adjusting a cancelled row of the same
 * document) is already the settlement of that row and is left alone. A refusal of any row is thrown
 * after earlier rows were written: the caller's transaction rolls back as a whole.
 */
export async function reverseDocumentMovements(tx: Tx, ref: DocumentRef, opts: ReverseOptions): Promise<ReverseResult[]> {
  const types: readonly string[] = typeof ref.referenceType === 'string' ? [ref.referenceType] : ref.referenceType;
  const rows = await tx.stockMovement.findMany({
    where: { referenceType: { in: [...types] }, referenceId: ref.referenceId, isCancelled: false },
    orderBy: [{ createdAt: 'desc' }, { movementNumber: 'desc' }],
    select: {
      id: true, itemId: true, warehouseId: true, movementType: true,
      adjustsMovement: { select: { isCancelled: true, referenceType: true, referenceId: true } },
    },
  });
  const settled = rows.filter((r) => !(r.adjustsMovement?.isCancelled
    && types.includes(r.adjustsMovement.referenceType ?? '') && r.adjustsMovement.referenceId === ref.referenceId));
  const owned = [
    ...settled.filter((r) => OUTBOUND_TYPES.has(r.movementType)),
    ...settled.filter((r) => !OUTBOUND_TYPES.has(r.movementType)),
  ];
  await lockInventoryRows(tx, {
    itemIds: owned.map((r) => r.itemId),
    pairs: owned.flatMap((r) => (r.warehouseId ? [{ itemId: r.itemId, warehouseId: r.warehouseId }] : [])),
  });
  const results: ReverseResult[] = [];
  for (const row of owned) results.push(await reverseMovement(tx, row.id, opts));
  return results;
}

/** A document edit of one outbound row: its new quantity and day; the cost is decided here. */
export interface ReviseOutboundInput {
  quantity: Decimal.Value;
  date: Date;
  fiscalYearId: string;
  userId: string;
  notes?: string | null;
  /** Taken by the caller after lockInventoryRows; the ledger takes an 'SM' number otherwise. */
  movementNumber?: string;
  /**
   * 'replay': a lower quantity also trues up what the outbound rows since took (ReverseOptions.trueUp),
   * so the edit leaves the book a cancel and a new note would; sweepAtZero and journalDay as there.
   */
  trueUp?: 'none' | 'replay';
  sweepAtZero?: boolean;
  journalDay?: string;
}

export interface RevisedOutbound extends PostedMovement {
  /** The edited row, now cancelled. */
  previous: StockMovement;
  /** What the edit moved into stock_value: + value handed back (lower quantity), − the extra taken out. */
  change: Decimal;
  /** As ReverseResult: the value true-up, the zero-stock sweep and their Revaluation row (postReversalValueJournals). */
  trueUp: Decimal;
  toCogs: Decimal;
  sweep: StockMovement | null;
}

/**
 * Re-posts an Out / AdjustmentOut row of a document edit at a new quantity and day, keeping the cost
 * it was posted at (owner decision #9, revisedOutboundValue): an unchanged quantity keeps its value,
 * a lower one hands the difference back at the row's own unit value, a higher one takes only the
 * extra out at the book's value now. The row is cancelled and a new one written (a row is never
 * rewritten) on the same warehouse and document, with the old row's createdAt: in processing order
 * (replay, sales since) it stands where the goods it kept went out. Only the difference moves stock,
 * stock_value and the average. The caller checks the stock the extra needs (assertStockAvailable).
 * A higher quantity is refused once value entered the book after the row (valueEnteredAfter,
 * OUTBOUND_INCREASE_AFTER_INBOUND): at the row's place the replay would value the extra at the
 * average before that value, so the extra goes on a row of its own posted now. With trueUp 'replay'
 * a lower quantity is trued up like a cancel (replayTrueUp of the revised row) and value left at zero
 * stock swept (sweepAtZero), in one Revaluation row dated journalDay whose journal the caller posts
 * with postReversalValueJournals.
 */
export async function reviseOutbound(tx: Tx, movementId: string, i: ReviseOutboundInput): Promise<RevisedOutbound> {
  const ref = await tx.stockMovement.findUnique({ where: { id: movementId }, select: { itemId: true, warehouseId: true } });
  if (!ref) throw new BusinessError('Gerakan stok tidak ditemukan.');
  if (!ref.warehouseId) throw new Error(`reviseOutbound: movement ${movementId} has no warehouse`);
  const item = await lockItem(tx, ref.itemId, ref.warehouseId);
  const movement = await tx.stockMovement.findUniqueOrThrow({ where: { id: movementId } });
  if (movement.isCancelled) throw new BusinessError('Gerakan stok sudah dibatalkan.');
  if (!OUTBOUND_TYPES.has(movement.movementType)) throw new Error(`reviseOutbound: ${movement.movementType} is not an outbound type`);
  const quantity = positiveQuantity(i.quantity, 'reviseOutbound');
  const oldQty = dec(movement.quantity);
  const oldValue = dec(movement.valueDelta).negated();
  const value = revisedOutboundValue(
    { qty: oldQty, value: oldValue }, quantity, { stock: item.currentStock, stockValue: item.stockValue, avg: item.averageCost },
  );
  const qtyDelta = oldQty.minus(quantity);
  if (qtyDelta.lt(0) && await valueEnteredAfter(tx, movement)) throw increaseAfterInbound(item.name);
  if (qtyDelta.lt(0)) assertCostedPastZero(item, qtyDelta.negated());
  const change = oldValue.minus(value);
  const replay = i.trueUp === 'replay' && qtyDelta.gt(0);
  const trueUp = replay ? await replayTrueUp(tx, movement, item, { quantity, valueDelta: value.negated() }) : new Decimal(0);
  const next = stateAfter(item, qtyDelta, change.plus(trueUp));
  // Goods handed back that bring stock to exactly 0 with value left: swept with the true-up, refused
  // without it (the same refusal as an exact reversal).
  if (!replay && qtyDelta.gt(0) && next.stock.isZero() && !next.value.isZero()) throw residueAtZero(item.name, next, true);
  const residue = replay ? replaySweep(item.name, next, i.sweepAtZero === true) : new Decimal(0);
  // Every guard runs before the first write, as in reverseMovement.
  const period = trueUp.isZero() && residue.isZero() ? null : await sweepPeriod(tx, { userId: i.userId, journalDay: i.journalDay });

  await claimReversal(tx, movement.id);
  const movementNumber = i.movementNumber ?? await generateDocumentNumber(tx, 'SM', i.date, i.fiscalYearId);
  const booked = residue.isZero() ? next : { ...next, value: next.value.minus(residue) };
  await writeStock(tx, movement.itemId, movement.warehouseId, qtyDelta, booked);
  const unitCost = value.div(quantity).toDecimalPlaces(UNIT_COST_DP);
  const valueDelta = value.negated();
  const posted = await insertMovement(tx, {
    movementNumber, date: i.date, itemId: movement.itemId, warehouseId: movement.warehouseId, movementType: movement.movementType,
    quantity: quantity.toString(), unitCost: unitCost.toString(), totalValue: value.toString(), valueDelta: valueDelta.toString(),
    notes: i.notes ?? movement.notes, referenceType: movement.referenceType, referenceId: movement.referenceId,
    referenceNumber: movement.referenceNumber, offsetAccountId: value.isZero() ? null : movement.offsetAccountId,
    sourceMovementId: movement.sourceMovementId,
    unitCostLoaded: movement.unitCostLoaded == null ? null : movement.unitCostLoaded.toString(),
    fiscalYearId: i.fiscalYearId, createdById: i.userId, createdAt: movement.createdAt,
  });
  // After the re-posted row: its number is taken but not in the table until then.
  const sweep = period ? await writeSettlementRow(tx, movement, { trueUp, residue }, period, i.userId, 'edit') : null;
  return {
    movement: posted, previous: { ...movement, isCancelled: true }, change, valueDelta, unitCost, trueUp, toCogs: residue, sweep,
    stockAfter: booked.stock, stockValueAfter: booked.value, averageCostAfter: booked.average,
  };
}

/** The fields of an inbound row its batch cost is computed from. */
export interface BatchRow {
  id: string;
  quantity: Prisma.Decimal | Decimal.Value;
  unitCost: Prisma.Decimal | Decimal.Value;
  totalValue: Prisma.Decimal | Decimal.Value;
  valueDelta: Prisma.Decimal | Decimal.Value;
}

/**
 * Unit cost of inbound batches as the batch picker shows them: the value the row put into the book
 * plus every active Revaluation that adjusts it (a purchase invoice's landed cost or price revision,
 * PR-6.4c3), over its quantity, 6 dp. Computed, never stored: the row itself is not rewritten. The
 * row's value is its value_delta, not total_value: a purchase invoice before the value ledger
 * rewrote the STT row's total_value / unit_cost to the landed amount, and the backfill carries that
 * delta as an SM-RV- Revaluation adjusting the row (whose value_delta is the locked cost), so
 * total_value would count it twice. A row whose value_delta is 0 (a transfer leg) uses total_value;
 * a row that nothing adjusts and nothing rewrote keeps its unit_cost.
 */
export async function batchUnitCosts(db: Tx, rows: readonly BatchRow[]): Promise<Map<string, Decimal>> {
  const costs = new Map<string, Decimal>();
  if (rows.length === 0) return costs;
  const adjustments = await db.stockMovement.groupBy({
    by: ['adjustsMovementId'],
    // A negative-stock settlement re-values goods that went out before the batch, not the batch.
    where: {
      adjustsMovementId: { in: rows.map((r) => r.id) }, movementType: 'Revaluation', isCancelled: false,
      OR: [{ referenceType: null }, { referenceType: { not: NEGATIVE_STOCK_SETTLE_REFERENCE } }],
    },
    _sum: { valueDelta: true },
  });
  const adjusted = new Map(adjustments.map((a) => [a.adjustsMovementId, dec(a._sum.valueDelta ?? 0)]));
  for (const row of rows) {
    const extra = adjusted.get(row.id) ?? new Decimal(0);
    const quantity = dec(row.quantity);
    const booked = dec(row.valueDelta);
    const base = booked.isZero() ? dec(row.totalValue) : booked;
    const rewritten = !booked.isZero() && !booked.eq(dec(row.totalValue));
    costs.set(row.id, quantity.gt(0) && (!extra.isZero() || rewritten)
      ? base.plus(extra).div(quantity).toDecimalPlaces(UNIT_COST_DP)
      : dec(row.unitCost));
  }
  return costs;
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
