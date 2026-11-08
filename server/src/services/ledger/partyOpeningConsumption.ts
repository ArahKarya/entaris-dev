// What a Receive/Pay payment takes from the party's opening (E2-R13, plan step 5 PR-5.13). The part of
// a payment no invoice took goes to the opening on the payment's side: a Receive to the receivable
// opening, a Pay to the payable opening, never the other side (a Both party paying its supplier side
// used to lower the receivable opening). It takes the side's column first, then the undirected rest
// (legacyUnassigned) when computePartySides counts that rest on this side (receivable for a Customer
// or Both, payable for a Supplier), so the subledger keeps following the ledger the payment moved.
//
// Every amount taken is a PaymentAllocation of the payment, invoiceId = the party id, one per bucket:
//   OpeningReceivable / OpeningPayable  the side's column (opening_receivable / opening_payable)
//   OpeningUnassigned                   the undirected rest (opening_outstanding alone)
// Cancelling the payment (routes/payments.ts) and a refund against it (services/paymentSubmit.ts) put
// the amount back into the same bucket through adjustPartyOpening, the one writer (partySides.ts).
// These types are written by the server only; the allocation input of POST /payments still takes
// SalesInvoice / PurchaseInvoice alone (utils/schemas.ts).
import { Prisma, type PartyType } from '@prisma/client';
import { adjustPartyOpening, type OpeningBucket, type PartySide } from './partySides';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value | null | undefined): Dec => new Prisma.Decimal(v ?? 0);

export const OPENING_ALLOCATION_TYPE: Readonly<Record<OpeningBucket, string>> = {
  RECEIVABLE: 'OpeningReceivable',
  PAYABLE: 'OpeningPayable',
  UNASSIGNED: 'OpeningUnassigned',
};

const BUCKET_BY_TYPE = new Map<string, OpeningBucket>(
  (Object.entries(OPENING_ALLOCATION_TYPE) as [OpeningBucket, string][]).map(([bucket, type]) => [type, bucket]),
);

/** The opening bucket of an allocation type, or null for an invoice allocation. */
export const openingBucketOf = (invoiceType: string): OpeningBucket | null => BUCKET_BY_TYPE.get(invoiceType) ?? null;

export const isOpeningAllocation = (invoiceType: string): boolean => BUCKET_BY_TYPE.has(invoiceType);

/** The opening side a Receive or Pay payment settles. */
export const paymentOpeningSide = (paymentType: 'Receive' | 'Pay'): PartySide => (paymentType === 'Receive' ? 'RECEIVABLE' : 'PAYABLE');

export interface OpeningColumns {
  partyType: PartyType;
  openingReceivable: Prisma.Decimal.Value;
  openingPayable: Prisma.Decimal.Value;
  openingOutstanding: Prisma.Decimal.Value;
}

/** True when computePartySides counts the undirected rest on `side` for this party type. */
export const unassignedCountsOn = (partyType: PartyType, side: PartySide): boolean =>
  (partyType === 'Supplier') === (side === 'PAYABLE');

/**
 * How much of `amount` the opening on `side` can take, per bucket. Pure. The column comes first; an
 * undirected rest counted on this side adds to what is there when positive, and when negative (a
 * remainder cut opening_outstanding alone before PR-5.13) it already took that much, so the column
 * gives at most column + rest. Nothing goes below zero.
 */
export function planOpeningConsumption(c: OpeningColumns, side: PartySide, amount: Prisma.Decimal.Value): { side: Dec; unassigned: Dec } {
  const want = Prisma.Decimal.max(D(amount), 0);
  const column = D(side === 'RECEIVABLE' ? c.openingReceivable : c.openingPayable);
  const rest = D(c.openingOutstanding).minus(D(c.openingReceivable)).minus(D(c.openingPayable));
  const here = unassignedCountsOn(c.partyType, side);
  let available = Prisma.Decimal.max(column, 0);
  if (here && rest.isNegative()) available = Prisma.Decimal.max(available.plus(rest), 0);
  const fromSide = Prisma.Decimal.min(want, available);
  const fromRest = here && rest.gt(0) ? Prisma.Decimal.min(want.minus(fromSide), rest) : D(0);
  return { side: fromSide, unassigned: fromRest };
}

/**
 * Takes up to `amount` from the party's opening on `side` (see planOpeningConsumption) under the
 * party row lock and records one allocation per bucket on the payment. Returns the total taken.
 */
export async function consumePartyOpening(
  tx: Tx,
  paymentId: string,
  partyId: string,
  side: PartySide,
  amount: Prisma.Decimal.Value,
): Promise<Dec> {
  const rows = await tx.$queryRaw<{ party_type: PartyType; opening_receivable: string; opening_payable: string; opening_outstanding: string }[]>`
    SELECT "partyType" AS party_type, opening_receivable::text, opening_payable::text, opening_outstanding::text
      FROM parties WHERE id = ${partyId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return D(0);
  const plan = planOpeningConsumption({
    partyType: row.party_type,
    openingReceivable: row.opening_receivable,
    openingPayable: row.opening_payable,
    openingOutstanding: row.opening_outstanding,
  }, side, D(amount).toDecimalPlaces(2));
  let taken = D(0);
  for (const [bucket, want] of [[side, plan.side], ['UNASSIGNED', plan.unassigned]] as const) {
    if (!want.gt(0)) continue;
    const got = (await adjustPartyOpening(tx, partyId, bucket, want.neg())).neg();
    if (!got.gt(0)) continue;
    await tx.paymentAllocation.create({
      data: { paymentId, invoiceType: OPENING_ALLOCATION_TYPE[bucket], invoiceId: partyId, allocatedAmount: got },
    });
    taken = taken.plus(got);
  }
  return taken;
}

/** Puts `amount` of an opening allocation back into its bucket (payment cancel, refund). */
export async function restorePartyOpening(tx: Tx, partyId: string, invoiceType: string, amount: Prisma.Decimal.Value): Promise<Dec> {
  const bucket = openingBucketOf(invoiceType);
  if (!bucket || !D(amount).gt(0)) return D(0);
  return adjustPartyOpening(tx, partyId, bucket, D(amount));
}
