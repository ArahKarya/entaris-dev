import Decimal from 'decimal.js';

/**
 * Recalculate weighted average cost after a stock-in movement.
 *
 * Formula:
 *   newAvgCost = (currentQty × currentAvgCost + inQty × inUnitCost) / (currentQty + inQty)
 *
 * @param currentQty  - Current stock quantity BEFORE the new movement
 * @param currentAvgCost - Current weighted average cost per unit
 * @param inQty - Quantity being added
 * @param inUnitCost - Unit cost of the incoming stock
 * @returns New weighted average cost (rounded to 2 decimals)
 */
export function calcWeightedAverage(
  currentQty: number | Decimal,
  currentAvgCost: number | Decimal,
  inQty: number | Decimal,
  inUnitCost: number | Decimal,
): number {
  const cQty = new Decimal(currentQty.toString());
  const cCost = new Decimal(currentAvgCost.toString());
  const iQty = new Decimal(inQty.toString());
  const iCost = new Decimal(inUnitCost.toString());

  // With zero or negative stock the WAC formula gives absurd values that corrupt COGS,
  // so anchor the average to the incoming unit cost.
  if (cQty.lte(0)) {
    return iCost.toDecimalPlaces(2).toNumber();
  }

  const totalQty = cQty.plus(iQty);
  if (totalQty.lte(0)) {
    // Pathological: incoming qty smaller than (negative of) current. Anchor
    // to inCost as well — there's no meaningful weighted value.
    return iCost.toDecimalPlaces(2).toNumber();
  }

  const totalValue = cQty.times(cCost).plus(iQty.times(iCost));
  return totalValue.div(totalQty).toDecimalPlaces(2).toNumber();
}

/**
 * The inverse of calcWeightedAverage: the average after a stock-in is taken back out at its own cost.
 *
 *   avgAfter = (currentQty × currentAvgCost − outQty × outUnitCost) / (currentQty − outQty)
 *
 * Used when the movements cannot be replayed (stock without a movement behind it). Returns the
 * current average when nothing would be left or the value left would be negative: there is no
 * meaningful average then, and the stored one is all that is known.
 *
 * @returns Average cost after the removal (rounded to 2 decimals)
 */
export function calcAverageAfterRemoval(
  currentQty: number | Decimal,
  currentAvgCost: number | Decimal,
  outQty: number | Decimal,
  outUnitCost: number | Decimal,
): number {
  const cQty = new Decimal(currentQty.toString());
  const cCost = new Decimal(currentAvgCost.toString());
  const leftQty = cQty.minus(outQty.toString());
  const leftValue = cQty.times(cCost).minus(new Decimal(outQty.toString()).times(outUnitCost.toString()));
  if (leftQty.lte(0) || leftValue.lt(0)) return cCost.toDecimalPlaces(2).toNumber();
  return leftValue.div(leftQty).toDecimalPlaces(2).toNumber();
}
