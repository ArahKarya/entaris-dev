// Read-only report of manual stock movements priced before the server valued them (E3-R4, PR-6.3a):
// (a) an active manual Stock Out / Adjustment − whose unit cost differs from the average replayed
// over the item's earlier rows (the client's cost was posted as is), and (b) an active manual row
// whose offset is the opening balance equity (the old default). The lists are defined in
// services/inventory/manualMovementAudit.ts. This script never writes to the database; re-pricing
// old rows is left to the value ledger baseline and the inventory vs GL reconciliation.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e3-manual-movement-cost-audit.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e3-manual-movement-cost-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { findManualMovementCostIssues, type ManualAuditList } from '../../services/inventory/manualMovementAudit';

interface Options {
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

const LIST_TITLES: Record<ManualAuditList, string> = {
  a: 'manual stock out not at the replayed average',
  b: 'manual row against the opening balance equity',
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await findManualMovementCostIssues(prisma);

  if (opts.out) {
    const header = 'list,movement_id,movement_number,date,item_id,movement_type,quantity,unit_cost,total_value,replayed_average,difference,offset_account_id,note';
    const lines = rows.map((r) =>
      [r.list, r.id, r.movementNumber, r.date, r.itemId, r.movementType, r.quantity, r.unitCost, r.totalValue, r.replayedAverage, r.difference, r.offsetAccountId, r.note]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log(`READ ONLY: ${rows.length} manual stock movement finding(s)`);
  for (const list of Object.keys(LIST_TITLES) as ManualAuditList[]) {
    const listed = rows.filter((r) => r.list === list);
    const net = listed.reduce((sum, r) => sum.plus(r.difference ?? 0), new Decimal(0));
    console.log(`  (${list}) ${LIST_TITLES[list]}: ${listed.length}${list === 'a' ? `, net difference ${net.toFixed(2)}` : ''}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
