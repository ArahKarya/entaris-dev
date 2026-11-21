/**
 * Manual stock movements (Stock In / Stock Out / Adjustment + / Adjustment −) posted, edited and
 * cancelled inside the caller's transaction (E3-R4, owner decision #7).
 *
 * Cost: an outbound row is valued at the item's average cost read under the stock lock; a cost
 * sent by the client is ignored. An inbound row needs a unit cost above 0 (MANUAL_IN_ZERO_COST).
 * Offset: an inbound row needs one (OFFSET_REQUIRED); an outbound row without one goes to the
 * Inventory Variance account, which must be a detail account of its own (varianceAccount.ts).
 * Every offset passes STOCK_OFFSET_RULE. The journal goes through postJournal (SYSTEM_DOC); an
 * edit or cancel voids it through cancelJournalsInTx, so stored balances move per journal line.
 *
 * Lock order (stockLocks.ts): the movement row, lockInventoryRows, the SM or JV number, then the
 * account rows (an edit takes the new JV number before it voids the old journal, whose balance
 * updates lock account rows).
 *
 * The item vs warehouse drift repair (PR-6.3d) writes its stock here too: placeUnplacedStockInTx
 * and writeOffUnplacedStockInTx at the end of this file.
 */
import type { Prisma, StockMovement } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { UNIT_COST_DP } from './inventoryValueMath';
import { MOVEMENT_DOCUMENT_LOCKED, STOCK_DRIFT_REFERENCE, documentMovementLockMessage } from '../documentMovementLock';
import { assertBatchSource } from './batchSource';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { getOpenFiscalYear } from '../../utils/fiscalYear';
import { assertPeriodOpen } from '../../utils/periodGuard';
import { mappedAccount } from '../systemAccounts';
import { calcAverageAfterRemoval, calcWeightedAverage } from '../../utils/weightedAverage';
import { settleCogsBackfillForItem } from '../cogsBackfillService';
import { reverseCogsSettlementsByTrigger } from '../cogsBackfillReverse';
import { recomputeAverageCostFromReplay, replayAverageCost } from '../averageCostRecompute';
import { adjustWarehouseStock, resolveWarehouseId } from '../../utils/warehouseStock';
import { assertStockAvailable, lockInventoryRows, stockKey, type LockedItem } from './stockLocks';
import { assertVarianceAccountUsable } from './varianceAccount';
import { postJournal } from '../ledger/postJournal';
import { DOCUMENT_RULE, STOCK_OFFSET_RULE, assertPostableAccounts } from '../ledger/accountGuard';
import { cancelJournalsInTx } from '../ledger/cancelJournals';
import { cancelTrail } from '../../utils/cancelClaim';

type Tx = Prisma.TransactionClient;

/** Error code (400): a manual Stock In or Adjustment + without a unit cost above 0. */
export const MANUAL_IN_ZERO_COST = 'MANUAL_IN_ZERO_COST';
/** Error code (400): a manual Stock In or Adjustment + without an offset account. */
export const OFFSET_REQUIRED = 'OFFSET_REQUIRED';
/** Error code (400): a drift repair quantity beyond the stock that no warehouse holds. */
export const DRIFT_QUANTITY_EXCEEDED = 'DRIFT_QUANTITY_EXCEEDED';

export type ManualMovementType = 'In' | 'Out' | 'AdjustmentIn' | 'AdjustmentOut';

export interface ManualMovementFields {
  movementType: ManualMovementType;
  quantity: number;
  /** Used for inbound rows only; an outbound row is valued at the average cost. */
  unitCost?: number;
  date: string;
  offsetAccountId?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
}

export interface ManualMovementCreate extends ManualMovementFields {
  itemId: string;
  warehouseId?: string | null;
  sourceMovementId?: string | null;
}

const TYPE_LABELS: Record<ManualMovementType, string> = {
  In: 'Stok Masuk',
  Out: 'Stok Keluar',
  AdjustmentIn: 'Penyesuaian Stok +',
  AdjustmentOut: 'Penyesuaian Stok −',
};

const ITEM_SUMMARY = { item: { select: { id: true, name: true, code: true, unit: true } } } as const;

