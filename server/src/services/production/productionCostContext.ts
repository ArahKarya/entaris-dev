import type { InventoryItem, Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { assertBatchSource } from '../inventory/batchSource';
import { assertBatchQuantities, type BatchNeed } from '../inventory/batchAvailability';
import { assertStockAvailable, STOCK_INSUFFICIENT } from '../inventory/stockLocks';

type Tx = Prisma.TransactionClient;

/**
 * Read-only loader for production costing (E6-R1): the run's items with their validation, the
 * input stock check at the production warehouse and the picked batches through assertBatchSource.
 * It decides no cost: each input is valued by the ledger row that takes it out (postOutbound in
 * productionPosting.ts, E3-R6), and a picked batch is traceability only (E6-R3): its remaining
 * quantity and warehouse are checked (batchAvailability.ts), its cost is not used. Submit and edit
 * call it once, under lockProductionStockInTx and at the point where the stock they check is current
 * (edit: after its old movements are reversed).
 */

export interface ContextInputLine {
  itemId: string;
  quantity: number;
  sourceMovementId?: string | null;
  /** Sent by old drafts and forms; ignored (E6-R3). */
  batchUnitCost?: number | null;
}

export interface ContextOutputLine {
  itemId: string;
  quantity: number;
  unitPrice?: number | null;
  isByProduct?: boolean;
}

export interface ProductionCostContextInput {
  inputs: ReadonlyArray<ContextInputLine>;
  outputs: ReadonlyArray<ContextOutputLine>;
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
}

export interface CostedInput {
  /** The picked batch, null without one. */
  sourceMovementId: string | null;
}

/** Where the inputs are taken from, and who takes them (for the bypass log). */
export interface ProductionStockScope {
  warehouseId: string;
  /** Log context of the stock check, e.g. 'productionRun.submit'. */
  context: string;
  userId?: string;
  /** Batches the edited run already took from: kept even outside the production warehouse (old runs). */
  keepBatchIds?: ReadonlySet<string>;
}

export interface ProductionCostContext {
  itemMap: Map<string, InventoryItem>;
  /** One entry per input line, same order. */
  inputs: CostedInput[];
}

const qtyText = (n: { toNumber(): number }) => n.toNumber().toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Inputs must exist and be active; outputs must exist, be active and carry a valid price. */
function validateItems(body: ProductionCostContextInput, itemMap: Map<string, InventoryItem>): void {
  for (const input of body.inputs) {
    const item = itemMap.get(input.itemId);
    if (!item) throw new BusinessError('Item input tidak ditemukan.');
    if (!item.isActive) throw new BusinessError(`Item '${item.name}' tidak aktif.`);
  }
  for (const output of body.outputs) {
    const item = itemMap.get(output.itemId);
    if (!item) throw new BusinessError('Item output tidak ditemukan.');
    if (!item.isActive) throw new BusinessError(`Item output '${item.name}' tidak aktif.`);
    // A main output price may be empty or 0 (back-filled from the loaded HPP); only by-products
    // need an explicit NRV, and no price may be negative.
    if (output.isByProduct && (output.unitPrice == null || output.unitPrice < 0)) {
      throw new BusinessError(`NRV '${item.name}' wajib diisi (minimal 0).`);
    }
    if (!output.isByProduct && output.unitPrice != null && output.unitPrice < 0) {
      throw new BusinessError(`Harga/HPP '${item.name}' tidak boleh negatif.`);
    }
  }
}

/**
 * The inputs, lines of one item summed, must be in stock at the production warehouse (E6-R4): stock
 * held in another warehouse does not count. allowNegativeStock (the caller passed the
 * negative-stock gate) logs the shortage instead.
 */
async function assertInputStock(tx: Tx, body: ProductionCostContextInput, stock: ProductionStockScope): Promise<void> {
  await assertStockAvailable(
    tx,
    body.inputs.map((input) => ({ itemId: input.itemId, warehouseId: stock.warehouseId, quantity: input.quantity })),
    {
      context: stock.context,
      userId: stock.userId,
      allowNegative: body.allowNegativeStock,
      reason: body.negativeStockReason,
      error: (s) => new BusinessError(
        `Stok '${s.itemName}' di gudang ${s.warehouseName} tidak cukup. Tersedia: ${qtyText(s.available)} ${s.unit}, dibutuhkan: ${qtyText(s.needed)} ${s.unit}. Buat penerimaan/transfer dulu.`,
        STOCK_INSUFFICIENT,
      ),
    },
  );
}

/**
 * Batch link per input. The batch must be an active inbound movement of the same item
 * (assertBatchSource), sit in the production warehouse and still hold what the run's lines on it
 * ask for (assertBatchQuantities). The client's batchUnitCost is ignored: the batch never values
 * the input.
 */
async function batchInputs(
  tx: Tx,
  inputs: ReadonlyArray<ContextInputLine>,
  itemMap: Map<string, InventoryItem>,
  stock: ProductionStockScope,
): Promise<CostedInput[]> {
  const out: CostedInput[] = [];
  const needs: BatchNeed[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const item = itemMap.get(input.itemId)!;
    if (!input.sourceMovementId) {
      out.push({ sourceMovementId: null });
      continue;
    }
    const batch = await assertBatchSource(tx, {
      sourceMovementId: input.sourceMovementId,
      inventoryItemId: input.itemId,
      itemName: item.name,
      inputLine: i + 1,
    });
    out.push({ sourceMovementId: batch.id });
    needs.push({ inputLine: i + 1, sourceMovementId: batch.id, quantity: input.quantity });
  }
  await assertBatchQuantities(tx, needs, { warehouseId: stock.warehouseId, keepBatchIds: stock.keepBatchIds });
  return out;
}

/**
 * Loads and validates the run's items, checks the input stock at the production warehouse, then
 * resolves each input's batch. Call it under lockProductionStockInTx.
 */
export async function loadProductionCostContext(
  tx: Tx,
  body: ProductionCostContextInput,
  stock: ProductionStockScope,
): Promise<ProductionCostContext> {
  const allItemIds = [...body.inputs.map((i) => i.itemId), ...body.outputs.map((o) => o.itemId)];
  const allItems = await tx.inventoryItem.findMany({ where: { id: { in: allItemIds } } });
  const itemMap = new Map(allItems.map((i) => [i.id, i]));
  validateItems(body, itemMap);
  await assertInputStock(tx, body, stock);
  return { itemMap, inputs: await batchInputs(tx, body.inputs, itemMap, stock) };
}
