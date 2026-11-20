/**
 * Integration test: unit cost precision migration (PR-6.4a, owner decision #1).
 *
 * Every stored unit / average cost column is numeric(20,6) once migrations and loose SQL ran, and
 * the folder migration widens the loose-SQL columns by itself: a database where the loose re-assertion
 * file failed (only a warning in the entrypoints) still ends at 6 dp. On a fresh schema, where the
 * loose columns do not exist yet, the folder's DO block is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const FOLDER_MIGRATION = join(
  __dirname, '../../../prisma/migrations/20261112100000_inventory_cost_precision/migration.sql',
);

/** Columns a Prisma migration creates. */
const PRISMA_COLUMNS: ReadonlyArray<[string, string]> = [
  ['inventory_items', 'average_cost'],
  ['stock_movements', 'unit_cost'],
  ['production_run_items', 'unit_price'],
  ['stock_opname_items', 'unit_cost'],
  ['cogs_backfill_queue', 'cost_at_sale'],
  ['cogs_backfill_settlements', 'cost_at_settle'],
];

/** Columns loose SQL creates; the folder widens them when they exist. */
const LOOSE_COLUMNS: ReadonlyArray<[string, string]> = [
  ['stock_movements', 'unit_cost_loaded'],
  ['goods_receipt_items', 'locked_unit_cost'],
  ['production_runs', 'computed_hpp'],
  ['production_run_items', 'batch_unit_cost'],
  ['production_run_items', 'nrv_unit_value'],
  ['sales_invoice_items', 'unit_cost_loaded'],
  ['sales_return_items', 'unit_cost_loaded'],
];

let pool: Pool;

beforeAll(() => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  if (pool) await pool.end();
});

async function columnTypes(client: PoolClient, cols: ReadonlyArray<[string, string]>) {
  const res = await client.query(
    `SELECT table_name, column_name, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND (table_name || '.' || column_name) = ANY($1::text[])`,
    [cols.map(([t, c]) => `${t}.${c}`)],
  );
  return Object.fromEntries(
    res.rows.map((r) => [`${r.table_name}.${r.column_name}`, `${r.numeric_precision},${r.numeric_scale}`]),
  );
}

const expected = (cols: ReadonlyArray<[string, string]>) =>
  Object.fromEntries(cols.map(([t, c]) => [`${t}.${c}`, '20,6']));

/** Runs fn inside a transaction that is always rolled back. */
async function inRollback(fn: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

d('inventory cost precision migration', () => {
  it('leaves all 13 unit / average cost columns at numeric(20,6)', async () => {
    await inRollback(async (client) => {
      expect(await columnTypes(client, [...PRISMA_COLUMNS, ...LOOSE_COLUMNS]))
        .toEqual(expected([...PRISMA_COLUMNS, ...LOOSE_COLUMNS]));
    });
  });

  it('widens the loose-SQL columns from the folder migration alone', async () => {
    await inRollback(async (client) => {
      // State of a database where only the loose re-assertion file failed.
      for (const [t, c] of LOOSE_COLUMNS) {
        await client.query(`ALTER TABLE "${t}" ALTER COLUMN "${c}" TYPE DECIMAL(20,4)`);
      }
      await client.query(readFileSync(FOLDER_MIGRATION, 'utf8'));
      expect(await columnTypes(client, LOOSE_COLUMNS)).toEqual(expected(LOOSE_COLUMNS));
    });
  });

  it('skips the loose-SQL columns on a schema where they do not exist yet', async () => {
    await inRollback(async (client) => {
      const sql = readFileSync(FOLDER_MIGRATION, 'utf8');
      const block = sql.slice(sql.indexOf('DO $$'));
      expect(block.startsWith('DO $$')).toBe(true);
      await client.query('CREATE SCHEMA cost_precision_fresh');
      await client.query('SET LOCAL search_path TO cost_precision_fresh');
      await client.query(block);
      expect(await columnTypes(client, LOOSE_COLUMNS)).toEqual({});
    });
  });
});
