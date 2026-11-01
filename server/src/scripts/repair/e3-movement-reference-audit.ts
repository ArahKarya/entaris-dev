// Read-only report of stock movement references left by the paths the E3-R2 document lock closed:
// (a) a reference type typed by a client without a document, (b) a document movement cancelled
// per row while its document is still active (old transfer rows moved stock with the wrong sign),
// (c) an invalid batch link, (d) a document id without a reference type, or naming no document.
// The lists are defined in services/inventory/movementReferenceAudit.ts. This script never writes
// to the database; stock damage is corrected by the accountant with stock adjustments.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e3-movement-reference-audit.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e3-movement-reference-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { findMovementReferenceIssues, type AuditList } from '../../services/inventory/movementReferenceAudit';

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

const LIST_TITLES: Record<AuditList, string> = {
  a: 'reference type without document',
  b: 'document movement cancelled per row, document active',
  c: 'invalid batch link',
  d: 'document id without (matching) reference type',
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await findMovementReferenceIssues(prisma);

  if (opts.out) {
    const header = 'list,movement_id,movement_number,date,item_id,movement_type,quantity,reference_type,reference_id,reference_number,is_cancelled,note';
    const lines = rows.map((r) =>
      [r.list, r.id, r.movementNumber, r.date, r.itemId, r.movementType, r.quantity, r.referenceType, r.referenceId, r.referenceNumber, r.isCancelled, r.note]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log(`READ ONLY: ${rows.length} stock movement finding(s)`);
  for (const list of Object.keys(LIST_TITLES) as AuditList[]) {
    console.log(`  (${list}) ${LIST_TITLES[list]}: ${rows.filter((r) => r.list === list).length}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
