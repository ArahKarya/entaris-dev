// Read-only audit of the system account mappings (E2-R8). Lists mappings to group, inactive or
// wrong-root-type accounts, two roles on one account, and required/posting roles without an
// account, each with the ledger balance per fiscal year and replacement candidates. There is no
// --apply: moving a mapping (and any balance) is decided by the accountant in Settings.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e2-system-account-audit.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e2-system-account-audit.ts …` from a source checkout)
// Exit code 0 when no posting role is affected, 1 when one is.

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { AUDIT_CSV_HEADER, auditCsvFields, auditSystemAccounts } from '../../services/systemAccountAudit';

function parseArgs(argv: readonly string[]): { out: string | null } {
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { out };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const findings = await auditSystemAccounts();

  if (out) {
    const lines = findings.map((f) => auditCsvFields(f).map(csvCell).join(','));
    writeFileSync(out, `${[AUDIT_CSV_HEADER, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${out}`);
  }

  const blocking = findings.filter((f) => f.posting);
  console.log(`READ ONLY: ${findings.length} finding(s), ${blocking.length} on roles the posting code uses`);
  for (const f of findings) {
    const who = f.otherRole ? `${f.role} + ${f.otherRole}` : f.role;
    const acc = f.accountNumber ? `${f.accountNumber} ${f.accountName}` : '(no account)';
    console.log(`  ${f.posting ? '!' : ' '} ${f.issue.padEnd(18)} ${who.padEnd(34)} ${acc}  net ${f.netAllYears}  [${f.netByYear}]`);
    if (f.candidates.length > 0) console.log(`      candidates: ${f.candidates.join(' | ')}`);
  }
  if (blocking.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
