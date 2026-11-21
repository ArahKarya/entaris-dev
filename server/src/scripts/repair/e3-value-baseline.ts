// Valuation baseline of the inventory value ledger (E3-R6, PR-6.4b1). Runs the data part of the
// migration prisma/migrations/20261112200000_inventory_value_ledger/migration.sql (the one source of
// that SQL, services/inventory/valueBaselineSql.ts) and reports what it would add: the value_delta
// backfill, a Revaluation per live purchase invoice delta on an STT receipt, and a 'ValuationBaseline'
// Revaluation per item whose stock_value its movements do not explain (no journal).
//
// Dry run (default): runs it in a transaction that is rolled back. After the deploy it must report 0
// new rows (§8 step 9); a gap means a path wrote stock without value. --out writes the rows as CSV.
// --apply --approved-by "<accountant name>" --not-production commits it, with one audit row per new
// row: dev/staging only (a database that ran mixed code during the value-ledger train). Every deployed
// container runs with NODE_ENV=production, staging included, so the operator states it with
// --not-production; on production the migration writes the baseline and a gap afterwards is fixed at
// its cause, never with an unjournaled row. --apply writes its CSV (default name when --out is not
// given) before the committing transaction and refuses when that run differs from the dry run.
//
// Every run also lists, read-only: live purchase invoices with a price revision whose delta the
// baseline absorbed (no Revaluation row, see the migration's step 3), and items whose last baseline
// is dated before movements that already existed when it was written (decision #19; must be empty on
// the dump rehearsal, §8 7c).
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e3-value-baseline.js [--out baseline.csv]
//   node dist/scripts/repair/e3-value-baseline.js --apply --approved-by "<name>" --not-production [--out result.csv]
//   (or `npx tsx src/scripts/repair/e3-value-baseline.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  auditValueBaselineRows,
  findValueBaselineNotes,
  readValueBaselineSql,
  runValueBaselineData,
  type ValueBaselineNotes,
  type ValueBaselineReport,
} from '../../services/inventory/valueBaselineSql';

interface Options {
  apply: boolean;
  notProduction: boolean;
  approvedBy: string | null;
  out: string | null;
}

class DryRunRollback extends Error {
  constructor(readonly report: ValueBaselineReport) {
    super('dry run rollback');
  }
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, notProduction: false, approvedBy: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--not-production') opts.notProduction = true;
    else if (a === '--approved-by') opts.approvedBy = argv[++i]?.trim() || null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.apply && !opts.notProduction) {
    throw new Error('--apply is for dev/staging only: add --not-production to confirm this is not the production database (there the migration writes the baseline).');
  }
  return opts;
}

function writeCsv(file: string, report: ValueBaselineReport, applied: boolean, approvedBy: string | null) {
  const header = 'movement_number,item_code,day,value_delta,reference_type,reference_number,adjusts_movement_id,applied,approved_by';
  const lines = report.newRows.map((r) => [
    r.movementNumber, r.itemCode, r.date.toISOString().slice(0, 10), r.valueDelta.toFixed(2),
    r.referenceType, r.referenceNumber, r.adjustsMovementId, applied ? 'yes' : 'no', applied ? approvedBy : null,
  ].map(csvCell).join(','));
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

function printReport(report: ValueBaselineReport, committed: boolean) {
  const net = report.newRows.reduce((sum, r) => sum.plus(r.valueDelta), new Decimal(0));
  console.log(`${committed ? 'APPLIED' : 'DRY RUN (rolled back)'}: ${report.newRows.length} new Revaluation row(s), net ${net.toFixed(2)}; `
    + `${report.backfilled} movement value(s) backfilled; ${report.stockValueChanges.length} item stock value(s) set`);
  for (const r of report.newRows) {
    console.log(`  ${r.movementNumber} ${r.itemCode} ${r.date.toISOString().slice(0, 10)}: ${r.valueDelta.toFixed(2)} (${r.referenceType ?? '-'}${r.referenceNumber ? ` ${r.referenceNumber}` : ''})`);
  }
  for (const c of report.stockValueChanges) {
    console.log(`  stock value ${c.itemCode}: ${c.before.toFixed(2)} -> ${c.after.toFixed(2)}`);
  }
}

function printNotes(notes: ValueBaselineNotes) {
  if (notes.revisedInvoices.length > 0) {
    console.log(`${notes.revisedInvoices.length} STT receipt(s) of a revised purchase invoice, delta in the baseline (no Revaluation row):`);
    for (const r of notes.revisedInvoices) console.log(`  ${r.invoiceNumber} ${r.movementNumber} ${r.itemCode}: ${r.delta.toFixed(2)}`);
  }
  if (notes.movementsAfterBaseline.length > 0) {
    console.log(`${notes.movementsAfterBaseline.length} item(s) whose baseline is dated before movements older than it (decision #19):`);
    for (const r of notes.movementsAfterBaseline) {
      console.log(`  ${r.itemCode} ${r.baselineNumber} ${r.baselineDate.toISOString().slice(0, 10)}: ${r.movements} movement(s) after it`);
    }
  }
}

async function dryRun(sql: string): Promise<ValueBaselineReport> {
  try {
    await prisma.$transaction(async (tx) => {
      const report = await runValueBaselineData(tx, sql);
      printNotes(await findValueBaselineNotes(tx));
      throw new DryRunRollback(report);
    }, { timeout: 120000 });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.report;
    throw e;
  }
  throw new Error('dry run did not roll back');
}

const fingerprint = (r: ValueBaselineReport) =>
  r.newRows.map((row) => `${row.movementNumber}:${row.valueDelta.toFixed(2)}`).join('|');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sql = readValueBaselineSql();
  const preview = await dryRun(sql);
  if (!opts.apply) {
    printReport(preview, false);
    if (opts.out) writeCsv(opts.out, preview, false, null);
    console.log(preview.newRows.length === 0
      ? 'Clean: every item stock value is explained by its movements.'
      : 'Nothing written. Pass --apply --approved-by "<accountant name>" on dev/staging to write these rows.');
    return;
  }
  const approvedBy = opts.approvedBy as string;
  const out = opts.out ?? `e3-value-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  writeCsv(out, preview, false, approvedBy);
  const report = await prisma.$transaction(async (tx) => {
    const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' } });
    if (!admin) throw new Error('No active Admin user to record the audit rows under.');
    const result = await runValueBaselineData(tx, sql);
    if (fingerprint(result) !== fingerprint(preview)) {
      throw new Error('The data changed since the dry run; nothing was applied. Run the script again.');
    }
    await auditValueBaselineRows(tx, result, { userId: admin.id, approvedBy });
    return result;
  }, { timeout: 120000 });
  printReport(report, true);
  writeCsv(out, report, true, approvedBy);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