export const isInbound = (type: string): boolean => type === 'In' || type === 'AdjustmentIn';

/**
 * Unit cost and value of a row: the body's cost for inbound (> 0), the locked average for outbound.
 * The body's cost is rounded to UNIT_COST_DP first, so the value and the average come from the cost
 * the column stores.
 */
export function manualMovementValue(
  type: ManualMovementType,
  quantity: Decimal.Value,
  bodyUnitCost: number | undefined,
  averageCost: Decimal.Value,
): { unitCost: Decimal; totalValue: Decimal } {
  const unitCost = isInbound(type)
    ? new Decimal(bodyUnitCost ?? 0).toDecimalPlaces(UNIT_COST_DP)
    : new Decimal(averageCost);
  if (isInbound(type) && unitCost.lte(0)) {
    throw new BusinessError('Stok masuk manual wajib memakai harga satuan lebih dari 0.', MANUAL_IN_ZERO_COST);
  }
  return { unitCost, totalValue: new Decimal(quantity).mul(unitCost).toDecimalPlaces(2) };
}

/**
 * The offset account of a row: required for inbound; for outbound the body's or, when a journal
 * is posted, the Inventory Variance account. A given offset is checked against STOCK_OFFSET_RULE
 * even when no journal follows; postJournal checks it again under the account row lock.
 */
async function resolveOffsetAccountId(
  tx: Tx,
  type: ManualMovementType,
  offsetAccountId: string | null | undefined,
  totalValue: Decimal,
): Promise<string | null> {
  if (offsetAccountId) {
    await assertPostableAccounts(tx, [offsetAccountId], STOCK_OFFSET_RULE);
    return offsetAccountId;
  }
  if (isInbound(type)) throw new BusinessError('Akun lawan wajib dipilih untuk stok masuk manual.', OFFSET_REQUIRED);
  return totalValue.gt(0) ? (await assertVarianceAccountUsable(tx)).id : null;
}

/**
 * Whether a stored offset still passes STOCK_OFFSET_RULE. Older rows were posted against the opening
 * balance equity (3.1), which an edit now refuses; the edit form clears such an offset up front.
 */
export async function stockOffsetAllowed(tx: Tx, offsetAccountId: string): Promise<boolean> {
  try {
    await assertPostableAccounts(tx, [offsetAccountId], STOCK_OFFSET_RULE);
    return true;
  } catch (error) {
    if (error instanceof BusinessError) return false;
    throw error;
  }
}

interface JournalInput {
  type: ManualMovementType;
  item: { name: string; unit: string; accountId: string | null };
  offsetAccountId: string;
  totalValue: Decimal;
  quantity: Decimal.Value;
  date: Date;
  notes?: string | null;
  edit?: boolean;
  /** Taken by the caller before it voided the old journal (lock order); postJournal takes one otherwise. */
  entryNumber?: string;
  userId: string;
  fiscalYearId: string;
}

/** DR inventory / CR offset for inbound, the mirror for outbound, through postJournal. */
async function postMovementJournal(tx: Tx, j: JournalInput): Promise<string> {
  const inventoryAccountId = j.item.accountId ?? (await mappedAccount(tx, 'INVENTORY')).id;
  const narration = `${TYPE_LABELS[j.type]}: ${j.item.name} ${new Decimal(j.quantity).toString()} ${j.item.unit}`
    + `${j.notes ? ' - ' + j.notes : ''}${j.edit ? ' (Edit)' : ''}`;
  const [debitId, creditId] = isInbound(j.type) ? [inventoryAccountId, j.offsetAccountId] : [j.offsetAccountId, inventoryAccountId];
  const { journal } = await postJournal(tx, {
    date: j.date,
    narration,
    lines: [
      { accountId: debitId, debit: j.totalValue.toString(), credit: 0, description: narration },
      { accountId: creditId, debit: 0, credit: j.totalValue.toString(), description: narration },
    ],
    sourceType: 'SYSTEM_DOC',
    createdBy: j.userId,
    accountRule: DOCUMENT_RULE,
    lineRules: new Map([[j.offsetAccountId, STOCK_OFFSET_RULE]]),
    partyRule: 'off',
    expectFiscalYearId: j.fiscalYearId,
    entryNumber: j.entryNumber,
  });
  return journal.id;
}

