import Decimal from 'decimal.js';
import { splitProductionDiff } from '../ledger/systemRoleAccounts';
import { UNIT_COST_DP } from '../inventory/inventoryValueMath';

/**
 * Production costing (E6-R1): the one home of the run's cost arithmetic. Pure, no database:
 * the caller takes the inputs out through the value ledger first (productionPosting.ts), passes the
 * value each one actually took out of the book, and posts the outputs and the journal from what this
 * returns. Submit and edit share it, so the back-fill rule for main output prices, the loaded HPP and
 * the journal plan exist only here.
 */

export interface CostingInputLine {
  quantity: number;
  /**
   * The value the input took out of stock: −valueDelta of its postOutbound row (E3-R6). Never a
   * preview at average x quantity, nor the picked batch's cost (E6-R3).
   */
  value: Decimal.Value;
}

export interface CostingOutputLine {
  quantity: number;
  unitPrice?: number | null;
  isByProduct?: boolean;
}

export interface CostingCostLine {
  standardId?: string | null;
  description: string;
  costSide: 'InputSide' | 'OutputSide';
  basis: 'InputQty' | 'OutputQty' | 'Fixed';
  rate: number;
  costAccountId?: string | null;
}

export interface ProductionCostingInput {
  inputs: ReadonlyArray<CostingInputLine>;
  outputs: ReadonlyArray<CostingOutputLine>;
  costs?: ReadonlyArray<CostingCostLine>;
  hppOverride?: number | null;
}

export interface ResolvedCostLine extends CostingCostLine {
  qtyBasis: Decimal;
  /** rate x qtyBasis, 4 dp. */
  totalAmount: Decimal;
}

export interface CostedInputLine {
  /** value / quantity, UNIT_COST_DP (the unit cost of the ledger row). */
  unitCost: number;
  /** The consumed value, 2 dp. */
  totalValue: number;
}

export interface CostedOutputLine {
  /** Unit cost the output enters stock at: by-product NRV, typed main price > 0, else the loaded HPP. */
  unitCost: number;
  /** quantity x unitCost, 2 dp. */
  totalValue: number;
  /** Loaded HPP for main outputs (null without one), the NRV for by-products. */
  unitCostLoaded: number | null;
  /** production_run_items.unit_price: the resolved price, null when nothing priced the line. */
  persistedUnitPrice: number | null;
  /** Main output: the price was typed (> 0), not back-filled with the loaded HPP. Always false for by-products. */
  priceIsManual: boolean;
  /** Main output qty over total input qty, in percent; null for by-products. */
  yieldPct: number | null;
}

export interface JournalPlanLine {
  /** Index of the line in the input or output array. */
  index: number;
  /** Amount in rupiah (2 dp, > 0); zero-value lines are left out. */
  amount: number;
}

export interface ProductionJournalPlan {
  /** Σ output debits − Σ input credits (2 dp); its sign picks the accounts that must be mapped. */
  diff: number;
  /** CR per input, at its consumed value. */
  inputCredits: JournalPlanLine[];
  /** DR per output, at its received value. */
  outputDebits: JournalPlanLine[];
  /** CR PRODUCTION_CONVERSION: a positive difference up to the conversion cost total. */
  toConversion: number;
  /** CR COGS: the rest of a positive difference. */
  toCogs: number;
  /** DR COGS: a negative difference (production loss). */
  loss: number;
}

export interface ProductionCosting {
  inputLines: CostedInputLine[];
  outputLines: CostedOutputLine[];
  resolvedCosts: ResolvedCostLine[];
  totalInputQty: number;
  totalMainOutputQty: number;
  byProductQty: number;
  /** Main output qty over total input qty, in percent; null without input qty. */
  yieldPct: number | null;
  totalMaterialCost: Decimal;
  totalCostInputSide: Decimal;
  totalCostOutputSide: Decimal;
  totalByproductValue: Decimal;
  /** Loaded HPP per unit of main output (UNIT_COST_DP); null when not overridden and no main output qty. */
  computedHpp: Decimal | null;
  hppOverridden: boolean;
  /** By-product NRV exceeded the total cost, so the HPP was clamped to 0 (the caller logs it). */
  clampedNegativeNumerator: boolean;
  journalPlan: ProductionJournalPlan;
}

const ZERO = new Decimal(0);

function lineValue(quantity: number, unitCost: number): number {
  return new Decimal(quantity).mul(new Decimal(unitCost)).toDecimalPlaces(2).toNumber();
}

function costInput(i: CostingInputLine): CostedInputLine {
  const value = new Decimal(i.value).toDecimalPlaces(2);
  const quantity = new Decimal(i.quantity);
  return {
    unitCost: quantity.gt(0) ? value.div(quantity).toDecimalPlaces(UNIT_COST_DP).toNumber() : 0,
    totalValue: value.toNumber(),
  };
}

function sum(values: ReadonlyArray<Decimal>): Decimal {
  return values.reduce((s, v) => s.plus(v), ZERO);
}

function resolveCosts(costs: ReadonlyArray<CostingCostLine>, inputQty: Decimal, mainOutputQty: Decimal): ResolvedCostLine[] {
  return costs.map((c) => {
    let qtyBasis: Decimal;
    if (c.basis === 'InputQty') qtyBasis = inputQty;
    else if (c.basis === 'OutputQty') qtyBasis = mainOutputQty;
    else qtyBasis = new Decimal(1); // Fixed: rate IS the total
    return { ...c, qtyBasis, totalAmount: new Decimal(c.rate).mul(qtyBasis).toDecimalPlaces(4) };
  });
}

interface LoadedHpp {
  computedHpp: Decimal | null;
  hppOverridden: boolean;
  clampedNegativeNumerator: boolean;
}

