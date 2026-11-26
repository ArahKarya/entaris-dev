import type { DeliveryOrderItem, Prisma, StockMovement } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { businessYearMonth } from '../utils/businessDate';
import { assertPeriodOpen } from '../utils/periodGuard';
import { resolveWarehouseId } from '../utils/warehouseStock';
import { recomputeDeliveredQtyInTx, relinkDoItemsToSOInTx } from './salesOrderDelivery';
import { logger } from '../lib/logger';
import { STALE_STATUS } from '../utils/cancelClaim';
import { assertStockAvailable, lockInventoryRows, STOCK_INSUFFICIENT, type StockNeed } from './inventory/stockLocks';
import { postOutbound, reverseMovement, reviseOutbound, type ReverseResult, type RevisedOutbound } from './inventory/inventoryLedger';
import { postReversalValueJournals } from './inventory/reversalValueJournal';
import { planDeliveryOrderEdit, type DeliveryOrderEditPlan, type EditNewLine, type EditOldLine, type EditPairedLine } from './deliveryOrderEditPlan';
import { resolveCogsAccountId } from './cogsAccount';
import type { SubmitDeliveryOrderInput } from './deliveryOrderSubmit';

type Tx = Prisma.TransactionClient;

const formatQty = (d: Decimal) => d.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Error code: an edit may not move a delivery note to another business month. */
export const DELIVERY_ORDER_MONTH_CHANGE = 'DO_MONTH_CHANGE';

/** Old lines whose movement is an active Out on a warehouse, for planDeliveryOrderEdit. */
function oldStockLines(lines: readonly DeliveryOrderItem[], movements: readonly StockMovement[]): EditOldLine[] {
  const active = new Map(movements.map((m) => [m.id, m]));
  return lines.flatMap((l) => {
    const m = l.stockMovementId ? active.get(l.stockMovementId) : undefined;
    if (!m || !m.warehouseId || m.itemId !== l.inventoryItemId || (m.movementType !== 'Out' && m.movementType !== 'AdjustmentOut')) return [];
    return [{ movementId: m.id, itemId: m.itemId, warehouseId: m.warehouseId, quantity: m.quantity.toString() }];
  });
}

/** Stock the edit takes out beyond what kept rows hold: added lines whole, paired lines their extra. */
function extraNeeds(plan: DeliveryOrderEditPlan, lines: readonly EditNewLine[]): StockNeed[] {
  const added = lines.filter((l) => plan.added.includes(l.index))
    .map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, quantity: new Decimal(l.quantity) }));
  const extra = plan.paired.filter((p) => p.newQuantity.gt(p.oldQuantity)).map((p) => {
    const l = lines.find((n) => n.index === p.index)!;
    return { itemId: l.itemId, warehouseId: l.warehouseId, quantity: p.newQuantity.minus(p.oldQuantity) };
  });
  return [...added, ...extra];
}

/** Quantity of one (item, warehouse) the edited note keeps on rows already posted: its lines less the extra needed. */
function heldQuantity(lines: readonly EditNewLine[], needs: readonly StockNeed[], itemId: string, warehouseId: string | null): Decimal {
  const same = (l: { itemId: string; warehouseId: string | null }) => l.itemId === itemId && l.warehouseId === warehouseId;
  const total = lines.filter(same).reduce((s, l) => s.plus(l.quantity), new Decimal(0));
  return needs.filter(same).reduce((s, n) => s.minus(n.quantity), total);
}

