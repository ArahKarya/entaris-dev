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
  /** The main output price was typed, not back-filled. */
  priceIsManual?: boolean;
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
      priceIsManual: !o.isByProduct && (costing?.priceIsManual ?? false),
    };
  });
  return [...inputLines, ...outputLines];
}

/** The old main output lines an edit compares the incoming prices against. */
export interface OldOutputLine {
  itemId: string;
  lineType: string;
  isByProduct: boolean;
  unitPrice: number | null;
  priceIsManual: boolean;
}

/** Tolerance of the back-fill comparison: the stored price has 2 decimals, the HPP 4. */
export const BACKFILL_PRICE_TOLERANCE = 0.005;

/**
 * An edit form that was prefilled from the stored lines sends the back-filled HPP back as if it
 * were typed, which would freeze it. A main output price equal (within the tolerance) to the old
 * run's computed HPP, on a matching old line that was not typed, is dropped so the new HPP
 * refills it. Old and new lines match per item, then by order among that item's main outputs.
 * By-product lines and lines without a match are untouched.
 */
export function dropBackfilledOutputPrices<T extends { itemId: string; unitPrice?: number | null; isByProduct?: boolean }>(
  outputs: ReadonlyArray<T>,
  oldLines: ReadonlyArray<OldOutputLine>,
  oldComputedHpp: number | null,
): T[] {
  if (oldComputedHpp == null) return [...outputs];
  const oldByItem = new Map<string, OldOutputLine[]>();
  for (const l of oldLines) {
    if (l.lineType !== 'Output' || l.isByProduct) continue;
    oldByItem.set(l.itemId, [...(oldByItem.get(l.itemId) ?? []), l]);
  }
  const seen = new Map<string, number>();
  return outputs.map((o) => {
    if (o.isByProduct) return o;
    const nth = seen.get(o.itemId) ?? 0;
    seen.set(o.itemId, nth + 1);
    const old = oldByItem.get(o.itemId)?.[nth];
    if (!old || old.priceIsManual || o.unitPrice == null) return o;
    return Math.abs(o.unitPrice - oldComputedHpp) <= BACKFILL_PRICE_TOLERANCE ? { ...o, unitPrice: null } : o;
  });
}
