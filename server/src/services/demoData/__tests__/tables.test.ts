import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_TABLES, DEMO_MASTER_TABLES, KEEP_TABLES, RESET_EXTRA_TABLES, RESET_PRESERVED_TABLES, resetTables } from '../tables';

const PRISMA_DIR = join(__dirname, '../../../../prisma');

/**
 * Every table the app creates: Prisma models (@@map, or the model name when unmapped) plus tables
 * created only by loose SQL migrations and accessed with raw SQL.
 */
function schemaTables(): string[] {
  const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');
  const tables = new Set<string>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    tables.add(/@@map\("([^"]+)"\)/.exec(m[2])?.[1] ?? m[1]);
  }
  const migrations = join(PRISMA_DIR, 'migrations');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql'))) {
    for (const m of readFileSync(join(migrations, file), 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi)) tables.add(m[1]);
  }
  return [...tables];
}

/** Foreign keys declared in schema.prisma, as [child table, parent table] (self references dropped). */
function schemaForeignKeys(): Array<[string, string]> {
  const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const tableOf = new Map(models.map((m) => [m[1], /@@map\("([^"]+)"\)/.exec(m[2])?.[1] ?? m[1]]));
  const fks: Array<[string, string]> = [];
  for (const m of models) {
    for (const f of m[2].matchAll(/^\s+\w+\s+(\w+)\??\s+@relation\([^)]*fields:/gm)) {
      const child = tableOf.get(m[1])!;
      const parent = tableOf.get(f[1]);
      if (parent && parent !== child) fks.push([child, parent]);
    }
  }
  return fks;
}

describe('demo data table classification', () => {
  const keep = new Set<string>(KEEP_TABLES);
  const data = new Set<string>(DATA_TABLES);

  it('classifies every table exactly once', () => {
    const unclassified = schemaTables().filter((t) => !keep.has(t) && !data.has(t));
    expect(unclassified, 'add new tables to KEEP_TABLES or DATA_TABLES in services/demoData/tables.ts').toEqual([]);
    expect([...keep].filter((t) => data.has(t))).toEqual([]);
  });

  it('only lists real tables', () => {
    const real = new Set([...schemaTables(), '_loose_sql_migrations', '_prisma_migrations']);
    expect([...keep, ...data].filter((t) => !real.has(t))).toEqual([]);
  });

  it('deletes demo masters only from kept tables', () => {
    expect(DEMO_MASTER_TABLES.filter((t) => !keep.has(t))).toEqual([]);
  });
});

describe('data reset table lists', () => {
  const keep = new Set<string>(KEEP_TABLES);
  const extra = new Set<string>(RESET_EXTRA_TABLES);
  const preserved = new Set<string>(RESET_PRESERVED_TABLES);

  it('puts every KEEP table in exactly one of RESET_EXTRA_TABLES or RESET_PRESERVED_TABLES', () => {
    expect([...keep].filter((t) => extra.has(t) === preserved.has(t)), 'add the table to exactly one reset list').toEqual([]);
    expect([...extra, ...preserved].filter((t) => !keep.has(t))).toEqual([]);
  });

  it('truncates every DATA table and the period lock, demo and repair markers', () => {
    const reset = new Set(resetTables());
    expect(DATA_TABLES.filter((t) => !reset.has(t))).toEqual([]);
    for (const t of ['period_lock', 'period_lock_logs', 'demo_data_batches', 'demo_data_records', 'data_fix_markers', 'close_check_baselines', 'users', 'audit_trail']) {
      expect(reset.has(t), t).toBe(true);
    }
    expect(resetTables().filter((t) => preserved.has(t))).toEqual([]);
  });

  it('does not list as preserved a table that TRUNCATE ... CASCADE would empty', () => {
    const reset = new Set(resetTables());
    const fks = schemaForeignKeys();
    expect(fks.length).toBeGreaterThan(100);
    // Closure: a preserved table referencing a reset table (directly or through another one) is emptied too.
    const emptied = new Set(reset);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [child, parent] of fks) {
        if (emptied.has(parent) && !emptied.has(child)) { emptied.add(child); grew = true; }
      }
    }
    expect([...preserved].filter((t) => emptied.has(t)), 'move these to RESET_EXTRA_TABLES').toEqual([]);
  });
});