/**
 * Edit a Submitted, not-yet-invoiced DO keeping the cost its goods went out at (E3-R8, owner
 * decision #9): old and new lines are paired per (item, warehouse) (planDeliveryOrderEdit). An
 * unchanged line keeps its movement (only the header changes), a lower quantity hands the
 * difference back at the row's own unit value, a higher one takes only the extra out at the book's
 * value now (inventoryLedger.reviseOutbound); a removed line is reversed at its own value and a new
 * line is posted at the book's value now. Goods handed back are trued up as a cancel of the note
 * trues them up (trueUp 'replay', sweepAtZero): what outbound rows since took differently comes back
 * against COGS in one journal per row, dated today (postReversalValueJournals). A higher quantity
 * after an inbound of the item is refused (OUTBOUND_INCREASE_AFTER_INBOUND): the extra goes on a new
 * line. doNumber is kept so printouts stay valid.
 */
export async function editDeliveryOrderInTx(
  tx: Tx,
  doId: string,
  body: SubmitDeliveryOrderInput,
  userId: string,
) {
  // Row lock before reading: an invoice submit that bills this note, or a cancel, holds the same
  // lock, so the status and invoice link read below are the committed ones and cannot change
  // before this edit commits.
  await tx.$queryRaw`SELECT id FROM delivery_orders WHERE id = ${doId} FOR UPDATE`;
  const oldDo = await tx.deliveryOrder.findUnique({
    where: { id: doId },
    include: { items: true },
  });
  if (!oldDo) throw new BusinessError('Surat jalan tidak ditemukan.');
  if (oldDo.status === 'Cancelled') {
    throw new BusinessError('Surat jalan sudah dibatalkan dan tidak bisa diedit.');
  }
  if (oldDo.invoiceId) {
    throw new BusinessError(
      'Surat jalan sudah masuk invoice. Batalkan dulu invoice terkait sebelum edit.',
    );
  }

  // The note has no journal; its date decides the period. The old date (not the stored fiscal year,
  // which older edits left stale) and the new one must both be open, and the note stays in its
  // month so the DO-YYYYMM number and the month's stock reports still match.
  const txDate = new Date(body.date);
  if (isNaN(txDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  await assertPeriodOpen(tx, { date: oldDo.date }, 'surat jalan');
  const fiscalYear = await assertPeriodOpen(tx, { date: txDate }, 'surat jalan');
  const oldMonth = businessYearMonth(oldDo.date);
  const newMonth = businessYearMonth(txDate);
  if (oldMonth.year !== newMonth.year || oldMonth.month !== newMonth.month) {
    throw new BusinessError(
      'Tanggal surat jalan tidak bisa dipindah ke bulan lain. Batalkan surat jalan ini lalu buat yang baru di bulan tujuan.',
      DELIVERY_ORDER_MONTH_CHANGE,
    );
  }

  const oldMovements = await tx.stockMovement.findMany({
    where: { referenceType: 'DeliveryOrder', referenceId: doId, isCancelled: false },
    orderBy: [{ createdAt: 'desc' }, { movementNumber: 'desc' }],
  });

  // Customer may change as long as the party is Customer/Both (same rule as submit).
  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Data customer tidak ditemukan.');
  if (!party.isActive) throw new BusinessError('Customer sudah tidak aktif.');
  if (party.partyType !== 'Customer' && party.partyType !== 'Both') {
    throw new BusinessError('Surat jalan hanya bisa untuk Customer.');
  }

  // One lock for the old and the new items (and their rows at both sets of warehouses), before
  // any stock write: the stock checked below cannot change before commit.
  const lineWarehouse = new Map<number, string>();
  for (const [i, it] of body.items.entries()) {
    if (!it.inventoryItemId) continue;
    const whId = await resolveWarehouseId(tx, it.warehouseId);
    if (!whId) throw new BusinessError(`Item '${it.itemName}' perlu pilih gudang sumber.`);
    lineWarehouse.set(i, whId);
  }
  const stockLines = body.items.flatMap((it, index) =>
    it.inventoryItemId ? [{ index, itemId: it.inventoryItemId, warehouseId: lineWarehouse.get(index)!, quantity: it.quantity }] : []);
  const locked = await lockInventoryRows(tx, {
    itemIds: [...oldMovements.map((m) => m.itemId), ...stockLines.map((l) => l.itemId)],
    pairs: [
      ...oldMovements.flatMap((m) => (m.warehouseId ? [{ itemId: m.itemId, warehouseId: m.warehouseId }] : [])),
      ...stockLines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId })),
    ],
  });
  for (const l of stockLines) {
    if (!locked.items.has(l.itemId)) throw new BusinessError('Item tidak ditemukan.');
  }

  const plan = planDeliveryOrderEdit(oldStockLines(oldDo.items, oldMovements), stockLines);
  const needs = extraNeeds(plan, stockLines);
  for (const need of needs) {
    const inv = locked.items.get(need.itemId)!;
    if (!inv.isActive) throw new BusinessError(`Item '${inv.name}' tidak aktif.`);
  }
  const notes = `Auto dari ${oldDo.doNumber} (edited)`;
  // Value true-ups of the goods handed back; their journals are posted after every SM number of the
  // edit is taken (LOCK ORDER of reversalValueJournal.ts).
  const settlements: (ReverseResult | RevisedOutbound)[] = [];
  const revise = async (p: EditPairedLine) => {
    const revised = await reviseOutbound(tx, p.movementId, {
      quantity: p.newQuantity, date: txDate, fiscalYearId: fiscalYear.id, userId, notes, trueUp: 'replay', sweepAtZero: true,
    });
    settlements.push(revised);
    return revised;
  };
  const movementByLine = new Map<number, string>();

  // Stock handed back first: old rows no line keeps go back at their own value (an Out reversal
  // puts stock back and needs no stock check), and lower quantities hand the difference back at
  // the row's own unit value.
  // A true-up row of an earlier edit (a Revaluation adjusting a row it took back) is that row's
  // settlement and stays.
  const kept = new Set(plan.paired.map((p) => p.movementId));
  for (const m of oldMovements.filter((row) => !kept.has(row.id) && !row.adjustsMovementId)) {
    settlements.push(await reverseMovement(tx, m.id, { userId, trueUp: 'replay', sweepAtZero: true, forEdit: true }));
  }
  for (const p of plan.paired.filter((row) => row.newQuantity.lt(row.oldQuantity))) {
    movementByLine.set(p.index, (await revise(p)).movement.id);
  }

  // Then the extra stock the edit takes out, per (item, warehouse) after what came back; the
  // message counts the quantity the kept rows already hold on both sides.
  await assertStockAvailable(tx, needs, {
    context: 'deliveryOrder.edit',
    userId,
    allowNegative: body.allowNegativeStock,
    reason: body.negativeStockReason,
    error: (s) => {
      const held = heldQuantity(stockLines, needs, s.itemId, s.warehouseId);
      return new BusinessError(
        `Stok '${s.itemName}' di gudang ${s.warehouseName} tidak cukup. Tersedia: ${formatQty(s.available.plus(held))} ${s.unit}, dibutuhkan: ${formatQty(s.needed.plus(held))} ${s.unit}.`,
        STOCK_INSUFFICIENT,
      );
    },
  });

  await tx.deliveryOrder.update({
    where: { id: doId },
    data: {
      date: txDate,
      fiscalYearId: fiscalYear.id,
      partyId: body.partyId,
      nomorMobil: body.nomorMobil ?? null,
      driverName: body.driverName ?? null,
      recipientName: body.recipientName ?? null,
      notes: body.notes ?? null,
    },
  });

  // Unchanged rows stay as they are unless the note moved to another day (the row then follows it,
  // keeping its value); higher quantities take only the extra out at the book's value now.
  const movementDate = new Map(oldMovements.map((m) => [m.id, m.date.getTime()]));
  for (const p of plan.paired.filter((row) => row.newQuantity.gte(row.oldQuantity))) {
    const unchanged = p.newQuantity.eq(p.oldQuantity) && movementDate.get(p.movementId) === txDate.getTime();
    movementByLine.set(p.index, unchanged ? p.movementId : (await revise(p)).movement.id);
  }

  // Counter account the invoice will post COGS against; stored on each Out movement that carries value.
  const cogsAccountId = await resolveCogsAccountId(tx);
  for (const index of plan.added) {
    const line = stockLines.find((l) => l.index === index)!;
    const { movement } = await postOutbound(tx, {
      movementType: 'Out',
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      quantity: line.quantity,
      date: txDate,
      fiscalYearId: fiscalYear.id,
      createdById: userId,
      notes,
      referenceType: 'DeliveryOrder',
      referenceId: doId,
      referenceNumber: oldDo.doNumber,
      offsetAccountId: cogsAccountId,
    });
    movementByLine.set(index, movement.id);
  }
  await postReversalValueJournals(tx, settlements.map((r) => ({ movement: 'previous' in r ? r.previous : r.movement, sweep: r.sweep })), {
    userId, documentLabel: `Surat Jalan ${oldDo.doNumber} (edit)`,
  });

  // Header is reused (preserves doNumber); the lines are written again in body order.
  await tx.deliveryOrderItem.deleteMany({ where: { deliveryOrderId: doId } });
  for (const [i, it] of body.items.entries()) {
    await tx.deliveryOrderItem.create({
      data: {
        deliveryOrderId: doId,
        inventoryItemId: it.inventoryItemId ?? null,
        warehouseId: it.inventoryItemId ? lineWarehouse.get(i)! : it.warehouseId ?? null,
        itemName: it.itemName,
        quantity: it.quantity,
        unit: it.unit,
        description: it.description ?? null,
        stockMovementId: movementByLine.get(i) ?? null,
      },
    });
  }

  // Recreated lines lose their SO link: restore it and re-derive SO delivered_qty + status.
  if (oldDo.salesOrderId) {
    await relinkDoItemsToSOInTx(tx, doId);
    await recomputeDeliveredQtyInTx(tx, oldDo.salesOrderId);
  }

  logger.info(
    { doId, doNumber: oldDo.doNumber, items: body.items.length, partyId: body.partyId },
    'Delivery order edited',
  );

  return tx.deliveryOrder.findUniqueOrThrow({
    where: { id: doId },
    include: { items: true, customer: true },
  });
}

