// Legacy STT cancel data to the paired model (E1-R6 migration, PR-6b, plan step 5 PR-5.2). Dry run
// by default: classifies every STT with a JV-<stt>-CXL journal (services/ledger/sttCancelLegacy.ts)
// and lists it; --out writes the list as CSV for the accountant.
//   A       original Cancelled with active ledger rows: --apply sets it Submitted, reversed by the
//           CXL. Ledger rows and balances stay, so no total moves (also in a closed year).
//   B       original's ledger rows cancelled too: only with --include-ale-fix, in open years after the
//           lock date. Also reactivates its ledger rows and adds its impact back to the stored
//           balances: Inventory and the uninvoiced payable change by the STT amount.
//   C       a journal booked to another fiscal year than its date: report only (owner decision #5d).
//   REVIEW  any other shape (column reason): report only.  PAIRED: already fixed.
// --apply needs --approved-by "<accountant name>"; the name goes on one audit row per fixed journal
// and in the CSV, which --apply always writes (default file name when --out is not given) before
// the transaction starts. A second run finds the fixed pairs PAIRED and writes nothing.
//
// Release order (plan §8): back up the database; do not run "recalculate balances" in the System
// Check before this; dry run and send the CSV to the accountant; --apply (A), then, if B is approved,
// --apply --include-ale-fix; dry run again (all PAIRED); only then capture the year-close baseline
// (e1-close-baseline.js).
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e1-stt-cancel-model.js [--fy <name>] [--out file.csv]
//   node dist/scripts/repair/e1-stt-cancel-model.js --apply --approved-by "<name>" [--include-ale-fix] [--fy <name>] [--out file.csv]
//   (or `npx tsx src/scripts/repair/e1-stt-cancel-model.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { findAleJournalMismatches } from '../../services/ledger/aleSyncCheck';
import {
  applySttCancelLegacy,
  legacyFixRuns,
  planSttCancelLegacy,
  SttCancelRefusal,
  type LegacySttRow,
  type LegacySttScope,
} from '../../services/ledger/sttCancelLegacy';
import { parseSttCancelArgs } from '../../services/ledger/sttCancelLegacyArgs';

const HEADER = [
  'stt_number', 'stt_status', 'class', 'reason', 'original_journal', 'original_status', 'original_date', 'original_year',
  'cxl_journal', 'cxl_status', 'cxl_date', 'cxl_year', 'amount', 'original_ale_active', 'original_ale_cancelled',
  'year_closed', 'locked', 'action', 'ledger_fix_blocked', 'ale_sync_fix_after_cancel', 'applied', 'approved_by',
].join(',');

type Runs = { aleSync: Date[]; balanceDrift: Date[] };

function writeCsv(file: string, rows: readonly LegacySttRow[], runs: Runs, applied: ReadonlyMap<string, string>, approvedBy: string | null) {
  const lines = rows.map((r) => {
    const cancelledAt = r.original?.cancelledAt;
    const syncAfter = cancelledAt ? runs.aleSync.some((t) => t > cancelledAt) : null;
    const done = applied.get(r.sttNumber) ?? 'no';
    return [
      r.sttNumber, r.sttStatus, r.cls, r.reason, r.original?.entryNumber ?? null, r.original?.status ?? null, r.original?.day ?? null,
      r.original?.fiscalYearName ?? null, r.cxl.entryNumber, r.cxl.status, r.cxl.day, r.cxl.fiscalYearName, r.amount.toFixed(2),
      r.originalAleActive, r.originalAleCancelled, !!r.original?.yearClosed || r.cxl.yearClosed, r.locked, r.action,
      r.ledgerFixBlocked, syncAfter, done, done.startsWith('fixed') ? approvedBy : null,
    ].map(csvCell).join(',');
  });
  writeFileSync(file, `${[HEADER, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

function printPlan(rows: readonly LegacySttRow[], runs: Runs) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.cls, (counts.get(r.cls) ?? 0) + 1);
  console.log(`STTs with a -CXL journal: ${rows.length}`);
  for (const [cls, n] of [...counts.entries()].sort()) console.log(`  ${cls}: ${n}`);
  for (const r of rows.filter((x) => x.cls !== 'PAIRED')) {
    const blocked = r.ledgerFixBlocked ? `, ledger fix blocked: ${r.ledgerFixBlocked}` : '';
    console.log(`  ${r.sttNumber} ${r.cls}${r.reason ? ` (${r.reason})` : ''} ${r.amount.toFixed(2)}${blocked}`);
  }
  const last = (d: Date[]) => (d.length ? d[d.length - 1]!.toISOString() : 'never');
  console.log(`Old health-check fixes: ALE sync ${runs.aleSync.length}x (last ${last(runs.aleSync)}), balance drift ${runs.balanceDrift.length}x (last ${last(runs.balanceDrift)})`);
}

/** The ledger check for the journals of every pair: 0 once A and B are fixed. */
async function printLedgerLeft(plan: readonly LegacySttRow[]) {
  const journalIds = plan.flatMap((r) => (r.original ? [r.original.id, r.cxl.id] : [r.cxl.id]));
  const left = await prisma.$transaction((tx) => findAleJournalMismatches(tx, { journalIds }), { timeout: 60000 });
  console.log(`ALE vs journal mismatches on these journals: ${left.total}`);
  for (const r of left.rows) console.log(`  ${r.entryNumber ?? r.journalId} ${r.cause} ${r.difference.toFixed(2)} (${r.fiscalYearName ?? '-'})`);
}

async function main() {
  const opts = parseSttCancelArgs(process.argv.slice(2));
  const scope: LegacySttScope = {};
  if (opts.fiscalYear) {
    const fy = await prisma.fiscalYear.findFirst({ where: { name: opts.fiscalYear }, select: { id: true } });
    if (!fy) throw new SttCancelRefusal(`No fiscal year named ${opts.fiscalYear}`);
    scope.fiscalYearId = fy.id;
  }

  const [plan, runs] = await prisma.$transaction((tx) => Promise.all([planSttCancelLegacy(tx, scope), legacyFixRuns(tx)]), { timeout: 60000 });
  printPlan(plan, runs);
  const out = opts.out ?? (opts.apply ? `e1-stt-cancel-model-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  const applied = new Map<string, string>();

  if (!opts.apply) {
    if (out) writeCsv(out, plan, runs, applied, null);
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to fix class A (add --include-ale-fix for B).');
    await printLedgerLeft(plan);
    return;
  }

  if (out) writeCsv(out, plan, runs, applied, opts.approvedBy);
  const result = await prisma.$transaction(
    (tx) => applySttCancelLegacy(tx, plan, { approvedBy: opts.approvedBy!, includeAleFix: opts.includeAleFix }),
    { timeout: 60000 },
  );
  for (const n of result.fixed) applied.set(n, 'fixed');
  for (const n of result.ledgerFixed) applied.set(n, 'fixed-ledger');
  for (const s of result.skipped) applied.set(s.sttNumber, `skipped: ${s.why}`);
  console.log(`Fixed ${result.fixed.length} class A and ${result.ledgerFixed.length} class B pair(s), approved by ${result.approvedBy}.`);
  for (const s of result.skipped) console.log(`  skipped ${s.sttNumber}: ${s.why}`);
  if (out) writeCsv(out, plan, runs, applied, opts.approvedBy);

  await printLedgerLeft(plan);
}

main()
  .catch((e) => {
    if (e instanceof SttCancelRefusal) console.error(e.message);
    else console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