/**
 * Loaded HPP per unit of main output: an override (>= 0) verbatim, else (material + costs −
 * by-product NRV) / main qty. A negative numerator (NRV above total cost) would give a negative
 * HPP and corrupt the main output's WAC and GL, so it is clamped to 0 and flagged.
 */
function loadedHpp(hppOverride: number | null | undefined, numerator: Decimal, mainOutputQty: Decimal): LoadedHpp {
  if (hppOverride != null && hppOverride >= 0) {
    return { computedHpp: new Decimal(hppOverride), hppOverridden: true, clampedNegativeNumerator: false };
  }
  if (!mainOutputQty.gt(0)) return { computedHpp: null, hppOverridden: false, clampedNegativeNumerator: false };
  if (numerator.lt(0)) return { computedHpp: ZERO, hppOverridden: false, clampedNegativeNumerator: true };
  return { computedHpp: numerator.div(mainOutputQty).toDecimalPlaces(UNIT_COST_DP), hppOverridden: false, clampedNegativeNumerator: false };
}

function costOutput(o: CostingOutputLine, computedHpp: Decimal | null, totalInputQty: number): CostedOutputLine {
  const hppNum = computedHpp ? computedHpp.toNumber() : 0;
  const explicitPrice = o.unitPrice;
  if (o.isByProduct) {
    const unitCost = explicitPrice ?? 0;
    return {
      unitCost,
      totalValue: lineValue(o.quantity, unitCost),
      unitCostLoaded: unitCost,
      persistedUnitPrice: explicitPrice ?? null,
      priceIsManual: false,
      yieldPct: null,
    };
  }
  // Main outputs without a typed price (> 0) are back-filled with the loaded HPP, so WAC and
  // the journal stay balanced. The persisted price stays null when the HPP is 0 or unknown.
  const typed = explicitPrice != null && explicitPrice > 0;
  const unitCost = typed ? explicitPrice : hppNum;
  return {
    unitCost,
    totalValue: lineValue(o.quantity, unitCost),
    unitCostLoaded: computedHpp ? hppNum : null,
    persistedUnitPrice: typed ? explicitPrice : (hppNum > 0 ? hppNum : null),
    priceIsManual: typed,
    yieldPct: totalInputQty > 0 ? (o.quantity / totalInputQty) * 100 : null,
  };
}

/**
 * Journal plan: CR each input and DR each output at its value (zero-value lines left out); the
 * output-minus-input difference goes up to the conversion cost total to CR PRODUCTION_CONVERSION
 * (PSAK 14), the rest to CR COGS, and a production loss to DR COGS.
 */
function journalPlanOf(inputLines: CostedInputLine[], outputLines: CostedOutputLine[], conversionTotal: Decimal): ProductionJournalPlan {
  const positive = (lines: ReadonlyArray<{ totalValue: number }>): JournalPlanLine[] =>
    lines.flatMap((l, index) => (l.totalValue > 0 ? [{ index, amount: l.totalValue }] : []));
  const inputCredits = positive(inputLines);
  const outputDebits = positive(outputLines);
  const totalIn = sum(inputCredits.map((l) => new Decimal(l.amount)));
  const totalOut = sum(outputDebits.map((l) => new Decimal(l.amount)));
  const diff = totalOut.minus(totalIn).toDecimalPlaces(2).toNumber();
  const { toConversion, toCogs } = splitProductionDiff(diff, conversionTotal.toDecimalPlaces(2).toNumber());
  return { diff, inputCredits, outputDebits, toConversion, toCogs, loss: diff < 0 ? Math.abs(diff) : 0 };
}

export function computeProductionCosting(input: ProductionCostingInput): ProductionCosting {
  const mainOutputs = input.outputs.filter((o) => !o.isByProduct);
  const byProducts = input.outputs.filter((o) => o.isByProduct);
  const totalInputQty = input.inputs.reduce((s, i) => s + i.quantity, 0);
  const totalMainOutputQty = mainOutputs.reduce((s, o) => s + o.quantity, 0);
  const inputQtyDec = sum(input.inputs.map((i) => new Decimal(i.quantity)));
  const mainOutputQtyDec = sum(mainOutputs.map((o) => new Decimal(o.quantity)));

  const inputLines = input.inputs.map(costInput);
  const totalMaterialCost = sum(inputLines.map((l) => new Decimal(l.totalValue)));

  const resolvedCosts = resolveCosts(input.costs ?? [], inputQtyDec, mainOutputQtyDec);
  const totalCostInputSide = sum(resolvedCosts.filter((c) => c.costSide === 'InputSide').map((c) => c.totalAmount));
  const totalCostOutputSide = sum(resolvedCosts.filter((c) => c.costSide === 'OutputSide').map((c) => c.totalAmount));
  const totalByproductValue = sum(byProducts.map((o) => new Decimal(o.quantity).mul(new Decimal(o.unitPrice ?? 0))));

  const numerator = totalMaterialCost.plus(totalCostInputSide).plus(totalCostOutputSide).minus(totalByproductValue);
  const hpp = loadedHpp(input.hppOverride, numerator, mainOutputQtyDec);
  const outputLines = input.outputs.map((o) => costOutput(o, hpp.computedHpp, totalInputQty));

  return {
    inputLines,
    outputLines,
    resolvedCosts,
    totalInputQty,
    totalMainOutputQty,
    byProductQty: byProducts.reduce((s, o) => s + o.quantity, 0),
    yieldPct: totalInputQty > 0 ? (totalMainOutputQty / totalInputQty) * 100 : null,
    totalMaterialCost,
    totalCostInputSide,
    totalCostOutputSide,
    totalByproductValue,
    ...hpp,
    journalPlan: journalPlanOf(inputLines, outputLines, totalCostInputSide.plus(totalCostOutputSide)),
  };
}
