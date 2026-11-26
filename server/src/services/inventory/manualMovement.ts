/**
 * Manual stock movements (Stock In / Stock Out / Adjustment + / Adjustment −) posted, edited and
 * cancelled inside the caller's transaction (E3-R4, owner decision #7), through the value ledger
 * (inventoryLedger.ts, E3-R6).
 *
 * Cost: an outbound row is valued by the ledger from the locked book (outboundValue); a cost sent by
 * the client is ignored. An inbound row needs a unit cost above 0 (MANUAL_IN_ZERO_COST) and books
 * quantity x that cost. Offset: an inbound row needs one (OFFSET_REQUIRED); an outbound row without
 * one goes to the Inventory Variance account, which must be a detail account of its own
 * (varianceAccount.ts). Every offset passes STOCK_OFFSET_RULE. The journal goes through postJournal
 * (SYSTEM_DOC) with the ledger's amount; an edit or cancel voids it through cancelJournalsInTx, so
 * stored balances move per journal line. An edit cancels the row and posts a new one (a ledger row
 * is never rewritten). Both take the row back with the value true-up of a cancel (trueUp 'replay',
 * E3-R8): goods that went out after it get their value corrected against COGS.
 *
 * Lock order (stockLocks.ts): the movement row, lockInventoryRows, the SM and JV numbers, then the
 * account rows (an edit takes both numbers before it voids the old journal, whose balance updates
 * lock account rows).
 *
 * The item vs warehouse drift repair (PR-6.3d) writes its stock here too: placeUnplacedStockInTx
 * (the warehouse row only) and writeOffUnplacedStockInTx (through the ledger) at the end of this file.
 */
import type { Prisma, StockMovement } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../../utils/errors';
import { UNIT_COST_DP, outboundValue } from './inventoryValueMath';
import { linkMovementJournal, placeUnplacedStock, postInbound, postOutbound, reverseMovement } from './inventoryLedger';
import { MOVEMENT_DOCUMENT_LOCKED, STOCK_DRIFT_REFERENCE, documentMovementLockMessage } from '../documentMovementLock';
import { assertBatchSource } from './batchSource';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { getOpenFiscalYear } from '../../utils/fiscalYear';
import { assertPeriodOpen } from '../../utils/periodGuard';
import { businessToday } from '../../utils/businessDate';
import { mappedAccount } from '../systemAccounts';
import { reverseCogsSettlementsByTrigger } from '../cogsBackfillReverse';
import { resolveWarehouseId } from '../../utils/warehouseStock';
import { assertStockAvailable, lockInventoryRows, stockKey, type LockedItem } from './stockLocks';
import { assertVarianceAccountUsable } from './varianceAccount';
import { postJournal } from '../ledger/postJournal';
import { DOCUMENT_RULE, STOCK_OFFSET_RULE, assertPostableAccounts } from '../ledger/accountGuard';
import { cancelJournalsInTx } from '../ledger/cancelJournals';
import { cancelTrail } from '../../utils/cancelClaim';
import { postReversalValueJournals } from './reversalValueJournal';

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

/** The movement row with its item, as the routes return it. */
function withItem(tx: Tx, id: string) {
  return tx.stockMovement.findUniqueOrThrow({ where: { id }, include: ITEM_SUMMARY });
}

interface PostInput {
  type: ManualMovementType;
  item: LockedItem;
  warehouseId: string;
  quantity: number;
  unitCost: number | undefined;
  offsetAccountId: string | null | undefined;
  sourceMovementId: string | null;
  movementDate: Date;
  fiscalYearId: string;
  notes?: string | null;
  referenceNumber?: string | null;
  /** An edit carries the old row's (a legacy free-text type without a document); never from the body. */
  referenceType?: string | null;
  edit?: boolean;
  userId: string;
}

/**
 * Posts one manual row through the value ledger and its journal. Inbound: the row's value is
 * quantity x the body's cost (> 0) and is debited to inventory. Outbound: the ledger values the row
 * from the locked book (outboundValue), and the journal credits inventory −valueDelta, linked to the
 * row afterwards. Both SM and JV numbers are taken before the journal locks account rows (an edit
 * takes them before it voids the old journal).
 */
