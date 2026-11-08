// One-time capture of the year-close checklist baseline (E1-R8, PR-8b). Ledger mismatches that
// already exist at release (checks ledger-balanced and ale-vs-journal, plus any later
// baseline-aware check) are written to close_check_baselines, so they no longer block a year close;
// a new mismatch, or a known one whose amount changes (beyond what the check's baselineCovers
// accepts), still blocks. Run it once at release, after
// the STT legacy-data fix (PR-6b) and after the accountant has reviewed the dry-run list.
//
// Dry run by default: it lists what would be captured and writes nothing. --apply writes the rows,
// one transaction per fiscal year. A second --apply is refused while the baseline already has rows,
// because a later capture would hide mismatches made after the release. A baseline-aware check that
// another epic registers later is captured on its own: --check <id> (repeatable) limits the run to
// the named checks, which must have no rows yet, and --allow-existing (only with --check)
// acknowledges the rows of the other checks, which stay as they are.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e1-close-baseline.js [--fy <name>] [--check <id> ...] [--apply [--allow-existing]] [--out file.csv]
//   (or `npx tsx src/scripts/repair/e1-close-baseline.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  assertBaselineCaptureAllowed,
  baselineCaptureChecks,
  captureCloseBaseline,
  type BaselineCapture,
} from '../../services/fiscalYearClose';
// The checks other modules register (ar-subledger, customer-deposit-subledger, ap-subledger), so --check knows them.
import '../../services/closeCheckPlugins';

interface Options {
  apply: boolean;
  allowExisting: boolean;
  /** Only these checks; undefined = every baseline-aware check. */
  checks: string[] | undefined;
  fy: string | null;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, allowExisting: false, checks: undefined, fy: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--allow-existing') opts.allowExisting = true;
    else if (a === '--check') {
      const id = argv[++i];
      if (!id) throw new Error('--check needs a check id');
      opts.checks = [...(opts.checks ?? []), id];
    } else if (a === '--fy') opts.fy = argv[++i] ?? null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.allowExisting && !opts.apply) throw new Error('--allow-existing only goes with --apply');
  if (opts.allowExisting && !opts.checks) throw new Error('--allow-existing only goes with --check <id>');
  return opts;
}

interface Row extends BaselineCapture {
  fiscalYear: string;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const years = await prisma.fiscalYear.findMany({
    where: opts.fy ? { name: opts.fy } : {},
    orderBy: { startDate: 'asc' },
  });
  if (opts.fy && years.length === 0) throw new Error(`No fiscal year named ${opts.fy}`);

  const checkIds = baselineCaptureChecks(opts.checks).map((c) => c.id);
  const existing = await prisma.closeCheckBaseline.count();
  if (opts.apply) await assertBaselineCaptureAllowed(prisma, { checkIds: opts.checks, allowExisting: opts.allowExisting });

  const rows: Row[] = [];
  for (const y of years) {
    const captured = await prisma.$transaction((tx) => captureCloseBaseline(tx, y, opts.apply, opts.checks), { timeout: 120_000 });
    rows.push(...captured.map((c) => ({ ...c, fiscalYear: y.name })));
  }

  if (opts.out) {
    const header = 'fiscal_year,check_id,item_key,kind,label,date,amount,already_in_baseline';
    const lines = rows.map((r) =>
      [r.fiscalYear, r.checkId, r.item.key, r.item.kind, r.item.label, r.item.date ?? '', r.item.amount ?? '', r.added ? 'no' : 'yes']
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }

  const added = rows.filter((r) => r.added);
  const mode = opts.apply ? 'APPLIED' : 'DRY RUN';
  console.log(`${mode}: ${added.length} new baseline item(s), ${rows.length - added.length} already in the baseline (${years.length} fiscal year(s), checks ${checkIds.join(', ')}, ${existing} row(s) before)`);
  for (const y of years) {
    const own = rows.filter((r) => r.fiscalYear === y.name);
    if (own.length === 0) {
      console.log(`  ${y.name}: no mismatches`);
      continue;
    }
    const checks = [...new Set(own.map((r) => r.checkId))];
    for (const checkId of checks) {
      const items = own.filter((r) => r.checkId === checkId);
      const total = items.reduce((s, r) => s.plus(r.item.amount ?? 0), new Prisma.Decimal(0));
      console.log(`  ${y.name} ${checkId}: ${items.length} item(s), total difference ${total.toFixed(2)}`);
      for (const r of items) console.log(`    ${r.item.label.padEnd(24)} ${(r.item.date ?? '').padEnd(10)} ${(r.item.amount ?? '').padStart(18)}${r.added ? '' : '  (already in baseline)'}`);
    }
  }
  if (!opts.apply && added.length > 0) console.log('Nothing written. Re-run with --apply after review.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
