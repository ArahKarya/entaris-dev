// Read-only report of deposit applications (customer and supplier) that are still active while
// their journal is Cancelled. Before E1 the Journal menu cancelled customer offset journals and
// restored the invoice and deposit balance itself; those applications should already be marked
// cancelled, but any row listed here was not. Cancelling it now is refused
// (DEPOSIT_APPLICATION_JOURNAL_CANCELLED) so nothing is restored twice; the accountant decides
// the correction. It never writes to the database.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e1-deposit-app-cancelled-journal.js [--out file.csv]
//   (or `npx tsx src/scripts/repair/e1-deposit-app-cancelled-journal.ts …` from a source checkout)

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

interface ReportRow {
  side: 'customer' | 'supplier';
  applicationId: string;
  appliedAt: Date;
  appliedAmount: string;
  depositNumber: string;
  invoiceNumber: string;
  party: string;
  journalNumber: string;
  journalCancelledAt: Date | null;
}

const journalSelect = { entryNumber: true, cancelledAt: true } as const;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const where = { isCancelled: false, journalEntry: { status: 'Cancelled' as const } };
  const [customer, supplier] = await Promise.all([
    prisma.customerDepositApplication.findMany({
      where,
      orderBy: { appliedAt: 'asc' },
      include: {
        depositPayment: { select: { paymentNumber: true } },
        salesInvoice: { select: { invoiceNumber: true, customer: { select: { name: true } } } },
        journalEntry: { select: journalSelect },
      },
    }),
    prisma.vendorDepositApplication.findMany({
      where,
      orderBy: { appliedAt: 'asc' },
      include: {
        depositPayment: { select: { paymentNumber: true } },
        purchaseInvoice: { select: { invoiceNumber: true, supplier: { select: { name: true } } } },
        journalEntry: { select: journalSelect },
      },
    }),
  ]);

  const rows: ReportRow[] = [
    ...customer.map((a): ReportRow => ({
      side: 'customer', applicationId: a.id, appliedAt: a.appliedAt, appliedAmount: a.appliedAmount.toString(),
      depositNumber: a.depositPayment.paymentNumber, invoiceNumber: a.salesInvoice.invoiceNumber,
      party: a.salesInvoice.customer.name, journalNumber: a.journalEntry!.entryNumber, journalCancelledAt: a.journalEntry!.cancelledAt,
    })),
    ...supplier.map((a): ReportRow => ({
      side: 'supplier', applicationId: a.id, appliedAt: a.appliedAt, appliedAmount: a.appliedAmount.toString(),
      depositNumber: a.depositPayment.paymentNumber, invoiceNumber: a.purchaseInvoice.invoiceNumber,
      party: a.purchaseInvoice.supplier.name, journalNumber: a.journalEntry!.entryNumber, journalCancelledAt: a.journalEntry!.cancelledAt,
    })),
  ];

  if (opts.out) {
    const header = 'side,application_id,applied_at,applied_amount,deposit_number,invoice_number,party,journal_number,journal_cancelled_at';
    const lines = rows.map((r) =>
      [r.side, r.applicationId, r.appliedAt, r.appliedAmount, r.depositNumber, r.invoiceNumber, r.party, r.journalNumber, r.journalCancelledAt]
        .map(csvCell)
        .join(','),
    );
    writeFileSync(opts.out, `${[header, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log(`Active deposit applications with a cancelled journal: ${rows.length} (customer ${customer.length}, supplier ${supplier.length})`);
  for (const r of rows) {
    console.log(`  ${r.side} ${r.depositNumber} -> ${r.invoiceNumber} ${r.appliedAmount} (journal ${r.journalNumber})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