async function postManualRow(tx: Tx, p: PostInput, numbers: { movementNumber: string; entryNumber?: string }) {
  const base = {
    itemId: p.item.id, warehouseId: p.warehouseId, quantity: p.quantity, date: p.movementDate, fiscalYearId: p.fiscalYearId,
    createdById: p.userId, movementNumber: numbers.movementNumber, notes: p.notes || null,
    // Only documents set referenceType/referenceId (that is what locks a movement); a manual
    // movement keeps the client's free-text referenceNumber.
    referenceType: p.referenceType ?? null, referenceId: null, referenceNumber: p.referenceNumber || null,
  };
  const journal = (offsetAccountId: string, totalValue: Decimal) => postMovementJournal(tx, {
    type: p.type, item: p.item, offsetAccountId, totalValue, quantity: p.quantity, date: p.movementDate,
    notes: p.notes, edit: p.edit, entryNumber: numbers.entryNumber, userId: p.userId, fiscalYearId: p.fiscalYearId,
  });
  if (isInbound(p.type)) {
    const { unitCost, totalValue } = manualMovementValue(p.type, p.quantity, p.unitCost, 0);
    const offsetAccountId = await resolveOffsetAccountId(tx, p.type, p.offsetAccountId, totalValue);
    const journalEntryId = offsetAccountId ? await journal(offsetAccountId, totalValue) : null;
    const posted = await postInbound(tx, {
      ...base, movementType: p.type as 'In' | 'AdjustmentIn', value: totalValue, offsetAccountId, journalEntryId,
    });
    return { posted, unitCost };
  }
  // The default offset (Inventory Variance) is needed only when the row carries value: read from the
  // book under the lock with the ledger's own rule, before anything is written.
  const book = (await lockInventoryRows(tx, { itemIds: [p.item.id] })).items.get(p.item.id) ?? p.item;
  const expected = outboundValue(book.currentStock, book.stockValue, book.averageCost, p.quantity);
  const offsetAccountId = await resolveOffsetAccountId(tx, p.type, p.offsetAccountId, expected);
  const posted = await postOutbound(tx, {
    ...base, movementType: p.type as 'Out' | 'AdjustmentOut', sourceMovementId: p.sourceMovementId, offsetAccountId,
  });
  const totalValue = posted.valueDelta.negated();
  if (offsetAccountId && totalValue.gt(0)) {
    await linkMovementJournal(tx, posted.movement.id, await journal(offsetAccountId, totalValue));
  }
  return { posted, unitCost: posted.unitCost };
}

/**
 * Posts a new manual movement: stock, book value and journal. An inbound row into negative stock
 * settles the window in the ledger (postInbound, E3-R9); the legacy COGS auto-settle no longer runs
 * here (owner decision #6). Its reversal on edit and cancel stays for settlements made before.
 */
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
  if (!inbound) {
    await assertStockAvailable(tx, [{ itemId: item.id, warehouseId, quantity: input.quantity }], { context: 'inventory.movement.create', userId });
  }
  const sourceMovementId = !inbound && input.sourceMovementId
    ? (await assertBatchSource(tx, { sourceMovementId: input.sourceMovementId, inventoryItemId: item.id, itemName: item.name })).id
    : null;

  const movementNumber = await generateDocumentNumber(tx, 'SM', movementDate, fiscalYear.id);
  const { posted } = await postManualRow(tx, {
    type: input.movementType, item, warehouseId, quantity: input.quantity, unitCost: input.unitCost,
    offsetAccountId: input.offsetAccountId, sourceMovementId, movementDate, fiscalYearId: fiscalYear.id,
    notes: input.notes, referenceNumber: input.referenceNumber, userId,
  }, { movementNumber });
  return withItem(tx, posted.movement.id);
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
  await assertBatchNotConsumed(tx, movement, action);
  return movement;
}

/**
 * Refuses an edit or cancel of a row that an active movement consumes as its batch
 * (sourceMovementId), as goodsReceiptCancel.ts does: the edit posts a new row with a new id, so the
 * consumer would point at a cancelled batch and the picker would offer its quantity again.
 */
