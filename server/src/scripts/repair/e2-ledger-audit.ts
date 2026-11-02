// The one read-only ledger audit (E2-R3, E7-R5, E7-R9): ledger groups that do not balance or are
// split over fiscal years, journals whose lines do not add up (sub-cent differences flagged),
// journals with fewer than 2 valued lines, group / inactive accounts with ledger rows, party
// problems on manual / recurring / imported lines, recurring templates that break today's rules,
// and journals still without a source type. Writes nothing to the database (no --apply); with
// --out it writes one CSV, otherwise it prints the summary only.
//
// Run it in production before the ledger balance triggers ship (PR-4.6) and before each deploy
// that turns a gate on: `--gate trigger` exits 1 when an open fiscal year still has an unbalanced
// ledger group, `--gate tolerance` exits 1 when an open year has a journal whose debit and credit
// differ at all. Findings in closed years are reported but never fail a gate.
//
// Options: --out file.csv   --section <id> (repeatable)   --since YYYY-MM-DD (only rows created
// on or after that business day; open fiscal years are always checked in full, because a delete or cancel of an old row cannot be dated)   --gate trigger|tolerance
// Exit code: 0 clean, 1 gate findings, 2 error.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-ledger-audit.js [--out file.csv] [--section aleGroups] [--since 2026-11-01] [--gate trigger]
//   (or `npx tsx src/scripts/repair/e2-ledger-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { auditCsv, gateExitCode, runLedgerAudit } from '../../services/ledger/ledgerAudit';
import { parseAuditArgs } from '../../services/ledger/ledgerAudit/args';

async function main(): Promise<number> {
  const opts = parseAuditArgs(process.argv.slice(2));
  // One repeatable-read transaction, so every section sees the same snapshot even while users post.
  const result = await prisma.$transaction((tx) => runLedgerAudit(tx, { only: opts.sections, since: opts.since ?? undefined }), {
    timeout: 300000,
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
  for (const s of result.sections) {
    const gate = s.gate ? ` [gate ${s.gate}: ${s.gateRows} open-year finding(s)]` : '';
    console.log(`${s.id}: ${s.rows.length} row(s)${gate} - ${s.title}`);
  }
  if (opts.out) {
    writeFileSync(opts.out, auditCsv(result), 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  const code = gateExitCode(result, opts.gate);
  if (opts.gate) console.log(code === 0 ? `Gate ${opts.gate}: clear.` : `Gate ${opts.gate}: BLOCKED, see the rows above.`);
  console.log('Read only: nothing written.');
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