/** Voids the row's journal (if any) in place; its period must be open. */
async function voidMovementJournal(tx: Tx, journalEntryId: string | null, userId: string): Promise<void> {
  if (!journalEntryId) return;
  const journal = await tx.journalEntry.findUnique({ where: { id: journalEntryId }, include: { items: true } });
  if (journal) await cancelJournalsInTx(tx, [journal], { label: 'mutasi stok', trail: cancelTrail(userId) });
}

/** Warehouse from the body or the default; it must exist and be active. */
async function activeWarehouseId(tx: Tx, preferred: string | null | undefined): Promise<string> {
  const warehouseId = await resolveWarehouseId(tx, preferred || null);
  if (!warehouseId) throw new BusinessError('Gudang tidak ditemukan dan tidak ada gudang default aktif.');
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { isActive: true } });
  if (!warehouse) throw new BusinessError('Gudang tidak ditemukan.');
  if (!warehouse.isActive) throw new BusinessError('Gudang tidak aktif.');
  return warehouseId;
}

/**
 * The one place this module writes stock: the warehouse row (skipped for null) and the item total,
 * with the item's new average when given. Callers hold the rows through lockInventoryRows.
 */
async function writeStock(
  tx: Tx,
  w: { itemId: string; warehouseId: string | null; warehouseDelta: Decimal.Value; itemDelta: Decimal.Value; averageCost?: number },
): Promise<void> {
  const warehouseDelta = new Decimal(w.warehouseDelta);
  const itemDelta = new Decimal(w.itemDelta);
  if (w.warehouseId && !warehouseDelta.isZero()) {
    await tx.inventoryStock.upsert({
      where: { itemId_warehouseId: { itemId: w.itemId, warehouseId: w.warehouseId } },
      create: { itemId: w.itemId, warehouseId: w.warehouseId, currentStock: warehouseDelta.toString() },
      update: { currentStock: { increment: warehouseDelta.toString() } },
    });
  }
  if (itemDelta.isZero() && w.averageCost === undefined) return;
  await tx.inventoryItem.update({
    where: { id: w.itemId },
    data: {
      currentStock: { increment: itemDelta.toString() },
      ...(w.averageCost !== undefined ? { averageCost: w.averageCost } : {}),
    },
  });
}

/** Stock and average of a new row; the movement row itself is written by the caller. */
async function applyCreateStock(
  tx: Tx,
  item: { id: string; currentStock: Decimal; averageCost: Decimal },
  warehouseId: string,
  type: ManualMovementType,
  quantity: number,
  unitCost: Decimal,
): Promise<void> {
  const stockDelta = isInbound(type) ? quantity : -quantity;
  await writeStock(tx, {
    itemId: item.id, warehouseId, warehouseDelta: stockDelta, itemDelta: stockDelta,
    averageCost: isInbound(type) ? calcWeightedAverage(item.currentStock, item.averageCost, quantity, unitCost) : undefined,
  });
}

/** The movement row of a new manual movement (also of a drift write-off). */
function insertMovement(tx: Tx, data: Prisma.StockMovementUncheckedCreateInput) {
  return tx.stockMovement.create({ data, include: ITEM_SUMMARY });
}