async function assertBatchNotConsumed(tx: Tx, movement: StockMovement, action: 'edit' | 'cancel'): Promise<void> {
  const consumers = await tx.stockMovement.findMany({
    where: { sourceMovementId: movement.id, isCancelled: false },
    select: { movementNumber: true, referenceNumber: true },
    take: 5,
  });
  if (consumers.length === 0) return;
  const ref = consumers.map((c) => c.referenceNumber || c.movementNumber).join(', ');
  if (action === 'edit') {
    throw new BusinessError(
      `Gerakan stok ${movement.movementNumber} tidak dapat diedit: barang dari stok masuk ini sudah dipakai di transaksi lain (${ref}). ` +
        'Batalkan transaksi tersebut terlebih dahulu.',
    );
  }
  throw new BusinessError(
    `Gerakan stok ${movement.movementNumber} tidak dapat dibatalkan: barang dari stok masuk ini sudah dipakai di transaksi lain (${ref}). ` +
      'Batalkan transaksi tersebut terlebih dahulu.',
  );
}

/**
 * Takes the old row back through the value ledger after the per-warehouse check of an inbound
 * reversal (a legacy row without a warehouse is checked against the item total), with the value
 * true-up of a cancel (E3-R8): when goods of the item went out after the row, the value they took
 * differently comes back against COGS, and value left at zero stock is swept to COGS, in one
 * journal dated today (postReversalValueJournals). Call it before the row's own journal is voided
 * (LOCK ORDER of reversalValueJournal.ts).
 */
async function reverseManualRow(tx: Tx, movement: StockMovement, context: string, userId: string): Promise<void> {
  await lockInventoryRows(tx, {
    itemIds: [movement.itemId],
    pairs: movement.warehouseId ? [{ itemId: movement.itemId, warehouseId: movement.warehouseId }] : [],
  });
  if (isInbound(movement.movementType)) {
    await assertStockAvailable(tx, [{ itemId: movement.itemId, warehouseId: movement.warehouseId, quantity: movement.quantity.toString() }], {
      context, userId, reversal: true,
    });
  }
  const reversed = await reverseMovement(tx, movement.id, { userId, trueUp: 'replay', sweepAtZero: true });
  await postReversalValueJournals(tx, [reversed], { userId, documentLabel: `Mutasi stok ${movement.movementNumber}` });
}

/**
 * Locks today's SM and JV series, which the true-up row of reverseManualRow and its journal take
 * (dated today, postReversalValueJournals), before the COGS settlement reversal locks account rows
 * (LOCK ORDER of stockLocks.ts: numbers before accounts). The numbers are not used here; the series
 * lock is held until commit. generateDocumentNumber does not read the fiscal year id.
 */
async function lockTrueUpSeries(tx: Tx, fiscalYearId: string): Promise<void> {
  const today = new Date(businessToday());
  await generateDocumentNumber(tx, 'SM', today, fiscalYearId);
  await generateDocumentNumber(tx, 'JV', today, fiscalYearId);
}

/**
 * Edits a manual movement: the old row is reversed through the ledger and cancelled, its journal
 * voided, and a new row is posted from the body on the same warehouse (a ledger row is never
 * rewritten). An outbound row is valued from the book after the reversal, never at the client's
 * cost. Returns the new row.
 */
