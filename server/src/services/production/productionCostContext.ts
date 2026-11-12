import type { InventoryItem, Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import { assertBatchSource } from '../inventory/batchSource';

type Tx = Prisma.TransactionClient;

/**
 * Read-only loader for production costing (E6-R1): the run's items with their validation, the
 * picked batches through assertBatchSource, and the unit cost each input is consumed at. Submit
 * and edit call it once, at the point where the stock and WAC they cost against are current
 * (edit: after its old movements are reversed). The row-lock hook (E3-PR2) lands here.
 */

export interface ContextInputLine {
  itemId: string;
  quantity: number;
  sourceMovementId?: string | null;
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
  /** Unit cost snapshot of the picked batch, null without one. */
  batchUnitCost: number | null;
  /** Unit cost the input is consumed at: the batch snapshot, else WAC (0 when not positive). */
  unitCost: number;
}

export interface ProductionCostContext {
  itemMap: Map<string, InventoryItem>;
  /** One entry per input line, same order. */
  inputs: CostedInput[];
}

const qtyText = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 3 });

/** Inputs must exist, be active and (unless bypassed) be in stock in total; outputs must exist and be active. */
function validateItems(body: ProductionCostContextInput, itemMap: Map<string, InventoryItem>, bypassLog: string): void {
  for (const input of body.inputs) {
    const item = itemMap.get(input.itemId);
    if (!item) throw new BusinessError('Item input tidak ditemukan.');
    if (!item.isActive) throw new BusinessError(`Item '${item.name}' tidak aktif.`);
    if (Number(item.currentStock) < input.quantity) {
      if (!body.allowNegativeStock) {
        throw new BusinessError(
          `Stok '${item.name}' tidak cukup. Tersedia: ${qtyText(Number(item.currentStock))} ${item.unit}, dibutuhkan: ${qtyText(input.quantity)} ${item.unit}. Buat penerimaan/transfer dulu.`,
        );
      }
      logger.warn(
        {
          itemId: item.id,
          itemName: item.name,
          currentStock: Number(item.currentStock),
          requested: input.quantity,
          reason: body.negativeStockReason,
        },
        bypassLog,
      );
    }
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
 * Batch snapshot + unit cost per input. The batch must be an active inbound movement of the
 * same item; its cost is the client's `batchUnitCost` (>= 0) captured at pick time, else the
 * batch's stored unit cost. Per-batch remaining qty is not enforced yet (E6-PR3).
 */
async function costInputs(tx: Tx, inputs: ReadonlyArray<ContextInputLine>, itemMap: Map<string, InventoryItem>): Promise<CostedInput[]> {
  const out: CostedInput[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const item = itemMap.get(input.itemId)!;
    let sourceMovementId: string | null = null;
    let batchUnitCost: number | null = null;
    if (input.sourceMovementId) {
      const batch = await assertBatchSource(tx, {
        sourceMovementId: input.sourceMovementId,
        inventoryItemId: input.itemId,
        itemName: item.name,
        inputLine: i + 1,
      });
      sourceMovementId = batch.id;
      batchUnitCost = input.batchUnitCost != null && input.batchUnitCost >= 0
        ? Number(input.batchUnitCost)
        : Number(batch.unitCost);
    }
    const wac = Number(item.averageCost);
    out.push({ sourceMovementId, batchUnitCost, unitCost: batchUnitCost ?? (wac > 0 ? wac : 0) });
  }
  return out;
}

/**
 * Loads and validates the run's items, then resolves each input's batch and unit cost.
 * `bypassLog` is the log message for an input taken past its stock under the negative-stock bypass.
 */
export async function loadProductionCostContext(
  tx: Tx,
  body: ProductionCostContextInput,
  opts: { bypassLog: string },
): Promise<ProductionCostContext> {
  const allItemIds = [...body.inputs.map((i) => i.itemId), ...body.outputs.map((o) => o.itemId)];
  const allItems = await tx.inventoryItem.findMany({ where: { id: { in: allItemIds } } });
  const itemMap = new Map(allItems.map((i) => [i.id, i]));
  validateItems(body, itemMap, opts.bypassLog);
  return { itemMap, inputs: await costInputs(tx, body.inputs, itemMap) };
}
