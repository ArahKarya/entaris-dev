import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Stock-writer architecture guard (E3-R3, plan step 6 §2.8). Every Prisma write on stockMovement
 * and inventoryStock, every inventoryItem write whose arguments set currentStock / averageCost /
 * stockValue, every adjustWarehouseStock call and every raw INSERT/UPDATE/DELETE on the three
 * tables, under server/src (scripts included), is counted per file and compared with ALLOWLIST.
 * The list is the state of the code when the guard was added and may only SHRINK: the value
 * ledger PRs move every writer behind services/inventory/inventoryLedger.ts, the one entry that was
 * added (PR-6.4b2) and the only one left after PR-6.4e besides wipe and seed (PR-6.4d moved the
 * delivery order, invoice cancellation and transfer writers behind it). Write stock fields
 * inline in the call (not through a data variable built earlier) so the guard sees them.
 *
 * Every allowlisted file must also call lockInventoryRows (services/inventory/stockLocks.ts) before
 * it writes, unless it is in LOCK_EXEMPT (wipe, seed, the helpers themselves) or still in
 * PENDING_LOCK with the PR that locks it. PENDING_LOCK may only shrink too: PR-6.2c locked the
 * sales, purchase and import writers and PR-6.2b production, which left it empty. A new writer
 * locks from the start.
 */
const SRC = path.resolve(__dirname, '..');

