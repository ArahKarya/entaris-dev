// Year-close checks for receivables and customer deposits (E4-R3), plugged into the E1 checklist
// with registerCloseCheck. Loaded through services/closeCheckPlugins.ts, never from
// fiscalYearClose.ts itself (a circular import would run this before the registry exists).
//
// Both block the close (owner decision #3) and are baseline-aware: differences that exist at
// release are captured once with `e1-close-baseline --check <id> --apply --allow-existing`, and
// only a new difference, or a known one whose amount changed, blocks. The balances compared are
// today's (see arSubledgerCheck.ts), limited to the Customers with a ledger row in the year.
import { Prisma } from '@prisma/client';
import { registerCloseCheck, type CloseCheck, type CloseCheckOutcome, type CloseCheckYear } from '../fiscalYearClose';
import { findArSubledgerDiffs, findCustomerDepositDiffs, type PartySubledgerDiff } from './arSubledgerCheck';

type Tx = Prisma.TransactionClient;

/** Every difference as an item keyed by party (no year suffix: one baseline row per Customer). */
function outcome(rows: readonly PartySubledgerDiff[]): CloseCheckOutcome {
  return {
    count: rows.length,
    items: rows.map((r) => ({
      key: r.partyId ? `Party:${r.partyId}` : 'Party:none',
      kind: 'Party',
      label: r.partyName ?? '(tanpa Customer)',
      amount: r.difference.toFixed(2),
    })),
  };
}

function subledgerCheck(id: string, find: (tx: Tx, scope: { fiscalYear: CloseCheckYear }) => Promise<PartySubledgerDiff[]>): CloseCheck {
  return {
    id,
    severity: 'block',
    baselineAware: true,
    async run(tx, fy) {
      return outcome(await find(tx, { fiscalYear: fy }));
    },
  };
}

/** Receivable in the ledger vs invoice outstanding plus opening outstanding, per Customer. */
export const arSubledgerCloseCheck = subledgerCheck('ar-subledger', findArSubledgerDiffs);

/** Customer deposit in the ledger vs what is left of the Submitted deposits, per Customer. */
export const customerDepositSubledgerCloseCheck = subledgerCheck('customer-deposit-subledger', findCustomerDepositDiffs);

registerCloseCheck(arSubledgerCloseCheck);
registerCloseCheck(customerDepositSubledgerCloseCheck);
