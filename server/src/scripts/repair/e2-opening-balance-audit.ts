// Legacy opening-balance audit (E2-R11 migration, plan step 5 PR-5.6). Dry run by default: lists
// every active opening journal without a sourceKey per target with its class, the active
// non-opening journals against OPENING_EQUITY (opening balances recorded another way), duplicate
// active OPENING/RECURRING sourceKeys and parties whose opening_outstanding differs from their
// opening journals; --out writes all of it as one CSV (column `section`) for the accountant.
//   single-two-line-opening  only opening of its target, target + OPENING_EQUITY, no earlier
//                            activity on the target: --apply gives it its sourceKey
//   patch-delta, multi, multi-line, deposit-legacy, refused-account, not-submitted
//                            CSV only; the accountant keys one with --key-journal <number>
// Keying sets source_key (OPENING:ACCOUNT:<id> / OPENING:PARTY:<id>:<kind>) and source_type OPENING
// when it is NULL; a journal owned by a deposit Payment is refused (replaced through the deposit, PR-5.11);
// no ledger row, balance or date changes. Until a journal is keyed, the opening-balance service
// refuses to replace that target's opening (OPENING_LEGACY_REVIEW).
// --apply needs --approved-by "<accountant name>"; the name goes on one audit row per keyed journal
// and in the CSV, which --apply always writes (default file name when --out is not given) before
// the transaction starts. --key-journal without --apply only checks the named journals.
// Exit code 1 while duplicate active keys exist: the gate of the unique index (PR-5.14).
// --check-duplicates runs only that check (for deploy.sh).
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-opening-balance-audit.js [--out file.csv] [--key-journal <number> ...]
//   node dist/scripts/repair/e2-opening-balance-audit.js --apply --approved-by "<name>" [--key-journal <number> ...] [--out file.csv]
//   node dist/scripts/repair/e2-opening-balance-audit.js --check-duplicates
//   (or `npx tsx src/scripts/repair/e2-opening-balance-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applyOpeningKeys,
  findActiveDuplicateKeys,
  OpeningAuditRefusal,
  planOpeningBalanceAudit,
  type DuplicateKeyRow,
  type OpeningAuditReport,
} from '../../services/ledger/openingBalanceAudit';
import { openingAuditExitCode, parseOpeningAuditArgs } from '../../services/ledger/openingBalanceAuditArgs';

const HEADER = [
  'section', 'class', 'journal_id', 'entry_number', 'date', 'status', 'source_type', 'detection', 'narration',
  'target_kind', 'subledger', 'account_number', 'account_name', 'party_name', 'amount', 'line_count',
  'after_cutover', 'prior_activity', 'openings_for_target', 'fiscal_year_closed', 'rule_problem',
  'source_key', 'expected', 'difference', 'applied', 'approved_by',
].join(',');

function writeCsv(file: string, report: OpeningAuditReport, keyed: ReadonlySet<string>, approvedBy: string | null) {
  const line = (cells: unknown[]) => cells.map(csvCell).join(',');
  const lines = [
    ...report.openings.map((r) => {
      const done = keyed.has(r.journalId);
      return line([
        'legacy-opening', r.cls, r.journalId, r.entryNumber, r.day, r.status, r.sourceType, r.detection, r.narration,
        r.target?.kind ?? null, r.target?.kind === 'PARTY' ? r.target.subledger : null, r.accountNumber, r.accountName,
        r.partyName, r.amount.toFixed(2), r.lineCount, r.afterCutover, r.priorActivity, r.openingsForTarget,
        r.fiscalYearClosed, r.ruleProblem, r.proposedKey, null, null, done ? 'yes' : 'no', done ? approvedBy : null,
      ]);
    }),
    ...report.equityCounters.map((r) => line([
      'equity-counter', r.nearCutover ? 'near-cutover' : 'later', r.journalId, r.entryNumber, r.day, r.status, r.sourceType,
      null, r.narration, 'ACCOUNT', null, r.accountNumber, r.accountName, null, r.amount.toFixed(2), null, null, null,
      null, null, null, null, null, null, 'no', null,
    ])),
    ...report.duplicates.map((r) => line([
      'duplicate-key', r.sourceType, null, r.entryNumbers.join(' '), null, null, r.sourceType, null, null, null, null,
      null, null, null, null, r.entryNumbers.length, null, null, null, null, null, r.sourceKey, null, null, 'no', null,
    ])),
    ...report.parties.map((r) => line([
      'party-opening', r.partyType, null, null, null, null, null, null, null, 'PARTY', null, null, null, r.name,
      r.openingOutstanding.toFixed(2), null, null, null, null, null, null, null, r.fromJournals.toFixed(2),
      r.difference.toFixed(2), 'no', null,
    ])),
  ];
  writeFileSync(file, `${[HEADER, ...lines].join('\n')}\n`, 'utf8');
  console.log(`CSV: ${file}`);
}

