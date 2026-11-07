import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Ledger-writer architecture guard. Every Prisma mutation on journalEntry / journalItem /
 * accountingLedgerEntry and every raw INSERT/UPDATE/DELETE on their tables, under server/src
 * (scripts included), is counted per file and compared with ALLOWLIST. The list is the state
 * of the code when this guard was added; epic PRs move writers behind postJournal / the
 * document services and may only SHRINK it. A new writer fails here: post through
 * services/ledger/postJournal.ts instead. When a count drops, lower it here in the same PR.
 */
const SRC = path.resolve(__dirname, '..');

const MODEL_VERB = /\b(accountingLedgerEntry|journalEntry|journalItem)\s*\.\s*(createMany|create|updateMany|update|upsert|deleteMany|delete)\s*[(<]/g;
const RAW_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(accounting_ledger_entries|journal_entries|journal_entry_accounts)\b/gi;

type Counts = Record<string, number>;

const ALLOWLIST: Record<string, Counts> = {
  'routes/coa.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'routes/customerDeposits.ts': { 'journalEntry.create': 3, 'accountingLedgerEntry.createMany': 3 },
  'routes/fixedAssets.ts': { 'journalEntry.create': 2, 'accountingLedgerEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'routes/import/coa.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'routes/import/parties.ts': { 'journalEntry.create': 3, 'accountingLedgerEntry.createMany': 3 },
  'routes/inventory/movements.ts': { 'journalEntry.create': 2, 'accountingLedgerEntry.createMany': 2, 'accountingLedgerEntry.updateMany': 2, 'journalEntry.update': 2 },
  'routes/journals.ts': { 'accountingLedgerEntry.updateMany': 1 },
  'routes/projectGuarantees.ts': { 'journalEntry.create': 2, 'accountingLedgerEntry.createMany': 2 },
  'routes/settings/dummyData.ts': { 'accountingLedgerEntry.deleteMany': 1, 'journalItem.deleteMany': 1, 'journalEntry.deleteMany': 1 },
  'routes/stockOpname.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'routes/vendorDeposits.ts': { 'journalEntry.create': 3, 'accountingLedgerEntry.createMany': 3 },
  'scripts/fixLandedCost.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'scripts/fixPotonganAllocation.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'scripts/repair/e1-journal-source-backfill.ts': { 'journalEntry.updateMany': 2 },
  'services/cogsBackfillReverse.ts': { 'journalEntry.update': 2, 'accountingLedgerEntry.updateMany': 2 },
  'services/cogsBackfillService.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/gaFinance.ts': { 'journalEntry.create': 2, 'accountingLedgerEntry.createMany': 2 },
  'services/gaVehicleServiceJournal.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/goodsReceiptSubmit.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/ledger/postJournal.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/openingStockImport.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/paymentSubmit.ts': { 'journalEntry.create': 4, 'accountingLedgerEntry.createMany': 4 },
  'services/productionRunEdit.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/productionRunSubmit.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/purchaseInvoiceRevise.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/purchaseInvoiceSubmit.ts': { 'journalEntry.create': 1, 'accountingLedgerEntry.createMany': 1 },
  'services/salesInvoiceSubmit.ts': { 'journalEntry.create': 2, 'accountingLedgerEntry.createMany': 2 },
  'services/salesReturnSubmit.ts': { 'journalEntry.create': 2, 'accountingLedgerEntry.createMany': 2 },
  'utils/journalCancel.ts': { 'accountingLedgerEntry.updateMany': 1 },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

export function countWriters(source: string): Counts {
  const counts: Counts = {};
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const m of source.matchAll(MODEL_VERB)) bump(`${m[1]}.${m[2]}`);
  for (const m of source.matchAll(RAW_SQL)) bump(`sql:${m[1].replace(/\s+/g, ' ').toUpperCase()} ${m[2]}`);
  return counts;
}

function scan(): Record<string, Counts> {
  const found: Record<string, Counts> = {};
  for (const file of sourceFiles(SRC)) {
    const counts = countWriters(readFileSync(file, 'utf8'));
    if (Object.keys(counts).length) found[path.relative(SRC, file).split(path.sep).join('/')] = counts;
  }
  return found;
}

describe('ledger writers architecture', () => {
  it('detects Prisma verbs and raw SQL', () => {
    const counts = countWriters(
      "await tx.accountingLedgerEntry.createMany({}); await tx.journalItem.deleteMany({});\n" +
      "await tx.$executeRaw`UPDATE accounting_ledger_entries SET x = 1`; await tx.journalEntry.findMany({});",
    );
    expect(counts).toEqual({
      'accountingLedgerEntry.createMany': 1,
      'journalItem.deleteMany': 1,
      'sql:UPDATE accounting_ledger_entries': 1,
    });
  });

  it('has no ledger writer outside the allowlist (new writers must use postJournal)', () => {
    const found = scan();
    const offenders: string[] = [];
    for (const [file, counts] of Object.entries(found)) {
      for (const [key, n] of Object.entries(counts)) {
        const allowed = ALLOWLIST[file]?.[key] ?? 0;
        if (n > allowed) offenders.push(`${file}: ${key} x${n} (allowed ${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist tight: lower an entry when a writer is removed', () => {
    const found = scan();
    const stale: string[] = [];
    for (const [file, counts] of Object.entries(ALLOWLIST)) {
      for (const [key, allowed] of Object.entries(counts)) {
        const n = found[file]?.[key] ?? 0;
        if (n < allowed) stale.push(`${file}: ${key} x${n} (allowlist ${allowed})`);
      }
    }
    expect(stale).toEqual([]);
  });
});