const MODEL_VERB = /\b(stockMovement|inventoryStock)\s*\.\s*(createMany|create|updateMany|update|upsert)\s*\(/g;
const ITEM_VERB = /\binventoryItem\s*\.\s*(createMany|create|updateMany|update|upsert)\s*\(/g;
const ITEM_STOCK_FIELD = /\b(currentStock|averageCost|stockValue)\s*[:,}]/;
const WAREHOUSE_HELPER = /(?<!function\s)\badjustWarehouseStock\s*\(/g;
const RAW_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(inventory_items|inventory_stocks|stock_movements)\b/gi;
const LOCK_CALL = /\blockInventoryRows\s*\(/;

type Counts = Record<string, number>;

const ALLOWLIST: Record<string, Counts> = {
  'routes/stockOpname.ts': { 'stockMovement.create': 1, 'stockMovement.update': 1, 'inventoryItem.update(stock)': 3, adjustWarehouseStock: 2 },
  'scripts/fixLandedCost.ts': { 'stockMovement.updateMany': 1 },
  'scripts/fixPotonganAllocation.ts': { 'stockMovement.update': 1 },
  'services/averageCostRecompute.ts': { 'inventoryItem.update(stock)': 1 },
  'services/cogsBackfillService.ts': { 'inventoryItem.update(stock)': 1 },
  'services/demoData/wipe.ts': { 'sql:UPDATE inventory_items': 1 },
  'services/goodsReceiptCancel.ts': { 'stockMovement.update': 1, 'inventoryItem.update(stock)': 1, adjustWarehouseStock: 1 },
  'services/goodsReceiptSubmit.ts': { 'stockMovement.create': 1, 'inventoryItem.update(stock)': 1, adjustWarehouseStock: 1 },
  'services/inventory/inventoryLedger.ts': { 'inventoryStock.update': 1, 'inventoryItem.update(stock)': 2, 'stockMovement.create': 1, 'stockMovement.updateMany': 2 },
  'services/inventory/manualMovement.ts': { 'inventoryStock.upsert': 1, 'stockMovement.create': 1, 'stockMovement.update': 2, 'inventoryItem.update(stock)': 3, adjustWarehouseStock: 2 },
  'services/inventory/stockLocks.ts': { 'inventoryStock.createMany': 1 },
  'services/openingStockImport.ts': { 'stockMovement.create': 1, 'inventoryItem.update(stock)': 1, adjustWarehouseStock: 1 },
  'services/production/productionPosting.ts': { 'stockMovement.create': 2, 'stockMovement.update': 1, 'inventoryItem.update(stock)': 3, adjustWarehouseStock: 3 },
  'services/purchaseInvoiceRevise.ts': { 'stockMovement.update': 1, 'inventoryItem.update(stock)': 1 },
  'services/purchaseInvoiceSubmit.ts': { 'stockMovement.update': 1, 'inventoryItem.update(stock)': 1 },
  'services/salesReturnCancel.ts': { 'inventoryStock.update': 1, 'stockMovement.update': 1, 'inventoryItem.update(stock)': 1 },
  'services/salesReturnSubmit.ts': { 'inventoryStock.upsert': 1, 'stockMovement.create': 1, 'inventoryItem.update(stock)': 1 },
  'utils/warehouseStock.ts': { 'inventoryStock.upsert': 1 },
};

/** Writers that need no lockInventoryRows call of their own. */
const LOCK_EXEMPT: Record<string, string> = {
  'services/demoData/wipe.ts': 'wipes demo data with no concurrent posting',
  'services/inventory/stockLocks.ts': 'the lock helper itself (creates the rows it locks)',
  'utils/warehouseStock.ts': 'adjustWarehouseStock runs inside callers that hold the lock',
  'scripts/fixLandedCost.ts': 'one-off legacy repair script, deleted in PR-6.4e',
  'scripts/fixPotonganAllocation.ts': 'one-off legacy repair script, deleted in PR-6.4e',
};

/** Writers that do not lock yet, with the PR that locks them. Empty since PR-6.2b; keep it so. */
const PENDING_LOCK: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** The argument text of the call whose "(" is at `open`, up to the matching ")". */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

export function countStockWriters(source: string): Counts {
  const counts: Counts = {};
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const m of source.matchAll(MODEL_VERB)) bump(`${m[1]}.${m[2]}`);
  for (const m of source.matchAll(ITEM_VERB)) {
    const args = callArguments(source, m.index! + m[0].length - 1);
    if (ITEM_STOCK_FIELD.test(args)) bump(`inventoryItem.${m[1]}(stock)`);
  }
  const helperCalls = [...source.matchAll(WAREHOUSE_HELPER)].length;
  if (helperCalls) counts.adjustWarehouseStock = helperCalls;
  for (const m of source.matchAll(RAW_SQL)) bump(`sql:${m[1].replace(/\s+/g, ' ').toUpperCase()} ${m[2]}`);
  return counts;
}

function scan(): Record<string, { counts: Counts; locks: boolean }> {
  const found: Record<string, { counts: Counts; locks: boolean }> = {};
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const counts = countStockWriters(source);
    if (Object.keys(counts).length) {
      found[path.relative(SRC, file).split(path.sep).join('/')] = { counts, locks: LOCK_CALL.test(source) };
    }
  }
  return found;
}

describe('stock writers architecture', () => {
  it('detects Prisma verbs, stock fields, the warehouse helper and raw SQL', () => {
    const counts = countStockWriters(
      "await tx.stockMovement.create({}); await tx.inventoryStock.upsert({});\n" +
      "await tx.inventoryItem.update({ where: { id }, data: { currentStock: { increment: f(1) } } });\n" +
      "await tx.inventoryItem.update({ where: { id }, data: { name: 'x' } });\n" +
      "await adjustWarehouseStock(tx, a, b, 1); export async function adjustWarehouseStock(tx) {}\n" +
      "await tx.$executeRaw`UPDATE inventory_stocks SET x = 1`; await tx.stockMovement.findMany({});",
    );
    expect(counts).toEqual({
      'stockMovement.create': 1,
      'inventoryStock.upsert': 1,
      'inventoryItem.update(stock)': 1,
      adjustWarehouseStock: 1,
      'sql:UPDATE inventory_stocks': 1,
    });
  });

  it('has no stock writer outside the allowlist (new writers go through the stock services)', () => {
    const offenders: string[] = [];
    for (const [file, { counts }] of Object.entries(scan())) {
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
        const n = found[file]?.counts[key] ?? 0;
        if (n < allowed) stale.push(`${file}: ${key} x${n} (allowlist ${allowed})`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('every writer locks its rows with lockInventoryRows, or is exempt, or is pending with its PR', () => {
    const found = scan();
    const unlocked = Object.keys(ALLOWLIST).filter((f) => !LOCK_EXEMPT[f] && !PENDING_LOCK[f] && !found[f]?.locks);
    expect(unlocked).toEqual([]);
  });

  it('keeps PENDING_LOCK tight: a file that locks now leaves the list', () => {
    const found = scan();
    const stale = Object.keys(PENDING_LOCK).filter((f) => !ALLOWLIST[f] || found[f]?.locks);
    expect(stale).toEqual([]);
  });
});