/** Posts a new manual movement: stock, average, journal and the COGS auto-settle of an inbound row. */
export async function createManualMovementInTx(tx: Tx, input: ManualMovementCreate, userId: string) {
  const movementDate = new Date(input.date);
  const fiscalYear = await getOpenFiscalYear(tx, movementDate);
  const warehouseId = await activeWarehouseId(tx, input.warehouseId);

  const locked = await lockInventoryRows(tx, { itemIds: [input.itemId], pairs: [{ itemId: input.itemId, warehouseId }] });
  const item = locked.items.get(input.itemId);
  if (!item) throw new BusinessError('Item stok tidak ditemukan.');
  if (!item.isActive) throw new BusinessError('Item stok tidak aktif.');
  if (!locked.stocks.has(stockKey(item.id, warehouseId))) throw new BusinessError('Gudang tidak ditemukan.');

  const inbound = isInbound(input.movementType);
  const { unitCost, totalValue } = manualMovementValue(input.movementType, input.quantity, input.unitCost, item.averageCost);
  if (!inbound) {
    await assertStockAvailable(tx, [{ itemId: item.id, warehouseId, quantity: input.quantity }], { context: 'inventory.movement.create', userId });
  }
  const offsetAccountId = await resolveOffsetAccountId(tx, input.movementType, input.offsetAccountId, totalValue);
  const sourceMovementId = !inbound && input.sourceMovementId
    ? (await assertBatchSource(tx, { sourceMovementId: input.sourceMovementId, inventoryItemId: item.id, itemName: item.name })).id
    : null;

  const movementNumber = await generateDocumentNumber(tx, 'SM', movementDate, fiscalYear.id);
  await applyCreateStock(tx, item, warehouseId, input.movementType, input.quantity, unitCost);
  const journalEntryId = totalValue.gt(0) && offsetAccountId
    ? await postMovementJournal(tx, {
      type: input.movementType, item, offsetAccountId, totalValue, quantity: input.quantity,
      date: movementDate, notes: input.notes, userId, fiscalYearId: fiscalYear.id,
    })
    : null;

  const movement = await insertMovement(tx, {
    movementNumber, date: movementDate, itemId: item.id, warehouseId, movementType: input.movementType,
    quantity: input.quantity, unitCost: unitCost.toString(), totalValue: totalValue.toString(),
    notes: input.notes || null,
    // Only documents set referenceType/referenceId (that is what locks a movement); a manual
    // movement keeps the client's free-text referenceNumber.
    referenceType: null, referenceId: null, referenceNumber: input.referenceNumber || null,
    offsetAccountId, sourceMovementId, journalEntryId, fiscalYearId: fiscalYear.id, createdById: userId,
  });

  if (inbound) {
    await settleCogsBackfillForItem(tx, {
      itemId: item.id, qtyAvailable: input.quantity, unitCostNow: unitCost.toNumber(), userId, settleDate: movementDate,
      source: { type: 'StockMovement', refId: movement.id, refNo: movementNumber },
    });
  }
  return movement;
}

/** Locks the movement row and refuses a missing, cancelled or document-owned one. */
async function lockManualMovement(tx: Tx, id: string, action: 'edit' | 'cancel'): Promise<StockMovement> {
  // A concurrent edit or cancel of the same row waits here, then re-reads.
  await tx.$queryRaw`SELECT id FROM stock_movements WHERE id = ${id} FOR UPDATE`;
  const movement = await tx.stockMovement.findUnique({ where: { id } });
  if (!movement) throw new BusinessError('Gerakan stok tidak ditemukan.');
  if (movement.isCancelled) {
    throw new BusinessError(action === 'edit' ? 'Gerakan stok sudah dibatalkan, tidak bisa diedit.' : 'Gerakan stok sudah dibatalkan.');
  }
  // Document movements are changed from their document: a per-line change would orphan its journal.
  const lockMessage = documentMovementLockMessage(movement, action);
  if (lockMessage) throw new BusinessError(lockMessage, MOVEMENT_DOCUMENT_LOCKED);
  return movement;
}

interface ItemState {
  stock: Decimal;
  average: Decimal;
}

/**
 * Takes the row's stock back out (inbound) or puts it back (outbound) at its own warehouse, after
 * the per-warehouse check of an inbound reversal; a legacy row without a warehouse is checked
 * against the item total. Locks the item first and returns its stock and average read under the lock,
 * before the reversal.
 */
async function reverseMovementStock(tx: Tx, movement: StockMovement, context: string, userId: string): Promise<ItemState> {
  const locked = await lockInventoryRows(tx, {
    itemIds: [movement.itemId],
    pairs: movement.warehouseId ? [{ itemId: movement.itemId, warehouseId: movement.warehouseId }] : [],
  });
  const qty = Number(movement.quantity);
  if (isInbound(movement.movementType)) {
    await assertStockAvailable(tx, [{ itemId: movement.itemId, warehouseId: movement.warehouseId, quantity: qty }], { context, userId, reversal: true });
  }
  const reverseDelta = isInbound(movement.movementType) ? -qty : qty;
  await tx.inventoryItem.update({ where: { id: movement.itemId }, data: { currentStock: { increment: reverseDelta } } });
  await adjustWarehouseStock(tx, movement.itemId, movement.warehouseId, reverseDelta);
  const item = locked.items.get(movement.itemId);
  return { stock: item?.currentStock ?? new Decimal(0), average: item?.averageCost ?? new Decimal(0) };
}

