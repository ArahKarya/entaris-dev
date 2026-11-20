import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { businessYearMonth } from '../utils/businessDate';
import { assertPeriodOpen } from '../utils/periodGuard';
import { adjustWarehouseStock, resolveWarehouseId } from '../utils/warehouseStock';
import { recomputeDeliveredQtyInTx, relinkDoItemsToSOInTx } from './salesOrderDelivery';
import { logger } from '../lib/logger';
import { assertStockAvailable, lockInventoryRows, STOCK_INSUFFICIENT } from './inventory/stockLocks';
import { resolveCogsAccountId } from './cogsAccount';
import type { SubmitDeliveryOrderInput } from './deliveryOrderSubmit';

type Tx = Prisma.TransactionClient;

const formatQty = (d: Decimal) => d.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Error code: an edit may not move a delivery note to another business month. */
export const DELIVERY_ORDER_MONTH_CHANGE = 'DO_MONTH_CHANGE';

/**
 * Edit a Submitted, not-yet-invoiced DO: reverse its movements, then re-apply the new lines with
 * unitCost locked at the averageCost at edit time. doNumber is kept so printouts stay valid.
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
  });

  // Customer may change as long as the party is Customer/Both (same rule as submit).
  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Data customer tidak ditemukan.');
  if (!party.isActive) throw new BusinessError('Customer sudah tidak aktif.');
  if (party.partyType !== 'Customer' && party.partyType !== 'Both') {
    throw new BusinessError('Surat jalan hanya bisa untuk Customer.');
  }

  // One lock for the old and the new items (and their rows at both sets of warehouses), before
  // the reversal: the stock checked below after the reversal cannot change before commit.
  const lineWarehouse = new Map<number, string>();
  for (const [i, it] of body.items.entries()) {
    if (!it.inventoryItemId) continue;
    const whId = await resolveWarehouseId(tx, it.warehouseId);
    if (!whId) throw new BusinessError(`Item '${it.itemName}' perlu pilih gudang sumber.`);
    lineWarehouse.set(i, whId);
  }
  const stockLines = body.items.flatMap((it, i) =>
    it.inventoryItemId ? [{ itemId: it.inventoryItemId, warehouseId: lineWarehouse.get(i)!, quantity: it.quantity }] : []);
  const locked = await lockInventoryRows(tx, {
    itemIds: [...oldMovements.map((m) => m.itemId), ...stockLines.map((l) => l.itemId)],
    pairs: [
      ...oldMovements.flatMap((m) => (m.warehouseId ? [{ itemId: m.itemId, warehouseId: m.warehouseId }] : [])),
      ...stockLines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId })),
    ],
  });
  for (const l of stockLines) {
    const inv = locked.items.get(l.itemId);
    if (!inv) throw new BusinessError('Item tidak ditemukan.');
    if (!inv.isActive) throw new BusinessError(`Item '${inv.name}' tidak aktif.`);
  }

  for (const mov of oldMovements) {
    const qty = Number(mov.quantity);
    await tx.inventoryItem.update({
      where: { id: mov.itemId },
      data: { currentStock: { increment: qty } },
    });
    await adjustWarehouseStock(tx, mov.itemId, mov.warehouseId, qty);
    await tx.stockMovement.update({
      where: { id: mov.id },
      data: { isCancelled: true },
    });
  }

  // Header is reused (preserves doNumber).
  await tx.deliveryOrderItem.deleteMany({ where: { deliveryOrderId: doId } });

  // Post-reversal stock per (item, warehouse), lines of one item summed; currentStock is a
  // cross-warehouse total and must not gate a per-warehouse shipment.
  await assertStockAvailable(tx, stockLines, {
    context: 'deliveryOrder.edit',
    userId,
    allowNegative: body.allowNegativeStock,
    reason: body.negativeStockReason,
    error: (s) => new BusinessError(
      `Stok '${s.itemName}' di gudang ${s.warehouseName} tidak cukup. Tersedia: ${formatQty(s.available)} ${s.unit}, dibutuhkan: ${formatQty(s.needed)} ${s.unit}.`,
      STOCK_INSUFFICIENT,
    ),
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

  // Counter account the invoice will post COGS against; stored on each Out movement.
  const cogsAccountId = await resolveCogsAccountId(tx);

  for (const [i, it] of body.items.entries()) {
    let stockMovementId: string | null = null;
    if (it.inventoryItemId) {
      const inventoryItem = locked.items.get(it.inventoryItemId)!;
      const warehouseId = lineWarehouse.get(i)!;

      const qty = Number(it.quantity);
      // Reversing the old Outs and posting new ones leaves the average unchanged: the locked value holds.
      const unitCost = inventoryItem.averageCost.toNumber();
      const totalValue = new Decimal(qty).times(new Decimal(unitCost)).toDecimalPlaces(2).toNumber();

      await tx.inventoryItem.update({
        where: { id: inventoryItem.id },
        data: { currentStock: { decrement: qty } },
      });
      await adjustWarehouseStock(tx, inventoryItem.id, warehouseId, -qty);

      const movementNumber = await generateDocumentNumber(tx, 'SM', txDate, fiscalYear.id);
      const movement = await tx.stockMovement.create({
        data: {
          movementNumber,
          date: txDate,
          itemId: inventoryItem.id,
          warehouseId,
          movementType: 'Out',
          quantity: qty,
          unitCost,
          totalValue,
          notes: `Auto dari ${oldDo.doNumber} (edited)`,
          referenceType: 'DeliveryOrder',
          referenceId: doId,
          referenceNumber: oldDo.doNumber,
          offsetAccountId: totalValue > 0 ? cogsAccountId : null,
          fiscalYearId: fiscalYear.id,
          createdById: userId,
        },
      });
      stockMovementId = movement.id;

      await tx.deliveryOrderItem.create({
        data: {
          deliveryOrderId: doId,
          inventoryItemId: inventoryItem.id,
          warehouseId,
          itemName: it.itemName,
          quantity: qty,
          unit: it.unit,
          description: it.description ?? null,
          stockMovementId,
        },
      });
    } else {
      // Non-inventory line: no movement, just persist the row.
      await tx.deliveryOrderItem.create({
        data: {
          deliveryOrderId: doId,
          inventoryItemId: null,
          warehouseId: it.warehouseId ?? null,
          itemName: it.itemName,
          quantity: it.quantity,
          unit: it.unit,
          description: it.description ?? null,
          stockMovementId: null,
        },
      });
    }
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
