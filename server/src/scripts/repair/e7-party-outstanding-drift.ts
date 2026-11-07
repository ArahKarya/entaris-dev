// Read-only report of party outstanding drift (E7-R13), per side since E2-R13. The removed dummy
// generator and the old delete-dummy recalculated every party from open invoices alone and dropped
// opening outstanding balances. Lists every real party whose stored receivable, payable or total
// outstanding differs from what recalcPartyOutstanding computes (services/ledger/partySides.ts), or
// whose expected amount differs from its AR/AP ledger balance, and when the old generator/delete
// ran (audit trail).
//
// The ledger column is indicative until opening balances are journaled per party (E2-R11). There
// is no --apply: the accountant decides each correction (journal or adjustment).
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e7-party-outstanding-drift.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e7-party-outstanding-drift.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { computePartyOutstandingDrift, legacyDummyRuns } from '../../services/partyOutstandingDrift';

function parseArgs(argv: readonly string[]): { out: string | null } {
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { out };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const [rows, runs] = await Promise.all([computePartyOutstandingDrift(), legacyDummyRuns()]);

  if (out) {
    const header = [
      'party_id,name,party_type,stored,expected,ledger_indicative,stored_minus_expected,expected_minus_ledger',
      'receivable_stored,receivable_expected,receivable_ledger,payable_stored,payable_expected,payable_ledger,legacy_unassigned',
    ].join(',');
    const lines = rows.map((r) =>
      [
        r.partyId, r.name, r.partyType, r.stored, r.expected, r.ledger, r.storedMinusExpected, r.expectedMinusLedger,
        r.receivable.stored, r.receivable.expected, r.receivable.ledger, r.payable.stored, r.payable.expected, r.payable.ledger,
        r.legacyUnassigned,
      ].map(csvCell).join(','),
    );
    writeFileSync(out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${out}`);
  }

  console.log(`READ ONLY: ${rows.length} party(ies) with drift (ledger column is indicative until E2-R11)`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(32)} ${r.partyType.padEnd(8)} stored ${r.stored.padStart(16)}  expected ${r.expected.padStart(16)}  ledger ${r.ledger.padStart(16)}`);
    console.log(`  ${''.padEnd(41)} receivable ${r.receivable.stored}/${r.receivable.expected}  payable ${r.payable.stored}/${r.payable.expected}`);
  }
  console.log(`Old dummy generator/delete runs in the audit trail: ${runs.length}`);
  for (const run of runs) console.log(`  ${run.at.toISOString()}  ${run.action}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