/**
 * The item's stock and average after the old row is reversed. Reversing an outbound row leaves the
 * average unchanged. Reversing an inbound row replays the movements without it; when they do not
 * explain the stock (stock without a movement behind it), the row is taken out of the locked
 * average at its own cost instead, so the stored average no longer carries the reversed cost.
 */
async function stateAfterReversal(tx: Tx, oldMov: StockMovement, locked: ItemState): Promise<ItemState> {
  const qty = new Decimal(oldMov.quantity.toString());
  if (!isInbound(oldMov.movementType)) return { stock: locked.stock.plus(qty), average: locked.average };
  const replayed = await replayAverageCost(tx, oldMov.itemId, { excludeMovementIds: [oldMov.id] });
  const average = replayed?.explained
    ? replayed.averageCost
    : calcAverageAfterRemoval(locked.stock, locked.average, qty, new Decimal(oldMov.unitCost.toString()));
  return { stock: locked.stock.minus(qty), average: new Decimal(average) };
}

/**
 * Edits a manual movement: the old stock and journal are reversed, then the row is re-posted from
 * the body on the same warehouse. An outbound row is re-valued at the average after the reversal,
 * never at the client's cost; an inbound row is weighted into that average.
 */
export async function editManualMovementInTx(tx: Tx, id: string, input: ManualMovementFields, userId: string) {
  const oldMov = await lockManualMovement(tx, id, 'edit');
  // The old and the new period must both be open, also when no journal is posted. The stored
  // fiscalYearId is not checked: older edits never updated it, and the journals check their own year.
  const movementDate = new Date(input.date);
  if (isNaN(movementDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  await assertPeriodOpen(tx, { date: oldMov.date }, 'mutasi stok');
  const fiscalYear = await assertPeriodOpen(tx, { date: movementDate }, 'mutasi stok');

  const locked = await reverseMovementStock(tx, oldMov, 'inventory.movement.edit', userId);
  const after = await stateAfterReversal(tx, oldMov, locked);
  const newIsIn = isInbound(input.movementType);
  const { unitCost, totalValue } = manualMovementValue(input.movementType, input.quantity, input.unitCost, after.average);
  if (!newIsIn) {
    await assertStockAvailable(tx, [{ itemId: oldMov.itemId, warehouseId: oldMov.warehouseId, quantity: input.quantity }], {
      context: 'inventory.movement.edit', userId,
    });
  }
  const offsetAccountId = await resolveOffsetAccountId(tx, input.movementType, input.offsetAccountId, totalValue);
  const newDelta = newIsIn ? input.quantity : -input.quantity;
  const averageCost = newIsIn ? calcWeightedAverage(after.stock, after.average, input.quantity, unitCost) : after.average.toNumber();
  await tx.inventoryItem.update({ where: { id: oldMov.itemId }, data: { currentStock: { increment: newDelta }, averageCost } });
  await adjustWarehouseStock(tx, oldMov.itemId, oldMov.warehouseId, newDelta);

  const journalEntryId = await repostMovementJournal(tx, oldMov, {
    input, offsetAccountId, totalValue, movementDate, userId, fiscalYearId: fiscalYear.id,
  });
  const updated = await tx.stockMovement.update({
    where: { id },
    data: {
      date: movementDate, fiscalYearId: fiscalYear.id, movementType: input.movementType, quantity: input.quantity,
      unitCost: unitCost.toString(), totalValue: totalValue.toString(), offsetAccountId, journalEntryId,
      notes: input.notes || null,
      // referenceType is never written from the body; an inbound row consumes no batch.
      referenceNumber: input.referenceNumber || null,
      ...(newIsIn ? { sourceMovementId: null } : {}),
    },
    include: ITEM_SUMMARY,
  });
  await resettleEditedInbound(tx, oldMov, input, unitCost, { movementDate, userId });
  return updated;
}

/**
 * Voids the old journal and posts the edited one. The new JV number is taken first: voiding
 * updates account balances (row locks), and every JV writer takes the number before account rows.
 */
async function repostMovementJournal(
  tx: Tx,
  oldMov: StockMovement,
  j: { input: ManualMovementFields; offsetAccountId: string | null; totalValue: Decimal; movementDate: Date; userId: string; fiscalYearId: string },
): Promise<string | null> {
  const offsetAccountId = j.totalValue.gt(0) ? j.offsetAccountId : null;
  const entryNumber = offsetAccountId ? await generateDocumentNumber(tx, 'JV', j.movementDate, j.fiscalYearId) : undefined;
  await voidMovementJournal(tx, oldMov.journalEntryId, j.userId);
  if (!offsetAccountId) return null;
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: oldMov.itemId }, select: { name: true, unit: true, accountId: true } });
  return postMovementJournal(tx, {
    type: j.input.movementType, item, offsetAccountId, totalValue: j.totalValue, quantity: j.input.quantity,
    date: j.movementDate, notes: j.input.notes, edit: true, entryNumber, userId: j.userId, fiscalYearId: j.fiscalYearId,
  });
}

