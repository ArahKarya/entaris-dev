// Stored balance recalculation (E2-R15). Dry run by default: lists every account whose
// accounts.balance differs from the sum of its active ledger rows over all years, and every
// revenue/expense account with ledger rows in a closed or reopened fiscal year, with that year's
// contribution per column:
//   ok            within half a cent
//   closed-year   the difference is a signed sum of year closes and reopens since the account's
//                 last recalculation: a close subtracted the year's contribution as it stood then
//                 (-), a reopen added it back (+); "+2025 -2025" is a reopen and a second close
//   unexplained   anything else: review before any recalculation
// Only the stored balance column changes on a recalculation (COA page, delete/deactivate guards);
// the reports read the ledger and do not move.
//
// --apply sets the closed-year rows to the ledger sum (closing and reopening a year no longer
// change these balances, PR-5.5); unexplained rows only with --include-unexplained, once the
// accountant has reviewed them. A row whose difference changed after the plan is skipped. It needs
// --approved-by "<accountant name>"; the name goes on one audit row per account and in the CSV,
// which --apply always writes (default file name when --out is not given) before the transaction
// starts. Run it on the day PR-5.5 is deployed, with no year close or reopen in between.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-stored-balance-recalc.js [--out file.csv]
//   node dist/scripts/repair/e2-stored-balance-recalc.js --apply --approved-by "<name>" [--include-unexplained] [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-stored-balance-recalc.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applyStoredBalanceRecalc,
  planStoredBalanceRecalc,
  type RecalcYear,
  type StoredBalancePlanRow,
} from '../../services/ledger/storedBalances';

interface Options {
  apply: boolean;
  approvedBy: string | null;
  includeUnexplained: boolean;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, approvedBy: null, includeUnexplained: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--approved-by') opts.approvedBy = argv[++i]?.trim() || null;
    else if (a === '--include-unexplained') opts.includeUnexplained = true;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.includeUnexplained && !opts.apply) throw new Error('--include-unexplained only goes with --apply');
  return opts;
}

function writeCsv(
  file: string,
  years: readonly RecalcYear[],
  rows: readonly StoredBalancePlanRow[],
  applied: ReadonlySet<string>,
  approvedBy: string | null,
) {
  const header = [
    'account_number', 'name', 'root_type', 'stored', 'ledger_all_time', 'difference',
    ...years.map((y) => `contrib_${y.name}`), 'reopened_years', 'class', 'explanation', 'applied', 'approved_by',
  ].map(csvCell).join(',');
  const reopened = new Set(years.filter((y) => y.reopened).map((y) => y.fiscalYearId));
  const lines = rows.map((r) => {
    const byYear = new Map(r.contributions.map((c) => [c.year.fiscalYearId, c.contribution.toFixed(2)]));
    const done = applied.has(r.accountId);
    return [
      r.accountNumber, r.name, r.rootType, r.stored.toFixed(2), r.fromLedger.toFixed(2), r.difference.toFixed(2),
      ...years.map((y) => byYear.get(y.fiscalYearId) ?? ''),
      r.contributions.filter((c) => reopened.has(c.year.fiscalYearId)).map((c) => c.year.name).join(';'),
      r.class, r.explanation, done ? 'yes' : 'no', done ? approvedBy : null,
    ].map(csvCell).join(',');
  });
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { years, rows } = await prisma.$transaction((tx) => planStoredBalanceRecalc(tx), { timeout: 60000 });
  const count = (c: StoredBalancePlanRow['class']) => rows.filter((r) => r.class === c).length;
  console.log(`Closed or reopened fiscal years: ${years.length === 0 ? 'none' : years.map((y) => `${y.name}${y.isClosed ? ' (closed)' : ''}${y.reopened ? ' (reopened)' : ''}`).join(', ')}`);
  console.log(`Accounts listed: ${rows.length} (ok ${count('ok')}, closed-year ${count('closed-year')}, unexplained ${count('unexplained')})`);
  for (const r of rows.filter((x) => x.class !== 'ok')) {
    console.log(`  ${r.class} ${r.accountNumber} ${r.name}: stored ${r.stored.toFixed(2)}, ledger ${r.fromLedger.toFixed(2)}, difference ${r.difference.toFixed(2)}${r.explanation ? ` = ${r.explanation}` : ''}`);
  }

  const out = opts.out ?? (opts.apply ? `e2-stored-balance-recalc-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  let applied = new Set<string>();
  if (opts.apply && opts.approvedBy) {
    if (out) writeCsv(out, years, rows, applied, opts.approvedBy);
    const approvedBy = opts.approvedBy;
    const result = await prisma.$transaction(
      (tx) => applyStoredBalanceRecalc(tx, rows, { approvedBy, includeUnexplained: opts.includeUnexplained }),
      { timeout: 60000 },
    );
    applied = new Set(result.applied.map((c) => c.accountId));
    console.log(`Recalculated ${result.applied.length} stored balance(s) from the ledger, approved by ${result.approvedBy}.`);
    for (const s of result.skipped) console.log(`  skipped ${s.accountNumber}: ${s.reason}`);
  } else {
    console.log('Dry run: nothing written. Only the stored balance column would change, not the reports.');
    console.log('Pass --apply --approved-by "<accountant name>" to write the closed-year rows.');
  }

  if (out) writeCsv(out, years, rows, applied, opts.approvedBy);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
