// Party balances per side (E2-R13, PR-5.9a). Run once in the release that ships the migration
// 20261110100000_party_side_balances: the migration fills receivable_outstanding and
// payable_outstanding without the manual party adjustment. Dry run by default: lists every party
// whose stored receivable, payable or outstanding differs from services/ledger/partySides.ts
// computePartySides (what recalcPartyOutstanding writes), and the opening checks per party:
//   negative-opening-side  opening_receivable or opening_payable below zero
//   opening-off-side       an opening amount on a side the party type does not have
//   legacy-unassigned      opening not directed to a side (Both, negative, possibly cut by a payment
//                          remainder); it still counts in outstanding, the accountant reviews it
//                          with e2-party-opening-audit (PR-5.13)
// --apply rewrites the derived columns in batches (the ledger and the opening columns do not
// change), one audit row per changed party. --approved-by "<name>" is optional here (no ledger
// change) and is recorded when given. The CSV is written before the first batch.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-party-side-recalc.js [--out file.csv]
//   node dist/scripts/repair/e2-party-side-recalc.js --apply [--approved-by "<name>"] [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-party-side-recalc.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { applyPartySideRecalc, planPartySideRecalc, type PartySideRecalcRow } from '../../services/ledger/partySides';

const BATCH_SIZE = 200;

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
  return opts;
}

function writeCsv(file: string, plan: readonly PartySideRecalcRow[], applied: ReadonlySet<string>, approvedBy: string | null) {
  const header = [
    'party_id', 'name', 'party_type', 'is_dummy', 'stored_receivable', 'stored_payable', 'stored_outstanding',
    'computed_receivable', 'computed_payable', 'computed_outstanding', 'opening_outstanding', 'opening_receivable',
    'opening_payable', 'legacy_unassigned', 'changes', 'issues', 'applied', 'approved_by',
  ].join(',');
  const lines = plan.map((r) => {
    const done = applied.has(r.partyId);
    return [
      r.partyId, r.name, r.partyType, r.isDummy ? 'yes' : 'no',
      r.stored.receivable.toFixed(2), r.stored.payable.toFixed(2), r.stored.outstanding.toFixed(2),
      r.computed.receivable.toFixed(2), r.computed.payable.toFixed(2), r.computed.outstanding.toFixed(2),
      r.openingOutstanding.toFixed(2), r.openingReceivable.toFixed(2), r.openingPayable.toFixed(2), r.legacyUnassigned.toFixed(2),
      r.changes ? 'yes' : 'no', r.issues.join(';'), done ? 'yes' : 'no', done ? approvedBy : null,
    ].map(csvCell).join(',');
  });
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await prisma.$transaction((tx) => planPartySideRecalc(tx), { timeout: 120000 });
  const toChange = plan.filter((r) => r.changes);
  const count = (issue: PartySideRecalcRow['issues'][number]) => plan.filter((r) => r.issues.includes(issue)).length;
  console.log(
    `Parties listed: ${plan.length} (columns to rewrite ${toChange.length}, legacy-unassigned ${count('legacy-unassigned')}, ` +
      `opening-off-side ${count('opening-off-side')}, negative-opening-side ${count('negative-opening-side')})`,
  );
  for (const r of plan) {
    console.log(
      `  ${r.name.padEnd(32)} ${r.partyType.padEnd(8)} stored ${r.stored.receivable.toFixed(2)}/${r.stored.payable.toFixed(2)}` +
        `  computed ${r.computed.receivable.toFixed(2)}/${r.computed.payable.toFixed(2)}  ${r.issues.join(',')}`,
    );
  }

  const out = opts.out ?? (opts.apply ? `e2-party-side-recalc-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  const applied = new Set<string>();
  if (opts.apply) {
    if (out) writeCsv(out, plan, applied, opts.approvedBy);
    const ids = toChange.map((r) => r.partyId);
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const changed = await prisma.$transaction(
        (tx) => applyPartySideRecalc(tx, batch, { approvedBy: opts.approvedBy }),
        { timeout: 120000 },
      );
      for (const id of changed) applied.add(id);
    }
    console.log(`Rewrote the side columns of ${applied.size} party(ies)${opts.approvedBy ? `, approved by ${opts.approvedBy}` : ''}.`);
  } else {
    console.log('Dry run: nothing written. Pass --apply to rewrite the side columns.');
  }

  if (out) writeCsv(out, plan, applied, opts.approvedBy);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
