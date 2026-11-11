/**
 * Build the production_run_items rows persisted for a posted run (submit and
 * edit share it). Every line carries the production warehouse the run's
 * stock movements used, so the PDF "Gudang Produksi" and the edit prefill
 * can read it from the lines. Prices and yields come from computeProductionCosting.
 */

export interface RunLineBatchSnapshot {
  sourceMovementId: string | null;
  batchUnitCost: number | null;
}

export interface RunLineOutputCosting {
  /** Resolved price (typed or back-filled from the loaded HPP), null when unpriced. */
  persistedUnitPrice: number | null;
  yieldPct: number | null;
}

export interface BuildRunLinesArgs {
  runId: string;
  warehouseId: string;
  inputs: ReadonlyArray<{ itemId: string; quantity: number }>;
  outputs: ReadonlyArray<{ itemId: string; quantity: number; isByProduct?: boolean }>;
  /** Batch picked per input, same order as `inputs`. */
  batchSnapshots: ReadonlyArray<RunLineBatchSnapshot>;
  /** Costing per output, same order as `outputs`. */
  outputCosting: ReadonlyArray<RunLineOutputCosting>;
}

const NO_BATCH: RunLineBatchSnapshot = { sourceMovementId: null, batchUnitCost: null };

export function buildProductionRunLineItems(args: BuildRunLinesArgs) {
  const { runId, warehouseId } = args;
  const inputLines = args.inputs.map((inp, idx) => {
    const snapshot = args.batchSnapshots[idx] ?? NO_BATCH;
    return {
      productionRunId: runId,
      itemId: inp.itemId,
      warehouseId,
      lineType: 'Input',
      quantity: inp.quantity,
      unitPrice: null as number | null,
      yieldPct: null as number | null,
      isByProduct: false,
      sourceMovementId: snapshot.sourceMovementId,
      batchUnitCost: snapshot.batchUnitCost,
    };
  });
  const outputLines = args.outputs.map((o, idx) => {
    const costing = args.outputCosting[idx];
    return {
      productionRunId: runId,
      itemId: o.itemId,
      warehouseId,
      lineType: o.isByProduct ? 'ByProduct' : 'Output',
      quantity: o.quantity,
      unitPrice: costing?.persistedUnitPrice ?? null,
      yieldPct: costing?.yieldPct ?? null,
      isByProduct: o.isByProduct ?? false,
    };
  });
  return [...inputLines, ...outputLines];
}
