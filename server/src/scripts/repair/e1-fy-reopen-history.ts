// Read-only report of fiscal-year closes and reopens made before fiscal_year_events existed.
// Before E1-R8 a reopen deleted the CLOSE journal and its ledger rows, so the audit trail is the
// only record left of those reopens. Each POST /fiscal-years/:id/close or /reopen wrote one audit
// row (entity "fiscal-years"): its new values hold the year as returned, its old values the year
// before (when the snapshot was taken). This script lists them per year for the accountant, with
// the year's current state and its CLOSE journals. It never writes to the database.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e1-fy-reopen-history.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e1-fy-reopen-history.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';

interface Options {
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

type Action = 'close' | 'reopen';

interface HistoryRow {
  fiscalYear: string;
  action: Action;
  at: Date;
  user: string;
  via: string | null;
}

const isClosedIn = (values: unknown): boolean | null => {
  const v = (values as { isClosed?: unknown } | null)?.isClosed;
  return typeof v === 'boolean' ? v : null;
};

/**
 * close / reopen from the year the route returned. A failed request wrote an error body (no
 * isClosed), and a create of a new year returns isClosed false with no old values: both skipped.
 */
function actionOf(oldValues: unknown, newValues: unknown): Action | null {
  const after = isClosedIn(newValues);
  if (after === true) return 'close';
  if (after === false && isClosedIn(oldValues) === true) return 'reopen';
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const years = await prisma.fiscalYear.findMany({ orderBy: { startDate: 'asc' } });
  const nameOf = new Map(years.map((y) => [y.id, y.name]));

  const audits = await prisma.auditLog.findMany({
    where: { entityType: 'fiscal-years', entityId: { in: years.map((y) => y.id) } },
    select: { entityId: true, oldValues: true, newValues: true, createdAt: true, via: true, user: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const rows: HistoryRow[] = [];
  for (const a of audits) {
    const action = actionOf(a.oldValues, a.newValues);
    if (!action) continue;
    rows.push({ fiscalYear: nameOf.get(a.entityId)!, action, at: a.createdAt, user: a.user.fullName, via: a.via });
  }

  if (opts.out) {
    const header = 'fiscal_year,action,at,user,via';
    const lines = rows.map((r) => [r.fiscalYear, r.action, r.at, r.user, r.via].map(csvCell).join(','));
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }

  const reopens = rows.filter((r) => r.action === 'reopen').length;
  console.log(`READ ONLY: ${reopens} reopen(s) and ${rows.length - reopens} close(s) in the audit trail (${years.length} fiscal year(s))`);
  for (const y of years) {
    const own = rows.filter((r) => r.fiscalYear === y.name);
    const closeJournals = await prisma.journalEntry.findMany({
      where: { fiscalYearId: y.id, entryNumber: { startsWith: `CLOSE-${y.name}` } },
      select: { entryNumber: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    const journals = closeJournals.map((j) => `${j.entryNumber} (${j.status})`).join(', ') || 'none';
    console.log(`  ${y.name}: ${y.isClosed ? 'closed' : 'open'}; CLOSE journals now: ${journals}`);
    for (const r of own) console.log(`    ${r.at.toISOString()}  ${r.action.padEnd(6)}  ${r.user}${r.via ? ` (${r.via})` : ''}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
