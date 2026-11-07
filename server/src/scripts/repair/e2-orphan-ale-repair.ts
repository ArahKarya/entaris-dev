// Orphan ledger rows (E2-R14). Dry run by default: lists every active ledger row group whose
// JournalEntry, StockMovement or StockOpname no longer exists, per reference, with its fiscal years:
//   repair            JournalEntry in an open fiscal year outside the period lock: --apply cancels it
//   closed-year       dated in or tagged with a closed fiscal year: report only, correct by journal
//                     in an open period
//   period-locked     on or before the period lock date: report only (move the lock back first)
//   no-fiscal-year    a row date that no fiscal year covers: report only
//   stock-reference   StockMovement/StockOpname rows: report only (no code writes these any more)
// --apply cancels each repair group as a whole (is_cancelled = true, rows stay) and recalculates
// accounts.balance of the touched accounts from the ledger, except revenue/expense accounts while
// a fiscal year is closed: those only lose the cancelled rows' amount, since until PR-5.5 their
// stored balance leaves out the closed years (e2-stored-balance-recalc reports that). It needs --approved-by "<accountant
// name>"; the name goes on one audit row per group and in the CSV, which --apply always writes
// (default file name when --out is not given) before the transaction starts.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-orphan-ale-repair.js [--out file.csv]
//   node dist/scripts/repair/e2-orphan-ale-repair.js --apply --approved-by "<name>" [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-orphan-ale-repair.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applyOrphanAleRepair,
  orphanKey,
  planOrphanAleRepair,
  type OrphanAleGroup,
} from '../../services/ledger/orphanAleRepair';

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

function writeCsv(file: string, plan: readonly OrphanAleGroup[], applied: ReadonlySet<string>, approvedBy: string | null) {
  const header = 'reference_type,reference_id,action,rows,debit,credit,first_date,last_date,fiscal_years,year_closed,accounts,applied,approved_by';
  const lines = plan.map((g) => {
    const done = applied.has(orphanKey(g));
    return [
      g.referenceType, g.referenceId, g.action, g.rows, g.debit.toFixed(2), g.credit.toFixed(2),
      g.firstDate, g.lastDate, g.fiscalYearNames.join(';'), g.yearClosed ? 'yes' : 'no', g.accountNumbers.join(';'),
      done ? 'yes' : 'no', done ? approvedBy : null,
    ].map(csvCell).join(',');
  });
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await prisma.$transaction((tx) => planOrphanAleRepair(tx), { timeout: 60000 });
  const count = (action: OrphanAleGroup['action']) => plan.filter((g) => g.action === action).length;
  console.log(
    `Orphan ledger groups: ${plan.length} (repair ${count('repair')}, closed-year ${count('closed-year')}, ` +
      `period-locked ${count('period-locked')}, no-fiscal-year ${count('no-fiscal-year')}, stock-reference ${count('stock-reference')})`,
  );
  for (const g of plan) {
    console.log(`  ${g.action} ${orphanKey(g)}: ${g.rows} row(s), debit ${g.debit.toFixed(2)}, credit ${g.credit.toFixed(2)}, ${g.fiscalYearNames.join('/')}`);
  }

  const out = opts.out ?? (opts.apply ? `e2-orphan-ale-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  let applied = new Set<string>();
  if (opts.apply && opts.approvedBy) {
    if (out) writeCsv(out, plan, applied, opts.approvedBy);
    const result = await prisma.$transaction(
      (tx) => applyOrphanAleRepair(tx, plan, { approvedBy: opts.approvedBy as string }),
      { timeout: 60000 },
    );
    applied = new Set(result.applied);
    console.log(`Cancelled ${result.applied.length} orphan group(s), approved by ${result.approvedBy}.`);
    if (result.rebalanced.length > 0) console.log(`Stored balance recalculated: ${result.rebalanced.join(', ')}`);
    if (result.adjusted.length > 0) {
      console.log(`Stored balance moved by the cancelled rows only (a fiscal year is closed): ${result.adjusted.join(', ')}`);
    }
    for (const s of result.skipped) console.log(`Skipped ${s.key}: ${s.reason}`);
  } else {
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to cancel the repair groups.');
  }

  if (out) writeCsv(out, plan, applied, opts.approvedBy);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
