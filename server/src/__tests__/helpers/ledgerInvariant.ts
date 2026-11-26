import { assertLedgerInvariant as findLedgerDrifts } from '../../services/inventory/inventoryLedger';
import type { Tx } from './routeHarness';

/**
 * Fails when the given items break value-ledger invariant (a) stock_value = Σ active value_delta or
 * (b) stock x average = stock_value within the tolerance (services/inventory/inventoryLedger.ts).
 * Call it at the end of a test whose stock path already posts through the ledger (plan rule 11);
 * a path that has not moved yet breaks the invariant by design. Invariant (c), item total =
 * Σ warehouses, is report-only and checked only with `warehouses: true`.
 */
export async function assertLedgerInvariant(db: Tx, itemIds: readonly string[], opts: { warehouses?: boolean } = {}): Promise<void> {
  const drifts = (await findLedgerDrifts(db, itemIds)).filter((d) => !d.reportOnly || opts.warehouses);
  if (drifts.length === 0) return;
  const lines = drifts.map((d) => `${d.code} ${d.kind}: actual ${d.actual.toString()}, expected ${d.expected.toString()}`);
  throw new Error(`Value ledger invariant broken:\n${lines.join('\n')}`);
}
