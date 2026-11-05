import Decimal from 'decimal.js';

/** Exact sum of money amounts (numbers, strings or Decimals), returned as a plain number. */
export function sumMoney(values: Iterable<Decimal.Value>): number {
  let total = new Decimal(0);
  for (const v of values) total = total.plus(v);
  return total.toNumber();
}
