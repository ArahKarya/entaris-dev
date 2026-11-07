// Chart-of-accounts structure check (E2-R6). Dry run by default: lists accounts whose stored type
// disagrees with their number or their parent, and with --out writes them as CSV for the accountant.
//   revenueAsExpense    7.x stored as EXPENSE: --apply sets REVENUE (the only change this script makes)
//   rootTypeVsPrefix    root type differs from the number's first digit: fix by hand
//   childVsParent       root type differs from the parent's: fix by hand
//   groupWithLedger, inactiveWithLedger, dottedOrphan   information only
// The repair changes how an amount is presented, not the profit of any fiscal year. accounts.balance
// is recalculated from the ledger rows of every year. An account with ledger rows in a CLOSED year is not
// touched unless --include-closed-years acknowledges that those years then show the amount as revenue.
// --apply needs --approved-by "<accountant name>"; the name goes on one audit row per account and in
// the CSV, which --apply always writes (default file name when --out is not given) before the
// transaction starts, so an unwritable path stops the run before anything commits.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-coa-structure-check.js [--out file.csv]
//   node dist/scripts/repair/e2-coa-structure-check.js --apply --approved-by "<name>" [--include-closed-years] [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-coa-structure-check.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applyCoaStructureRepair,
  CoaRepairRefusal,
  planCoaStructureCheck,
  type CoaFindingRow,
} from '../../services/coa/coaStructureRepair';

interface Options {
  apply: boolean;
  approvedBy: string | null;
  includeClosedYears: boolean;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, approvedBy: null, includeClosedYears: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--approved-by') opts.approvedBy = argv[++i]?.trim() || null;
    else if (a === '--include-closed-years') opts.includeClosedYears = true;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.includeClosedYears && !opts.apply) throw new Error('--include-closed-years only goes with --apply');
  return opts;
}

function writeCsv(file: string, rows: readonly CoaFindingRow[], applied: ReadonlySet<string>, approvedBy: string | null) {
  const header = 'kind,action,account_number,name,root_type,account_type,expected_root_type,parent_number,ledger_rows,closed_year_ledger_rows,balance,applied,approved_by';
  const lines = rows.map((r) => {
    const done = r.action === 'fix' && applied.has(r.accountNumber);
    return [
      r.kind, r.action, r.accountNumber, r.name, r.rootType, r.accountType, r.expectedRootType, r.parentNumber,
      r.ledgerRows, r.closedYearLedgerRows, r.balance, done ? 'yes' : 'no', done ? approvedBy : null,
    ]
      .map(csvCell)
      .join(',');
  });
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await planCoaStructureCheck(prisma);
  const count = (action: CoaFindingRow['action']) => plan.filter((r) => r.action === action).length;
  console.log(`Chart of accounts findings: ${plan.length} (fix ${count('fix')}, manual ${count('manual')}, info ${count('info')})`);
  for (const r of plan) {
    const closed = r.closedYearLedgerRows > 0 ? ` [${r.closedYearLedgerRows} ledger row(s) in closed years]` : '';
    console.log(`  ${r.action} ${r.kind} ${r.accountNumber} ${r.name}: ${r.rootType}${r.expectedRootType ? ` -> ${r.expectedRootType}` : ''}${closed}`);
  }

  const out = opts.out ?? (opts.apply ? `e2-coa-structure-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  let applied = new Set<string>();
  if (opts.apply && opts.approvedBy) {
    if (out) writeCsv(out, plan, applied, opts.approvedBy);
    const result = await prisma.$transaction(
      (tx) => applyCoaStructureRepair(tx, plan, { approvedBy: opts.approvedBy as string, includeClosedYears: opts.includeClosedYears }),
      { timeout: 60000 },
    );
    applied = new Set(result.applied);
    console.log(`Re-typed ${result.applied.length} account(s) to REVENUE, approved by ${result.approvedBy}.`);
    if (result.skipped.length > 0) console.log(`Skipped (changed since the plan): ${result.skipped.join(', ')}`);
  } else {
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to re-type the fix rows.');
  }

  if (out) writeCsv(out, plan, applied, opts.approvedBy);
}

main()
  .catch((e) => {
    if (e instanceof CoaRepairRefusal) console.error(e.message);
    else console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
