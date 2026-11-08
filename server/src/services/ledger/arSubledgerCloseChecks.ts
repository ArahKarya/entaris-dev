// Year-close checks for receivables and customer deposits (E4-R3) and payables (PR-5.10, owner
// decision #9), plugged into the E1 checklist
// with registerCloseCheck. Loaded through services/closeCheckPlugins.ts, never from
// fiscalYearClose.ts itself (a circular import would run this before the registry exists).
//
// All block the close (owner decision #3) and are baseline-aware: differences that exist at
// release are captured once with `e1-close-baseline --check <id> --apply --allow-existing`, and
// only a new difference, or a known one that grew or changed sign, blocks; one the accountant
// reduced stays covered. The balances compared are today's (see arSubledgerCheck.ts), limited to
// the parties with a ledger row or a document in the year.
import { Prisma } from '@prisma/client';
import { registerCloseCheck, type CloseCheck, type CloseCheckOutcome, type CloseCheckYear } from '../fiscalYearClose';
import { findApSubledgerDiffs, findArSubledgerDiffs, findCustomerDepositDiffs, type PartySubledgerDiff } from './arSubledgerCheck';

type Tx = Prisma.TransactionClient;

/**
 * Every difference as an item keyed by party. A Customer's amount is its full balance today, the
 * same whichever year runs, so its key has no year (one baseline row per Customer). The bucket
 * without a party only counts the year's rows, so its key carries the year: a capture over several
 * years stores each year's amount.
 */
function outcome(rows: readonly PartySubledgerDiff[], fy: CloseCheckYear, noParty: string): CloseCheckOutcome {
  return {
    count: rows.length,
    items: rows.map((r) => ({
      key: r.partyId ? `Party:${r.partyId}` : `Party:none:${fy.id}`,
      kind: 'Party',
      label: r.partyName ?? noParty,
      amount: r.difference.toFixed(2),
    })),
  };
}

/** The baseline covers a difference of the same sign that is no larger: a partial fix does not block. */
export function subledgerBaselineCovers(current: Prisma.Decimal, baseline: Prisma.Decimal): boolean {
  return current.isNegative() === baseline.isNegative() && current.abs().lessThanOrEqualTo(baseline.abs());
}

function subledgerCheck(
  id: string,
  find: (tx: Tx, scope: { fiscalYear: CloseCheckYear }) => Promise<PartySubledgerDiff[]>,
  noParty = '(tanpa Customer)',
): CloseCheck {
  return {
    id,
    severity: 'block',
    baselineAware: true,
    baselineCovers: subledgerBaselineCovers,
    async run(tx, fy) {
      return outcome(await find(tx, { fiscalYear: fy }), fy, noParty);
    },
  };
}

/** Receivable in the ledger vs invoice outstanding plus opening outstanding, per Customer. */
export const arSubledgerCloseCheck = subledgerCheck('ar-subledger', findArSubledgerDiffs);

/** Customer deposit in the ledger vs what is left of the Submitted deposits, per Customer. */
export const customerDepositSubledgerCloseCheck = subledgerCheck('customer-deposit-subledger', findCustomerDepositDiffs);

/** Payable in the ledger vs invoice outstanding plus opening payable, per Supplier. */
export const apSubledgerCloseCheck = subledgerCheck('ap-subledger', findApSubledgerDiffs, '(tanpa Supplier)');

registerCloseCheck(arSubledgerCloseCheck);
registerCloseCheck(customerDepositSubledgerCloseCheck);
registerCloseCheck(apSubledgerCloseCheck);
