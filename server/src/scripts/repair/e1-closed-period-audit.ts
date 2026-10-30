// Read-only report of journals that were cancelled after their fiscal year had been closed.
// Before E1 the cancel paths did not check the fiscal year, so a cancel could change the ledger
// of a year that was already reported. This script only lists them; any correction is a manual
// journal in the open period, decided by the accountant. It never writes to the database.
//
// Only years that are closed now count: reopening a year clears its closedAt, so a cancel made
// while a year was reopened is not reported.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e1-closed-period-audit.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e1-closed-period-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';

const PAGE = 500;

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

interface AuditRow {
  id: string;
  entryNumber: string;
  date: Date;
  fiscalYear: string;
  closedAt: Date;
  cancelledAt: Date;
  sourceType: string | null;
  narration: string | null;
  totalDebit: string;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const closedYears = await prisma.fiscalYear.findMany({
    where: { isClosed: true, closedAt: { not: null } },
    select: { id: true, name: true, closedAt: true },
    orderBy: { startDate: 'asc' },
  });

  const rows: AuditRow[] = [];
  const perYear = new Map<string, number>();
  for (const fy of closedYears) {
    const closedAt = fy.closedAt!;
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.journalEntry.findMany({
        where: { fiscalYearId: fy.id, status: 'Cancelled', cancelledAt: { gt: closedAt }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: {
          id: true, entryNumber: true, date: true, cancelledAt: true, sourceType: true, narration: true,
          items: { select: { debit: true } },
        },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;
      for (const j of page) {
        const totalDebit = j.items.reduce((s, i) => s.plus(i.debit.toString()), new Decimal(0));
        rows.push({
          id: j.id,
          entryNumber: j.entryNumber,
          date: j.date,
          fiscalYear: fy.name,
          closedAt,
          cancelledAt: j.cancelledAt!,
          sourceType: j.sourceType,
          narration: j.narration,
          totalDebit: totalDebit.toFixed(2),
        });
        perYear.set(fy.name, (perYear.get(fy.name) ?? 0) + 1);
      }
    }
  }

  if (opts.out) {
    const header = 'id,entry_number,date,fiscal_year,fy_closed_at,cancelled_at,source_type,narration,total_debit';
    const lines = rows.map((r) =>
      [r.id, r.entryNumber, r.date, r.fiscalYear, r.closedAt, r.cancelledAt, r.sourceType, r.narration, r.totalDebit]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log(`READ ONLY: ${rows.length} journal(s) cancelled after their fiscal year was closed (${closedYears.length} closed year(s) checked)`);
  for (const [name, n] of perYear) console.log(`  ${name}: ${n}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
