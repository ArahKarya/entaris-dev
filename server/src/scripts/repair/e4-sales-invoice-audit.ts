// Report of legacy sales invoice data from before E4-R1 / E4-R2 (sections in
// services/salesInvoiceAudit.ts): status-mismatch, outstanding-mismatch, cancelled-with-returns
// and zero-allocations.
//
// Dry run by default: prints a summary and, with --out, writes one CSV row per finding for the
// accountant to review. --apply fixes only the status-mismatch rows (the status column, never the
// outstanding or a journal), in one transaction, and needs --approved-by "<accountant name>",
// which is recorded on one audit row per fixed invoice. The other sections are never written:
// cancelled invoices with an active return are fixed by the accountant cancelling the return from
// the menu (a return in a closed year needs a correcting journal instead).
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e4-sales-invoice-audit.js [--out file.csv] [--apply --approved-by "<name>"]
//   (or `npx tsx src/scripts/repair/e4-sales-invoice-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import {
  applySalesInvoiceStatusFixes,
  auditSalesInvoices,
  type SalesInvoiceAuditRow,
  type SalesInvoiceAuditSection,
} from '../../services/salesInvoiceAudit';

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
    else if (a === '--approved-by') opts.approvedBy = argv[++i] ?? null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.apply && !opts.approvedBy?.trim()) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.approvedBy && !opts.apply) throw new Error('--approved-by only goes with --apply');
  return opts;
}

const SECTIONS: readonly SalesInvoiceAuditSection[] = ['status-mismatch', 'outstanding-mismatch', 'cancelled-with-returns', 'zero-allocations'];

function writeCsv(path: string, rows: readonly SalesInvoiceAuditRow[], applied: ReadonlySet<string>) {
  const header = 'section,invoice_id,invoice_number,date,customer,status,grand_total,outstanding,expected,applied';
  const lines = rows.map((r) =>
    [r.section, r.invoiceId, r.invoiceNumber, r.date, r.customer, r.status, r.grandTotal, r.outstanding, r.expected,
      r.section === 'status-mismatch' && applied.has(r.invoiceId) ? 'yes' : 'no']
      .map(csvCell)
      .join(','),
  );
  writeFileSync(path, `${[header, ...lines].join('\n')}\n`, 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await auditSalesInvoices(prisma);
  // Written before any change, so an unwritable path stops the run before the commit.
  if (opts.out) writeCsv(opts.out, rows, new Set());

  let applied = new Set<string>();
  if (opts.apply) {
    const result = await prisma.$transaction((tx) => applySalesInvoiceStatusFixes(tx, rows, opts.approvedBy!), { timeout: 120_000 });
    applied = new Set(result.applied);
    console.log(`APPLIED (approved by ${result.approvedBy}): ${result.applied.length} status fix(es), ${result.skipped.length} skipped (changed since the report)`);
    if (opts.out) writeCsv(opts.out, rows, applied);
  } else {
    console.log('DRY RUN: nothing written.');
  }
  if (opts.out) console.log(`CSV: ${opts.out}`);

  for (const section of SECTIONS) {
    const own = rows.filter((r) => r.section === section);
    console.log(`  ${section}: ${own.length}`);
    for (const r of own.slice(0, 20)) {
      console.log(`    ${r.invoiceNumber.padEnd(22)} ${r.status.padEnd(14)} outstanding ${r.outstanding.padStart(16)}  expected ${r.expected}`);
    }
    if (own.length > 20) console.log(`    … ${own.length - 20} more (see --out)`);
  }
  const fixable = rows.filter((r) => r.section === 'status-mismatch').length;
  if (!opts.apply && fixable > 0) console.log('Status fixes need --apply --approved-by "<accountant name>" after review.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
