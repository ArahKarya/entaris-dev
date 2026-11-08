// Party opening audit (E2-R13 migration, plan step 5 PR-5.13). Dry run by default: per party with
// an opening column or an opening the ledger still holds, the ledger opening per side (ledger −
// invoices − manual adjustment), the opening columns, the side's opening journals and payments, and
// a class (services/ledger/partyOpeningAudit.ts):
//   match, opening-from-single-journal, consumed-opening-not-restored, undirected-matches-gl,
//   both-direction-from-gl, both-needs-accountant, negative-opening, opening-off-side,
//   gl-without-opening, unexplained
// --apply --approved-by "<accountant name>" changes only opening-from-single-journal and
// consumed-opening-not-restored: the side's opening column takes the
// opening the ledger shows, the explained undirected rest goes to zero and the party is
// recalculated. The ledger does not change; a Both direction is corrected by the accountant with one
// manual journal. One audit row per party (via 'repair'). The CSV is written before the first batch
// (default file name when --out is not given) and again with the applied column at the end.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-party-opening-audit.js [--out file.csv]
//   node dist/scripts/repair/e2-party-opening-audit.js --apply --approved-by "<name>" [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-party-opening-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applyPartyOpeningAudit,
  planPartyOpeningAudit,
  PARTY_OPENING_APPLY_CLASSES,
  type PartyOpeningAuditRow,
  type PartyOpeningSide,
} from '../../services/ledger/partyOpeningAudit';
import { legacyUnassignedOf } from '../../services/ledger/partySides';

const BATCH_SIZE = 100;

interface Options {
  apply: boolean;
  approvedBy: string | null;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { apply: false, approvedBy: null, out: null };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]?.trim();
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--approved-by') opts.approvedBy = value(i++, a);
    else if (a === '--out') opts.out = value(i++, a);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  return opts;
}

const sideCells = (s: PartyOpeningSide) => [
  s.gl.toFixed(2), s.documents.toFixed(2), s.adjustment.toFixed(2), s.glOpening.toFixed(2), s.payments,
  s.cancelledPayments.toFixed(2), s.consumed.toFixed(2), s.journals ? s.journals.amount.toFixed(2) : null,
  s.journals ? s.journals.entryNumbers.join(' ') : null,
];

function writeCsv(file: string, plan: readonly PartyOpeningAuditRow[], applied: ReadonlySet<string>, approvedBy: string | null) {
  const side = (p: string) => [`${p}_gl`, `${p}_invoices`, `${p}_adjustment`, `${p}_gl_opening`, `${p}_payments`,
    `${p}_cancelled_payments`, `${p}_consumed`, `${p}_opening_journals_amount`, `${p}_opening_journals`];
  const header = [
    'party_id', 'name', 'party_type', 'is_dummy', 'class', 'opening_receivable', 'opening_payable', 'opening_outstanding',
    'legacy_unassigned', ...side('receivable'), ...side('payable'), 'target_receivable', 'target_payable', 'applied', 'approved_by',
  ].join(',');
  const lines = plan.map(({ figures: f, verdict: v }) => {
    const done = applied.has(f.partyId);
    return [
      f.partyId, f.name, f.partyType, f.isDummy ? 'yes' : 'no', v.cls, f.openingReceivable.toFixed(2), f.openingPayable.toFixed(2),
      f.openingOutstanding.toFixed(2), legacyUnassignedOf(f).toFixed(2), ...sideCells(f.receivable), ...sideCells(f.payable),
      v.target?.receivable.toFixed(2) ?? null, v.target?.payable.toFixed(2) ?? null, done ? 'yes' : 'no', done ? approvedBy : null,
    ].map(csvCell).join(',');
  });
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = await prisma.$transaction((tx) => planPartyOpeningAudit(tx), { timeout: 120000 });
  const counts = new Map<string, number>();
  for (const r of plan) counts.set(r.verdict.cls, (counts.get(r.verdict.cls) ?? 0) + 1);
  console.log(`Parties listed: ${plan.length}`);
  for (const [cls, n] of [...counts.entries()].sort()) console.log(`  ${cls}: ${n}${PARTY_OPENING_APPLY_CLASSES.has(cls as never) ? ' (--apply)' : ''}`);
  for (const { figures: f, verdict: v } of plan.filter((r) => r.verdict.cls !== 'match')) {
    console.log(
      `  ${f.name.padEnd(32)} ${f.partyType.padEnd(8)} ${v.cls.padEnd(30)} columns ${f.openingReceivable.toFixed(2)}/${f.openingPayable.toFixed(2)}` +
        ` undirected ${legacyUnassignedOf(f).toFixed(2)}  ledger ${f.receivable.glOpening.toFixed(2)}/${f.payable.glOpening.toFixed(2)}`,
    );
  }

  const out = opts.out ?? (opts.apply ? `e2-party-opening-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  const applied = new Set<string>();
  if (opts.apply) {
    if (out) writeCsv(out, plan, applied, opts.approvedBy);
    const ids = plan.filter((r) => PARTY_OPENING_APPLY_CLASSES.has(r.verdict.cls)).map((r) => r.figures.partyId);
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const done = await prisma.$transaction((tx) => applyPartyOpeningAudit(tx, batch, { approvedBy: opts.approvedBy }), { timeout: 120000 });
      for (const d of done) applied.add(d.partyId);
    }
    console.log(`Corrected the opening columns of ${applied.size} party(ies), approved by ${opts.approvedBy}.`);
  } else {
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to correct the apply classes.');
  }

  if (out) writeCsv(out, plan, applied, opts.approvedBy);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