/** Header fields a PATCH changes; a field left out keeps its value. */
export interface DeliveryOrderHeaderPatch {
  nomorMobil?: string | null;
  driverName?: string | null;
  recipientName?: string | null;
  notes?: string | null;
}

/**
 * Edit the header of a Submitted note (PATCH): driver, vehicle, recipient and notes only, so stock,
 * movements and their cost stay as they are (owner decision #9). The note's period must be open, and
 * the write is claimed on status Submitted: a note cancelled or billed meanwhile is refused
 * (STALE_STATUS) instead of being edited. Returns null for a missing note.
 */
export async function editDeliveryOrderHeaderInTx(tx: Tx, doId: string, patch: DeliveryOrderHeaderPatch) {
  const existing = await tx.deliveryOrder.findUnique({ where: { id: doId }, select: { status: true, date: true } });
  if (!existing) return null;
  if (existing.status !== 'Submitted') {
    throw new BusinessError('Hanya surat jalan berstatus Submitted yang bisa diedit.');
  }
  await assertPeriodOpen(tx, { date: existing.date }, 'surat jalan');
  // A field left undefined is not written.
  const { count } = await tx.deliveryOrder.updateMany({
    where: { id: doId, status: 'Submitted' },
    data: { nomorMobil: patch.nomorMobil, driverName: patch.driverName, recipientName: patch.recipientName, notes: patch.notes },
  });
  if (count !== 1) {
    throw new BusinessError('Status surat jalan sudah berubah. Muat ulang halaman lalu coba lagi.', STALE_STATUS);
  }
  return tx.deliveryOrder.findUniqueOrThrow({ where: { id: doId } });
}
