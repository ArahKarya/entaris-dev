// Item vs warehouse quantity drift (owner decision #18, PR-6.3d): the gate before the value ledger.
// Dry run (default): lists every item whose total stock differs from the sum of its warehouse rows,
// with the average, the value carried without warehouse stock and the active movements without a
// warehouse that usually explain it. --out writes that list as the plan CSV: per item the
// accountant fills in `action` (assign | writeoff), `warehouse_code` and `quantity` from a count
// per warehouse (rules in services/inventory/stockDriftPlan.ts). The script never decides.
//
// --plan <csv> reads the filled-in plan and runs it in a transaction that is rolled back (shows
// the journals, refuses a stale plan or an unusable Inventory Variance account); with --apply
// --approved-by "<accountant name>" it commits: assign books the quantity into the warehouse (no
// journal, value kept); writeoff posts an Adjustment − at the average, DR Inventory Variance /
// CR the item's inventory account, dated today (WIB) in an open period. One audit row per item.
// --apply writes its result CSV (default name when --out is not given) before the transaction.
// Afterwards the dry run must list 0 items.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e3-stock-drift.js [--out drift.csv]
//   node dist/scripts/repair/e3-stock-drift.js --plan drift.csv [--apply --approved-by "<name>"] [--out result.csv]
//   (or `npx tsx src/scripts/repair/e3-stock-drift.ts …` from a source checkout)

import { readFileSync, writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { parseDriftPlanCsv, DRIFT_PLAN_COLUMNS, type DriftItemPlan } from '../../services/inventory/stockDriftPlan';
import { applyStockDriftPlan, findStockDrift, type DriftApplyResult } from '../../services/inventory/stockDriftRepair';

interface Options {
  apply: boolean;
  approvedBy: string | null;
  plan: string | null;
  out: string | null;
}

class DryRunRollback extends Error {
  constructor(readonly result: DriftApplyResult) {
    super('dry run rollback');
  }
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, approvedBy: null, plan: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--approved-by') opts.approvedBy = argv[++i]?.trim() || null;
    else if (a === '--plan') opts.plan = argv[++i] ?? null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.apply && !opts.plan) throw new Error('--apply needs --plan <csv> filled in by the accountant');
  return opts;
}

async function report(out: string | null): Promise<void> {
  const rows = await findStockDrift(prisma);
  if (out) {
    const header = ['item_code', 'item_name', 'unit', 'item_qty', 'warehouse_qty', 'average_cost', 'drift_value',
      'unwarehoused_movements', 'unwarehoused_net_qty', 'warehouses', ...DRIFT_PLAN_COLUMNS].join(',');
    const lines = rows.map((r) => [
      r.code, r.name, r.unit, r.itemQty.toString(), r.warehouseQty.toString(), r.averageCost.toFixed(2), r.driftValue.toFixed(2),
      r.unwarehousedMovements, r.unwarehousedNetQty.toString(), r.warehouses,
      r.itemId, r.drift.toString(), null, null, null,
    ].map(csvCell).join(','));
    writeFileSync(out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${out}`);
  }
  const value = rows.reduce((sum, r) => sum.plus(r.driftValue), new Decimal(0));
  console.log(`READ ONLY: ${rows.length} item(s) whose total differs from the sum of their warehouses, value ${value.toFixed(2)}`);
  for (const r of rows) {
    console.log(`  ${r.code} ${r.name}: item ${r.itemQty} vs warehouses ${r.warehouseQty} -> drift ${r.drift} ${r.unit} x ${r.averageCost.toFixed(2)} = ${r.driftValue.toFixed(2)}`
      + ` (${r.unwarehousedMovements} active movement(s) without a warehouse, net ${r.unwarehousedNetQty})`);
  }
}

function writeResult(file: string, items: readonly DriftItemPlan[], result: DriftApplyResult | null, approvedBy: string | null) {
  const done = new Map((result?.items ?? []).map((r) => [r.itemId, r]));
  const header = 'item_id,item_code,drift,assigned,written_off,write_off_value,movement_id,journal_entry_id,applied,approved_by';
  const lines = items.map((p) => {
    const r = done.get(p.itemId);
    return [
      p.itemId, r?.code, p.drift.toString(), p.assignments.map((a) => `${a.warehouseCode}:${a.quantity.toString()}`).join(';'),
      p.writeOff.toString(), r?.writeOffValue.toFixed(2), r?.movementId, r?.journalEntryId, r ? 'yes' : 'no', r ? approvedBy : null,
    ].map(csvCell).join(',');
  });
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

function printResult(result: DriftApplyResult, committed: boolean) {
  console.log(`${committed ? 'APPLIED' : 'DRY RUN (rolled back)'}: ${result.items.length} item(s), dated ${result.day}, approved by ${result.approvedBy}`);
  for (const r of result.items) {
    const assigned = r.assigned.map((a) => `${a.quantity} to ${a.warehouseCode}`).join(', ') || 'none';
    console.log(`  ${r.code}: assigned ${assigned}; written off ${r.writtenOff} (value ${r.writeOffValue.toFixed(2)}${r.journalEntryId ? ', journal posted' : ''})`);
  }
}

async function runPlan(opts: Options & { plan: string }): Promise<void> {
  const plan = parseDriftPlanCsv(readFileSync(opts.plan, 'utf8'));
  console.log(`Plan ${opts.plan}: ${plan.items.length} decided item(s), ${plan.blank} undecided row(s)`);
  if (plan.errors.length > 0) {
    for (const e of plan.errors) console.error(`  ${e}`);
    throw new Error('The plan has errors; nothing was applied.');
  }
  const approvedBy = opts.approvedBy ?? 'dry run';
  if (!opts.apply) {
    try {
      await prisma.$transaction(async (tx) => {
        throw new DryRunRollback(await applyStockDriftPlan(tx, plan.items, { approvedBy }));
      }, { timeout: 60000 });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
      printResult(e.result, false);
    }
    console.log('Nothing written. Pass --apply --approved-by "<accountant name>" to apply the plan.');
    return;
  }
  const out = opts.out ?? `e3-stock-drift-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  writeResult(out, plan.items, null, approvedBy);
  const result = await prisma.$transaction((tx) => applyStockDriftPlan(tx, plan.items, { approvedBy }), { timeout: 60000 });
  printResult(result, true);
  writeResult(out, plan.items, result, approvedBy);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.plan) await runPlan({ ...opts, plan: opts.plan });
  else await report(opts.out);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