export async function editManualMovementInTx(tx: Tx, id: string, input: ManualMovementFields, userId: string) {
  const oldMov = await lockManualMovement(tx, id, 'edit');
  // The old and the new period must both be open, also when no journal is posted. The stored
  // fiscalYearId is not checked: older edits never updated it, and the journals check their own year.
  const movementDate = new Date(input.date);
  if (isNaN(movementDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  await assertPeriodOpen(tx, { date: oldMov.date }, 'mutasi stok');
  const fiscalYear = await assertPeriodOpen(tx, { date: movementDate }, 'mutasi stok');
  if (!oldMov.warehouseId) throw new BusinessError('Gerakan stok tanpa gudang tidak dapat diedit. Batalkan lalu catat ulang.');

  const locked = await lockInventoryRows(tx, { itemIds: [oldMov.itemId], pairs: [{ itemId: oldMov.itemId, warehouseId: oldMov.warehouseId }] });
  const item = locked.items.get(oldMov.itemId);
  if (!item) throw new BusinessError('Item stok tidak ditemukan.');
  // Both number series of the new row are locked before any account row (LOCK ORDER); the numbers
  // themselves are taken after the reversal, whose true-up row and journal may take the next ones.
  await generateDocumentNumber(tx, 'SM', movementDate, fiscalYear.id);
  await generateDocumentNumber(tx, 'JV', movementDate, fiscalYear.id);
  await lockTrueUpSeries(tx, fiscalYear.id);

  // The COGS settlement the row triggered first: it was posted on the book the row left.
  await reverseCogsSettlementsByTrigger(tx, 'StockMovement', oldMov.id);
  await reverseManualRow(tx, oldMov, 'inventory.movement.edit', userId);
  const movementNumber = await generateDocumentNumber(tx, 'SM', movementDate, fiscalYear.id);
  const entryNumber = await generateDocumentNumber(tx, 'JV', movementDate, fiscalYear.id);
  await voidMovementJournal(tx, oldMov.journalEntryId, userId);
  const newIsIn = isInbound(input.movementType);
  if (!newIsIn) {
    await assertStockAvailable(tx, [{ itemId: oldMov.itemId, warehouseId: oldMov.warehouseId, quantity: input.quantity }], {
      context: 'inventory.movement.edit', userId,
    });
  }
  const { posted } = await postManualRow(tx, {
    type: input.movementType, item, warehouseId: oldMov.warehouseId, quantity: input.quantity, unitCost: input.unitCost,
    offsetAccountId: input.offsetAccountId,
    // An inbound row consumes no batch.
    sourceMovementId: newIsIn ? null : oldMov.sourceMovementId,
    movementDate, fiscalYearId: fiscalYear.id, notes: input.notes, referenceNumber: input.referenceNumber,
    referenceType: oldMov.referenceType, edit: true, userId,
  }, { movementNumber, entryNumber });
  return withItem(tx, posted.movement.id);
}

/** Cancels a manual movement: stock and value back through the ledger, journal voided, COGS auto-settle reversed. */
export async function cancelManualMovementInTx(tx: Tx, id: string, userId: string): Promise<void> {
  const movement = await lockManualMovement(tx, id, 'cancel');
  // By date only, as on edit: the journal and auto-settle journals check their own year.
  const fiscalYear = await assertPeriodOpen(tx, { date: movement.date }, 'mutasi stok');
  // Item and warehouse, then the true-up's number series, before the settlement journals lock
  // accounts (LOCK ORDER of stockLocks.ts).
  await lockInventoryRows(tx, {
    itemIds: [movement.itemId],
    pairs: movement.warehouseId ? [{ itemId: movement.itemId, warehouseId: movement.warehouseId }] : [],
  });
  await lockTrueUpSeries(tx, fiscalYear.id);
  // The COGS settlement the row triggered first: it was posted on the book the row left.
  await reverseCogsSettlementsByTrigger(tx, 'StockMovement', id);
  await reverseManualRow(tx, movement, 'inventory.movement.cancel', userId);
  await voidMovementJournal(tx, movement.journalEntryId, userId);
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
  // Only the warehouse row moves: the item total, book value and average stay (no ledger row).
  await placeUnplacedStock(tx, { itemId: item.id, warehouseId: input.warehouseId, quantity });
}

/**
 * Drift repair `writeoff`: the goods that no warehouse holds are gone. An Adjustment − without a
 * warehouse takes `quantity` off the item total through the value ledger (valued from the book); its journal
 * debits the Inventory Variance account (a detail account of its own, varianceAccount.ts) and
 * credits the item's inventory account, dated `day` in an open period. An item without value posts
 * no journal. The row (referenceType STOCK_DRIFT_REFERENCE) cannot be edited or
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

  const expected = outboundValue(item.currentStock, item.stockValue, item.averageCost, quantity);
  const offsetAccountId = await resolveOffsetAccountId(tx, 'AdjustmentOut', null, expected);
  const movementNumber = await generateDocumentNumber(tx, 'SM', movementDate, fiscalYear.id);
  // No warehouse: the ledger takes the quantity off the item total alone, valued from the book.
  const { movement, valueDelta } = await postOutbound(tx, {
    movementType: 'AdjustmentOut', itemId: item.id, warehouseId: null, quantity, movementNumber,
    date: movementDate, fiscalYearId: fiscalYear.id, createdById: userId, notes: input.notes,
    referenceType: STOCK_DRIFT_REFERENCE, referenceId: null, referenceNumber: null, offsetAccountId,
  });
  const totalValue = valueDelta.negated();
  if (offsetAccountId && totalValue.gt(0)) {
    const journalEntryId = await postMovementJournal(tx, {
      type: 'AdjustmentOut', item, offsetAccountId, totalValue, quantity,
      date: movementDate, notes: input.notes, userId, fiscalYearId: fiscalYear.id,
    });
    await linkMovementJournal(tx, movement.id, journalEntryId);
  }
  return withItem(tx, movement.id);
}
