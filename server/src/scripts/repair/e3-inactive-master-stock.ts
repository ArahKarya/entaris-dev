// Read-only report of inventory items and warehouses that were switched off while they still hold
// stock (negative stock included) or, for items, still sit on a delivery order no Invoice has picked
// up (E3-R5). The item and warehouse screens refuse to deactivate such a row now; rows switched off
// earlier are listed here for the accountant to bring back or empty. The finding rules live in
// services/inventory/itemMasterGuard.ts. This script never writes to the database.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e3-inactive-master-stock.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e3-inactive-master-stock.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { findInactiveMasterWithStock } from '../../services/inventory/itemMasterGuard';

function parseArgs(argv: readonly string[]): { out: string | null } {
  const opts = { out: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await findInactiveMasterWithStock(prisma);

  if (opts.out) {
    const header = 'kind,id,code,name,quantity,uninvoiced_deliveries';
    const lines = rows.map((r) => [r.kind, r.id, r.code, r.name, r.quantity, r.uninvoicedDeliveries].map(csvCell).join(','));
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log(`READ ONLY: ${rows.length} inactive master row(s) still holding stock or uninvoiced deliveries`);
  for (const r of rows) {
    console.log(`  ${r.kind} ${r.code} ${r.name}: quantity ${r.quantity}, uninvoiced delivery lines ${r.uninvoicedDeliveries}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
