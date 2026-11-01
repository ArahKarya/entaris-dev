// Rows whose currency code is not IDR in accounts, company_settings and payment_requests (E2-R7,
// E8-R12 stage 1: bookkeeping and payment requests are rupiah only). Expected to find none: the API
// never stored a foreign account or payment request currency, and only the company settings form
// accepted one. Dry run by default: prints every row and, with --out, writes them as CSV.
// --apply sets the code to IDR (nothing else is written: no amount, no journal) and needs
// --approved-by "<accountant name>"; the name is recorded on one audit row per rewritten row
// (action E2_RUPIAH_ONLY_REPAIR, in the same transaction) and goes into the CSV, which --apply
// always writes (default file name when --out is not given) BEFORE the transaction, so a path
// that cannot be written stops the run before anything is committed.
// Run the dry run before deploying the rupiah-only change.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-rupiah-only-check.js [--out file.csv]
//   node dist/scripts/repair/e2-rupiah-only-check.js --apply --approved-by "<name>" [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-rupiah-only-check.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { applyRupiahOnlyFixes, planRupiahOnlyFixes, type RupiahOnlyRow } from '../../services/rupiahOnlyRepair';

interface Options {
  apply: boolean;
  approvedBy: string | null;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, approvedBy: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--approved-by') opts.approvedBy = argv[++i]?.trim() || null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  return opts;
}

/** action is 'set IDR' on an --apply run (rows changed since the plan are skipped, see console), else 'report'. */
function writeCsv(file: string, rows: readonly RupiahOnlyRow[], approvedBy: string | null) {
  const header = 'table,id,label,currency,action,approved_by';
  const lines = rows.map((r) =>
    [r.table, r.id, r.label, r.currency, approvedBy ? 'set IDR' : 'report', approvedBy].map(csvCell).join(','),
  );
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await planRupiahOnlyFixes(prisma);
  const count = (table: RupiahOnlyRow['table']) => plan.filter((r) => r.table === table).length;
  console.log(
    `Rows with a currency other than IDR: ${plan.length} ` +
      `(accounts ${count('accounts')}, company_settings ${count('company_settings')}, payment_requests ${count('payment_requests')})`,
  );
  for (const r of plan) console.log(`  ${r.table} ${r.label}: ${r.currency}`);

  const out = opts.out ?? (opts.apply ? `e2-rupiah-only-check-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  if (out) writeCsv(out, plan, opts.apply ? opts.approvedBy : null);

  if (opts.apply && opts.approvedBy) {
    const result = await prisma.$transaction((tx) => applyRupiahOnlyFixes(tx, plan, opts.approvedBy as string));
    console.log(`Set ${result.applied.length} currency code(s) to IDR, approved by ${result.approvedBy}.`);
    if (result.skipped.length > 0) console.log(`Skipped (changed since the plan): ${result.skipped.join(', ')}`);
  } else {
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to set them to IDR.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