/**
 * Editing an inbound movement makes its COGS auto-settle stale: reverse it, then re-settle if still
 * stock-in. The edit can change type, quantity and cost, so the average is replayed from all active rows.
 */
async function resettleEditedInbound(
  tx: Tx,
  oldMov: StockMovement,
  input: ManualMovementFields,
  unitCost: Decimal,
  ctx: { movementDate: Date; userId: string },
): Promise<void> {
  await reverseCogsSettlementsByTrigger(tx, 'StockMovement', oldMov.id);
  if (isInbound(input.movementType)) {
    await settleCogsBackfillForItem(tx, {
      itemId: oldMov.itemId, qtyAvailable: input.quantity, unitCostNow: unitCost.toNumber(), userId: ctx.userId,
      settleDate: ctx.movementDate, source: { type: 'StockMovement', refId: oldMov.id, refNo: oldMov.movementNumber },
    });
  }
  await recomputeAverageCostFromReplay(tx, oldMov.itemId);
}

/** Cancels a manual movement: stock back, journal voided, COGS auto-settle reversed, average replayed. */
export async function cancelManualMovementInTx(tx: Tx, id: string, userId: string): Promise<void> {
  const movement = await lockManualMovement(tx, id, 'cancel');
  // By date only, as on edit: the journal and auto-settle journals check their own year.
  await assertPeriodOpen(tx, { date: movement.date }, 'mutasi stok');
  await reverseMovementStock(tx, movement, 'inventory.movement.cancel', userId);
  await voidMovementJournal(tx, movement.journalEntryId, userId);
  await tx.stockMovement.update({ where: { id }, data: { isCancelled: true } });
  await reverseCogsSettlementsByTrigger(tx, 'StockMovement', id);
  await recomputeAverageCostFromReplay(tx, movement.itemId);
}

// Item vs warehouse drift repair (owner decision #18, PR-6.3d; driven by stockDriftRepair.ts).
// inventory_items.current_stock above the sum of inventory_stocks is stock that no warehouse holds:
// it cannot be taken out of any warehouse, yet it counts in the inventory value. The accountant
// decides per item whether the goods are there (assign) or gone (writeoff).

const formatQty = (d: Decimal) => d.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Item total minus the sum of its warehouse rows, read under the item lock (negative: the warehouses hold more). */
async function unplacedStock(tx: Tx, item: LockedItem): Promise<Decimal> {
  const sum = await tx.inventoryStock.aggregate({ where: { itemId: item.id }, _sum: { currentStock: true } });
  return item.currentStock.minus(sum._sum.currentStock?.toString() ?? 0);
}

function driftExceeded(item: LockedItem, unplaced: Decimal, quantity: Decimal): BusinessError {
  return new BusinessError(
    `Stok '${item.name}' di luar gudang ${formatQty(unplaced)} ${item.unit}; perbaikan ${formatQty(quantity)} ${item.unit} ditolak.`,
    DRIFT_QUANTITY_EXCEEDED,
  );
}

