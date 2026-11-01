// Purchase invoice line calculations (rice-mill raw material pricing).
// timbanganTruk is informational only; timbanganDiterima (after refaksi) is the paid weight and is
// mirrored into `quantity`. ppnPct/pphPct are manual per item; potonganItem is IDR, not percent.
//   subtotal = quantity x rate x (1 - discount/100)
//   hargaAkhir (`amount`) = subtotal + subtotal x ppnPct/100 - subtotal x pphPct/100 - potonganItem
// PPN/PPh are folded into `amount`, not separate GL lines; stock unit cost includes everything
// (taxes, potongan, landed cost share). Header `potongan` caches SUM(items.potonganItem).
//   grandTotal = SUM(hargaAkhir) + biayaLain (the header potongan is never subtracted again)

import Decimal from 'decimal.js';

export interface RawPurchaseItemInput {
  quantity: number;
  rate: number;
  discount?: number;
  taxPct?: number;
  pphPct?: number;
  potonganItem?: number;
  timbanganDiterima?: number | null;
}

export interface ComputedPurchaseItem {
  effectiveQuantity: Decimal;
  subtotal: Decimal;
  ppnAmount: Decimal;
  pphAmount: Decimal;
  hargaAkhir: Decimal; // final item amount (what goes into `amount` column)
}

const D = (v: number | string | undefined | null): Decimal =>
  new Decimal(v ?? 0);

/**
 * Compute the effective quantity used for pricing & stock movement.
 * When timbanganDiterima is provided (rice mill flow) it overrides quantity.
 */
export function effectiveQuantity(
  input: Pick<RawPurchaseItemInput, 'quantity' | 'timbanganDiterima'>,
): Decimal {
  if (input.timbanganDiterima != null && input.timbanganDiterima > 0) {
    return D(input.timbanganDiterima);
  }
  return D(input.quantity);
}

export function computePurchaseItem(
  input: RawPurchaseItemInput,
): ComputedPurchaseItem {
  const qty = effectiveQuantity(input);
  const base = qty.mul(D(input.rate));
  const discPct = D(input.discount ?? 0).div(100);
  const subtotal = base
    .minus(base.mul(discPct))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const ppnAmount = subtotal
    .mul(D(input.taxPct ?? 0).div(100))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const pphAmount = subtotal
    .mul(D(input.pphPct ?? 0).div(100))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const potongan = D(input.potonganItem ?? 0);

  const hargaAkhir = subtotal
    .plus(ppnAmount)
    .minus(pphAmount)
    .minus(potongan)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    effectiveQuantity: qty,
    subtotal,
    ppnAmount,
    pphAmount,
    hargaAkhir,
  };
}

/**
 * Sum of potonganItem across lines — becomes the header `potongan` cache.
 */
export function sumPotonganItem(
  items: Array<{ potonganItem?: number }>,
): Decimal {
  return items.reduce(
    (sum, i) => sum.plus(D(i.potonganItem ?? 0)),
    new Decimal(0),
  );
}

/** Largest difference (rupiah) allowed between a sent header `potongan` and SUM(potonganItem). */
export const POTONGAN_TOLERANCE = 0.01;

export interface PurchaseInvoiceTotalsInput {
  items: RawPurchaseItemInput[];
  biayaLain?: number | null;
}

export interface PurchaseInvoiceTotals {
  lines: ComputedPurchaseItem[];
  /** SUM(hargaAkhir): each line already has its potonganItem deducted. */
  itemsSubtotal: Decimal;
  potonganItemTotal: Decimal;
  biayaLain: Decimal;
  grandTotal: Decimal;
}

/**
 * Invoice totals from a create payload; the one formula for the posted invoice, the approval
 * queue amount and the approval dialog. The header `potongan` is not used.
 */
export function computePurchaseInvoiceTotals(body: PurchaseInvoiceTotalsInput): PurchaseInvoiceTotals {
  const lines = body.items.map(computePurchaseItem);
  const itemsSubtotal = lines.reduce((sum, l) => sum.plus(l.hargaAkhir), new Decimal(0));
  const biayaLain = D(body.biayaLain);
  return {
    lines,
    itemsSubtotal,
    potonganItemTotal: sumPotonganItem(body.items),
    biayaLain,
    grandTotal: itemsSubtotal.plus(biayaLain).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  };
}

/**
 * True when a header `potongan` was sent (> 0) and differs from SUM(potonganItem) by more than
 * POTONGAN_TOLERANCE. Zero or absent passes: the client never sends the header.
 */
export function headerPotonganMismatch(body: {
  potongan?: number | null;
  items: Array<{ potonganItem?: number }>;
}): boolean {
  const header = D(body.potongan);
  if (header.lte(0)) return false;
  return header.minus(sumPotonganItem(body.items)).abs().gt(POTONGAN_TOLERANCE);
}

/** Totals as plain numbers, for the approval dialog (`piTotals` in the request context). */
export function purchaseInvoiceTotalsView(body: PurchaseInvoiceTotalsInput & { potongan?: number | null }) {
  const t = computePurchaseInvoiceTotals(body);
  return {
    subtotal: t.itemsSubtotal.toNumber(),
    potonganItem: t.potonganItemTotal.toNumber(),
    biayaLain: t.biayaLain.toNumber(),
    grandTotal: t.grandTotal.toNumber(),
    headerPotonganMismatch: headerPotonganMismatch(body),
  };
}