function printDuplicates(duplicates: readonly DuplicateKeyRow[]) {
  console.log(`Duplicate active OPENING/RECURRING sourceKeys: ${duplicates.length}`);
  for (const d of duplicates) console.log(`  ${d.sourceType} ${d.sourceKey}: ${d.entryNumbers.join(', ')}`);
}

function printReport(report: OpeningAuditReport) {
  console.log(`Cut-over day used: ${report.cutoverDay ?? '(no open fiscal year)'}`);
  const counts = new Map<string, number>();
  for (const r of report.openings) counts.set(r.cls, (counts.get(r.cls) ?? 0) + 1);
  console.log(`Legacy opening journals (per target): ${report.openings.length}`);
  for (const [cls, n] of [...counts.entries()].sort()) console.log(`  ${cls}: ${n}`);
  const near = report.equityCounters.filter((r) => r.nearCutover).length;
  console.log(`Non-opening journal lines against OPENING_EQUITY: ${report.equityCounters.length} (${near} near the cut-over)`);
  console.log(`Parties whose opening_outstanding differs from their opening journals: ${report.parties.length}`);
  printDuplicates(report.duplicates);
}

async function main() {
  const opts = parseOpeningAuditArgs(process.argv.slice(2));
  if (opts.checkDuplicates) {
    const duplicates = await findActiveDuplicateKeys(prisma);
    printDuplicates(duplicates);
    process.exitCode = openingAuditExitCode(duplicates);
    return;
  }

  let report = await prisma.$transaction((tx) => planOpeningBalanceAudit(tx), { timeout: 120000 });
  printReport(report);
  const out = opts.out ?? (opts.apply ? `e2-opening-balance-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` : null);
  let keyed = new Set<string>();

  if (opts.apply || opts.keyJournals.length > 0) {
    if (opts.apply && out) writeCsv(out, report, keyed, opts.approvedBy);
    const result = await prisma.$transaction(
      (tx) => applyOpeningKeys(tx, { approvedBy: opts.approvedBy, keyJournals: opts.keyJournals, write: opts.apply }),
      { timeout: 120000 },
    );
    report = result.report;
    for (const k of result.keyed) console.log(`  ${opts.apply ? 'keyed' : 'would key'} ${k.entryNumber} -> ${k.sourceKey} (${k.explicit ? 'named' : k.cls})`);
    if (opts.apply) {
      keyed = new Set(result.keyed.map((k) => k.journalId));
      console.log(`Keyed ${result.keyed.length} journal(s), approved by ${opts.approvedBy}.`);
    } else {
      console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to key them.');
    }
  } else {
    console.log('Dry run: nothing written. Pass --apply --approved-by "<accountant name>" to key the single-two-line-opening journals.');
  }

  if (out) writeCsv(out, report, keyed, opts.approvedBy);
  process.exitCode = openingAuditExitCode(report.duplicates);
}

main()
  .catch((e) => {
    if (e instanceof OpeningAuditRefusal) console.error(e.message);
    else console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