/**
 * Drift repair `assign`: the goods are there, so stock that no warehouse holds is booked into
 * `warehouseId`; a negative quantity takes a warehouse's excess over the item total back out of it.
 * The item total, its average and the GL do not change, and no movement row is written (the
 * caller's audit row records it).
 */
export async function placeUnplacedStockInTx(
  tx: Tx,
  input: { itemId: string; warehouseId: string; quantity: Decimal.Value },
): Promise<void> {
  const quantity = new Decimal(input.quantity);
  const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { isActive: true } });
  if (!warehouse) throw new BusinessError('Gudang tidak ditemukan.');
  if (quantity.gt(0) && !warehouse.isActive) throw new BusinessError('Gudang tidak aktif.');
  const locked = await lockInventoryRows(tx, { itemIds: [input.itemId], pairs: [{ itemId: input.itemId, warehouseId: input.warehouseId }] });
  const item = locked.items.get(input.itemId);
  if (!item) throw new BusinessError('Item stok tidak ditemukan.');
  const unplaced = await unplacedStock(tx, item);
  const held = locked.stocks.get(stockKey(item.id, input.warehouseId))?.currentStock ?? new Decimal(0);
  const fits = quantity.gt(0)
    ? quantity.lte(unplaced)
    : quantity.lt(0) && quantity.gte(unplaced) && held.plus(quantity).gte(0);
  if (!fits) throw driftExceeded(item, unplaced, quantity);
  await writeStock(tx, { itemId: item.id, warehouseId: input.warehouseId, warehouseDelta: quantity, itemDelta: 0 });
}

/**
 * Drift repair `writeoff`: the goods that no warehouse holds are gone. An Adjustment − without a
 * warehouse takes `quantity` off the item total at the average read under the lock; its journal
 * debits the Inventory Variance account (a detail account of its own, varianceAccount.ts) and
 * credits the item's inventory account, dated `day` in an open period. An item without a cost
 * (average 0) posts no journal. The row (referenceType STOCK_DRIFT_REFERENCE) cannot be edited or
 * cancelled per row.
 */
export async function writeOffUnplacedStockInTx(
  tx: Tx,
  input: { itemId: string; quantity: Decimal.Value; day: string; notes: string },
  userId: string,
) {
  const quantity = new Decimal(input.quantity);
  const movementDate = new Date(input.day);
  const fiscalYear = await assertPeriodOpen(tx, { date: movementDate }, 'mutasi stok');
  const locked = await lockInventoryRows(tx, { itemIds: [input.itemId] });
  const item = locked.items.get(input.itemId);
  if (!item) throw new BusinessError('Item stok tidak ditemukan.');
  const unplaced = await unplacedStock(tx, item);
  if (quantity.lte(0) || quantity.gt(unplaced)) throw driftExceeded(item, unplaced, quantity);

  const { unitCost, totalValue } = manualMovementValue('AdjustmentOut', quantity, undefined, item.averageCost);
  const offsetAccountId = await resolveOffsetAccountId(tx, 'AdjustmentOut', null, totalValue);
  const movementNumber = await generateDocumentNumber(tx, 'SM', movementDate, fiscalYear.id);
  await writeStock(tx, { itemId: item.id, warehouseId: null, warehouseDelta: 0, itemDelta: quantity.neg() });
  const journalEntryId = offsetAccountId
    ? await postMovementJournal(tx, {
      type: 'AdjustmentOut', item, offsetAccountId, totalValue, quantity,
      date: movementDate, notes: input.notes, userId, fiscalYearId: fiscalYear.id,
    })
    : null;
  return insertMovement(tx, {
    movementNumber, date: movementDate, itemId: item.id, warehouseId: null, movementType: 'AdjustmentOut',
    quantity: quantity.toString(), unitCost: unitCost.toString(), totalValue: totalValue.toString(), notes: input.notes,
    referenceType: STOCK_DRIFT_REFERENCE, referenceId: null, referenceNumber: null,
    offsetAccountId, journalEntryId, fiscalYearId: fiscalYear.id, createdById: userId,
  });
}
