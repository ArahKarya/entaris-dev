// Stored balance recalculation, dry run (E2-R15). Lists every account whose accounts.balance differs
// from the sum of its active ledger rows over all years, and every revenue/expense account with
// ledger rows in a closed or reopened fiscal year, with that year's contribution per column:
//   ok            within half a cent
//   closed-year   the difference is a signed sum of year closes and reopens since the account's
//                 last recalculation: a close subtracted the year's contribution as it stood then
//                 (-), a reopen added it back (+); "+2025 -2025" is a reopen and a second close
//   unexplained   anything else: review before any recalculation
// Only the stored balance column changes on a recalculation (COA page, delete/deactivate guards);
// the reports read the ledger and do not move.
//
// This release only reports. --apply arrives with the release where closing and reopening a year
// stop changing revenue/expense balances (PR-5.5): applied before it, a later reopen would add a
// year's contribution twice. Until then do not close or reopen a fiscal year in production.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-stored-balance-recalc.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-stored-balance-recalc.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { planStoredBalanceRecalc, type RecalcYear, type StoredBalancePlanRow } from '../../services/ledger/storedBalances';

function parseArgs(argv: readonly string[]): { out: string | null } {
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') continue;
    if (a === '--out') out = argv[++i] ?? null;
    else if (a === '--apply') throw new Error('This release only reports; --apply comes with the single balance rule release (PR-5.5).');
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { out };
}

function writeCsv(file: string, years: readonly RecalcYear[], rows: readonly StoredBalancePlanRow[]) {
  const header = [
    'account_number', 'name', 'root_type', 'stored', 'ledger_all_time', 'difference',
    ...years.map((y) => `contrib_${y.name}`), 'reopened_years', 'class', 'explanation',
  ].map(csvCell).join(',');
  const reopened = new Set(years.filter((y) => y.reopened).map((y) => y.fiscalYearId));
  const lines = rows.map((r) => {
    const byYear = new Map(r.contributions.map((c) => [c.year.fiscalYearId, c.contribution.toFixed(2)]));
    return [
      r.accountNumber, r.name, r.rootType, r.stored.toFixed(2), r.fromLedger.toFixed(2), r.difference.toFixed(2),
      ...years.map((y) => byYear.get(y.fiscalYearId) ?? ''),
      r.contributions.filter((c) => reopened.has(c.year.fiscalYearId)).map((c) => c.year.name).join(';'),
      r.class, r.explanation,
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
  console.log('Dry run: nothing written. Only the stored balance column would change, not the reports.');
  if (opts.out) writeCsv(opts.out, years, rows);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
