import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { resolveWarehouseId } from '../utils/warehouseStock';
import { logger } from '../lib/logger';
import { assertStockAvailable, lockInventoryRows, STOCK_INSUFFICIENT } from './inventory/stockLocks';
import { postOutbound } from './inventory/inventoryLedger';
import { linkTemporaryNotesToDoInTx } from './temporaryDeliveryNote';
import { resolveCogsAccountId } from './cogsAccount';

type Tx = Prisma.TransactionClient;

const formatQty = (d: Decimal) => d.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

export interface SubmitDeliveryOrderInput {
  date: string;
  partyId: string;
  nomorMobil?: string | null;
  driverName?: string | null;
  recipientName?: string | null;
  notes?: string | null;
  items: Array<{
    inventoryItemId?: string | null;
    warehouseId?: string | null;
    itemName: string;
    quantity: number;
    unit: string;
    description?: string | null;
  }>;
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
  temporaryNoteIds?: string[];
}

/**
 * Submit a delivery order. Each inventory line is an Out of the value ledger (postOutbound), valued
 * from the book at delivery time; the later sales invoice posts exactly that value as COGS. No GL
 * impact here (the invoice posts it). Caller owns the transaction.
 */
export async function submitDeliveryOrderInTx(
  tx: Tx,
  body: SubmitDeliveryOrderInput,
  userId: string,
) {
  const parsedDate = new Date(body.date);
  if (isNaN(parsedDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');

  const fiscalYear = await getOpenFiscalYear(tx, parsedDate);

  const party = await tx.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new BusinessError('Customer tidak ditemukan.');
  if (!party.isActive) throw new BusinessError(`Customer '${party.name}' tidak aktif.`);
  if (party.partyType !== 'Customer' && party.partyType !== 'Both') {
    throw new BusinessError(`Party '${party.name}' bukan customer.`);
  }

  const doNumber = await generateDocumentNumber(tx, 'DO', parsedDate, fiscalYear.id);

  // Resolve each inventory line's warehouse once (the default one when the line has none), lock
  // the items and their rows at those warehouses, then check the lines summed per (item,
  // warehouse) against the locked stock: a concurrent outbound of the same stock waits for this
  // note instead of passing the same check.
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
    itemIds: stockLines.map((l) => l.itemId),
    pairs: stockLines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId })),
  });
  for (const l of stockLines) {
    const inv = locked.items.get(l.itemId);
    if (!inv) throw new BusinessError('Item tidak ditemukan.');
    if (!inv.isActive) throw new BusinessError(`Item '${inv.name}' tidak aktif.`);
  }
  await assertStockAvailable(tx, stockLines, {
    context: 'deliveryOrder.submit',
    userId,
    allowNegative: body.allowNegativeStock,
    reason: body.negativeStockReason,
    error: (s) => new BusinessError(
      `Stok '${s.itemName}' di gudang ${s.warehouseName} tidak cukup. Tersedia: ${formatQty(s.available)} ${s.unit}, dibutuhkan: ${formatQty(s.needed)} ${s.unit}. Buat produksi/transfer/penerimaan dulu.`,
      STOCK_INSUFFICIENT,
    ),
  });

  // Counter account the invoice will post COGS against; stored on each Out movement that carries value.
  const cogsAccountId = await resolveCogsAccountId(tx);

  const deliveryOrder = await tx.deliveryOrder.create({
    data: {
      doNumber,
      date: parsedDate,
      partyId: body.partyId,
      status: 'Submitted',
      notes: body.notes || null,
      nomorMobil: body.nomorMobil || null,
      driverName: body.driverName || null,
      recipientName: body.recipientName || null,
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: new Date(),
    },
  });

  // Per line: an Out through the ledger, then the DO item row linked to it.
  for (const [i, it] of body.items.entries()) {
    let stockMovementId: string | null = null;

    if (it.inventoryItemId) {
      const inventoryItem = locked.items.get(it.inventoryItemId)!;
      const warehouseId = lineWarehouse.get(i)!;
      const qty = it.quantity;

      const { movement } = await postOutbound(tx, {
        movementType: 'Out',
        itemId: inventoryItem.id,
        warehouseId,
        quantity: qty,
        date: parsedDate,
        fiscalYearId: fiscalYear.id,
        createdById: userId,
        notes: `Auto dari ${doNumber}`,
        referenceType: 'DeliveryOrder',
        referenceId: deliveryOrder.id,
        referenceNumber: doNumber,
        offsetAccountId: cogsAccountId,
      });
      stockMovementId = movement.id;

      await tx.deliveryOrderItem.create({
        data: {
          deliveryOrderId: deliveryOrder.id,
          inventoryItemId: inventoryItem.id,
          warehouseId,
          itemName: it.itemName,
          quantity: qty,
          unit: it.unit,
          description: it.description || null,
          stockMovementId,
        },
      });
    } else {
      await tx.deliveryOrderItem.create({
        data: {
          deliveryOrderId: deliveryOrder.id,
          inventoryItemId: null,
          warehouseId: it.warehouseId || null,
          itemName: it.itemName,
          quantity: it.quantity,
          unit: it.unit,
          description: it.description || null,
          stockMovementId: null,
        },
      });
    }
  }

  // Tautkan Surat Jalan Sementara (Open, pelanggan sama) ke DO ini — satu transaksi dengan pembuatan DO.
  if (body.temporaryNoteIds && body.temporaryNoteIds.length > 0) {
    await linkTemporaryNotesToDoInTx(tx, deliveryOrder.id, body.partyId, body.temporaryNoteIds);
  }

  logger.info({ doNumber, items: body.items.length, partyId: body.partyId }, 'Delivery order submitted');

  return tx.deliveryOrder.findUniqueOrThrow({
    where: { id: deliveryOrder.id },
    include: { items: true, customer: true },
  });
}
