// Read-only report of why inventory value and the General Ledger differ (E3-R15, PR-6.13a), for
// the accountant before the year-close baseline and any alignment. Prints per inventory account
// the journal ledger balance, the value book, stock x average, the reconciliation items and the
// difference (services/inventory/inventoryGlCheck.ts), then the findings by class
// (services/inventory/inventoryGlAudit.ts): A document-typed ledger rows, B journals vs movements
// per document, C value without a journal by design or a cost gap, R delivery notes not invoiced.
// --out writes the account rows (class `account`) and every finding as one CSV, with is_dummy for
// demo-generator data. This script never writes to the database and has no --apply.
//
// Usage (from server/, DATABASE_URL set):
//   node dist/scripts/repair/e3-inventory-gl-audit.js [--out inventory-gl.csv]
//   (or `npx tsx src/scripts/repair/e3-inventory-gl-audit.ts …` from a source checkout)

import { writeFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { prisma } from '../../lib/prisma';
import { csvCell } from '../../utils/csv';
import { findInventoryGlDiffs, type InventoryGlDiff } from '../../services/inventory/inventoryGlCheck';
import { findInventoryGlAuditRows, type InventoryGlAuditRow } from '../../services/inventory/inventoryGlAudit';

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

const HEADER = 'class,kind,reference,date,account,item_code,amount,is_dummy,note';

function accountLine(r: InventoryGlDiff): string {
  const note = `gl ${r.gl.toFixed(2)}; book ${r.bookValue.toFixed(2)}; qty x avg ${r.qtyTimesAvg?.toFixed(2) ?? '-'}; `
    + `do not invoiced ${r.doUninvoiced.toFixed(2)}; doc-typed twice ${r.docTypedDuplicate.toFixed(2)}; `
    + `other non-journal ${r.nonJournalOther.toFixed(2)}; phantom qty ${r.phantomQtyValue?.toFixed(2) ?? '-'}`;
  return ['account', r.accountId ? 'account' : 'total', r.accountNumber, '', r.accountNumber, '', r.difference.toFixed(2), '', note]
    .map(csvCell).join(',');
}

function findingLine(r: InventoryGlAuditRow): string {
  return [r.class, r.kind, r.reference, r.date ? r.date.toISOString().slice(0, 10) : '', r.accountNumber ?? '', r.itemCode ?? '',
    r.amount.toFixed(2), r.isDummy ? 'yes' : '', r.note].map(csvCell).join(',');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { accounts, total } = await findInventoryGlDiffs(prisma);
  const findings = await findInventoryGlAuditRows(prisma);

  if (opts.out) {
    const lines = [...accounts.map(accountLine), accountLine(total), ...findings.map(findingLine)];
    writeFileSync(opts.out, `${[HEADER, ...lines].join('\n')}\n`, 'utf8');
    console.log(`CSV: ${opts.out}`);
  }
  console.log('READ ONLY: inventory accounts (gl / book / do not invoiced / difference)');
  for (const r of [...accounts, total]) {
    console.log(`  ${r.accountNumber} ${r.name}: ${r.gl.toFixed(2)} / ${r.bookValue.toFixed(2)} / ${r.doUninvoiced.toFixed(2)} / ${r.difference.toFixed(2)}`
      + `${r.phantomQtyValue && !r.phantomQtyValue.isZero() ? ` (phantom qty ${r.phantomQtyValue.toFixed(2)})` : ''}`);
  }
  const byKind = new Map<string, { n: number; amount: Decimal; dummy: number }>();
  for (const f of findings) {
    const key = `${f.class} ${f.kind}`;
    const cur = byKind.get(key) ?? { n: 0, amount: new Decimal(0), dummy: 0 };
    byKind.set(key, { n: cur.n + 1, amount: cur.amount.plus(f.amount), dummy: cur.dummy + (f.isDummy ? 1 : 0) });
  }
  console.log(`Findings: ${findings.length}`);
  for (const [key, v] of byKind) console.log(`  ${key}: ${v.n}, amount ${v.amount.toFixed(2)}${v.dummy ? `, ${v.dummy} demo data` : ''}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
