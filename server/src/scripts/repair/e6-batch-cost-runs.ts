// Read-only report of production runs whose inputs picked a batch (E6-R3, PR-6.9). Before the
// value ledger such an input was valued at the batch cost the form sent, not at the average: each
// active batch-linked input is listed with the cost it went out at, the batch cost and the average
// replayed over the item's earlier rows, and the gap per inventory account is summed. The lists are
// defined in services/production/productionAudit.ts. This script never writes to the database; a
// correction is a journal the accountant approves. The inventory vs GL difference per account
// (services/inventory/inventoryGlCheck.ts, PR-6.13a) is not joined in yet.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e6-batch-cost-runs.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e6-batch-cost-runs.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { findBatchCostRuns } from '../../services/production/productionAudit';

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await prisma.$transaction((tx) => findBatchCostRuns(tx), { timeout: 120000 });

  if (opts.out) {
    const header = 'run_id,run_number,movement_id,movement_number,date,item_id,item_code,account_id,source_movement_id,quantity,unit_cost,total_value,batch_unit_cost,replayed_average,difference,note';
    const lines = rows.map((r) =>
      [r.runId, r.runNumber, r.movementId, r.movementNumber, r.date, r.itemId, r.itemCode, r.accountId, r.sourceMovementId,
        r.quantity, r.unitCost, r.totalValue, r.batchUnitCost, r.replayedAverage, r.difference, r.note]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }

  const runs = new Set(rows.map((r) => r.runId));
  const off = rows.filter((r) => !new Decimal(r.difference).isZero());
  console.log(`READ ONLY: ${rows.length} batch-linked production input(s) in ${runs.size} active run(s); ${off.length} not at the replayed average`);
  const perAccount = new Map<string, Decimal>();
  for (const r of off) {
    const key = r.accountId ?? '(no inventory account)';
    perAccount.set(key, (perAccount.get(key) ?? new Decimal(0)).plus(r.difference));
  }
  for (const [account, net] of perAccount) console.log(`  account ${account}: net difference ${net.toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
