// Purchase invoice approval requests still in the queue (Pending / NeedsRevision) whose stored
// amount is not the invoice grand total (E5-R1). Dry run by default: prints every request that
// needs a fix or a manual look and, with --out, writes them as CSV for the accountant.
//   fix               --apply sets `amount` to the grand total (nothing else is written)
//   potonganMismatch  header potongan differs from the line deductions: approve now refuses the
//                     payload, so the approver asks the requester for a revision
//   invalidPayload    the payload no longer parses
// --apply needs --approved-by "<accountant name>"; the name is recorded on one audit row per
// corrected request (same transaction as the fix), in the CSV, which --apply always writes
// (default file name when --out is not given), and in the console output. The CSV is written once
// before the transaction (applied = no) so an unwritable path stops the run before anything commits.
// Run the dry run before deploying the E5-R1 change.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e5-pi-approval-amount.js [--out file.csv]
//   node dist/scripts/repair/e5-pi-approval-amount.js --apply --approved-by "<name>" [--out file.csv]
//   (or `npx tsx src/scripts/repair/e5-pi-approval-amount.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applyPiApprovalAmountFixes,
  planPiApprovalAmountFixes,
  type PiApprovalAmountRow,
} from '../../services/piApprovalAmountRepair';

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

function writeCsv(file: string, rows: readonly PiApprovalAmountRow[], applied: ReadonlySet<string>, approvedBy: string | null) {
  const header = 'request_id,status,created_at,requester,stored_amount,computed_amount,header_potongan,potongan_item_total,action,error,applied,approved_by';
  const lines = rows.map((r) =>
    [
      r.requestId, r.status, r.createdAt, r.requester, r.storedAmount, r.computedAmount, r.headerPotongan,
      r.potonganItemTotal, r.action, r.error, applied.has(r.requestId) ? 'yes' : 'no', applied.has(r.requestId) ? approvedBy : null,
    ]
      .map(csvCell)
      .join(','),
  );
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await planPiApprovalAmountFixes(prisma);
  const count = (action: PiApprovalAmountRow['action']) => plan.filter((r) => r.action === action).length;
  console.log(
    `Open purchase invoice approval requests to look at: ${plan.length} ` +
      `(fix ${count('fix')}, potonganMismatch ${count('potonganMismatch')}, invalidPayload ${count('invalidPayload')})`,
  );
  for (const r of plan) {
    console.log(`  ${r.action} ${r.requestId} [${r.status}] ${r.requester}: stored ${r.storedAmount} -> computed ${r.computedAmount}${r.error ? ` (${r.error})` : ''}`);
  }

  const out = opts.out ?? (opts.apply ? `e5-pi-approval-amount-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  let applied = new Set<string>();
  if (opts.apply && opts.approvedBy) {
    if (out) writeCsv(out, plan, applied, opts.approvedBy);
    const result = await prisma.$transaction((tx) => applyPiApprovalAmountFixes(tx, plan, opts.approvedBy as string));
    applied = new Set(result.applied);
    console.log(`Applied ${result.applied.length} amount fix(es), approved by ${result.approvedBy}.`);
    if (result.skipped.length > 0) console.log(`Skipped (changed since the plan): ${result.skipped.join(', ')}`);
  } else {
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to correct the fix rows.');
  }

  if (out) writeCsv(out, plan, applied, opts.approvedBy);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
