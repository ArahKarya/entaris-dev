// A party's receivable and payable are kept apart (server services/ledger/partySides.ts):
// receivableOutstanding and payableOutstanding, with outstandingAmount their sum. A party typed Both
// can owe and be owed at once, so a payment or a list cell reads the side it is about.
import { toNumber } from '@/lib/format';

type Money = number | string | null | undefined;

export type PartySide = 'receivable' | 'payable';

export interface PartySideAmounts {
  partyType?: string;
  outstandingAmount?: Money;
  receivableOutstanding?: Money;
  payableOutstanding?: Money;
}

const num = (v: Money) => toNumber(v) ?? 0;

/**
 * The outstanding on one side. Rows from an older server without the side columns fall back to
 * outstandingAmount for a Customer (receivable) or a Supplier (payable), and to 0 for a Both party,
 * whose total mixes both sides.
 */
export function sideOutstanding(p: PartySideAmounts | null | undefined, side: PartySide): number {
  if (!p) return 0;
  const column = side === 'receivable' ? p.receivableOutstanding : p.payableOutstanding;
  if (column !== undefined && column !== null) return num(column);
  const own = side === 'receivable' ? 'Customer' : 'Supplier';
  return p.partyType === own ? num(p.outstandingAmount) : 0;
}

export interface OutstandingLine {
  side: PartySide;
  value: number;
}

/** The sides a list shows for the party: one for a Customer or Supplier, both for Both. */
export function outstandingLines(p: PartySideAmounts): OutstandingLine[] {
  if (p.partyType === 'Both') {
    return [
      { side: 'receivable', value: sideOutstanding(p, 'receivable') },
      { side: 'payable', value: sideOutstanding(p, 'payable') },
    ];
  }
  const side: PartySide = p.partyType === 'Supplier' ? 'payable' : 'receivable';
  return [{ side, value: sideOutstanding(p, side) }];
}
