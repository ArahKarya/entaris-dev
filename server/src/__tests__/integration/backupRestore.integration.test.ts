/**
 * Integration test: restore is all-or-nothing and round-trips a real dump (E7-R12).
 *
 * Uses the real pg_dump, gzip and psql against the test database, with BACKUP_DIR in a temp folder.
 * (a) A dump that fails halfway (creates a probe table, then selects from a missing table) through
 *     POST /api/backup/restore answers 500 RESTORE_FAILED; the probe table is not left behind, the
 *     journal count is unchanged and a pre-restore safety backup exists.
 * (b) A backup made by createBackup from the test database is restored into a scratch database
 *     (created here, dropped in afterAll) and has the same row counts.
 * Skipped with a message when psql or pg_dump 16+ is missing, or (b only) the role cannot create
 * databases; under CI a missing client fails instead, so the test is never skipped silently there.
 * No fiscal year is created.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { createBackup, restoreBackup } from '../../services/backupService';
import backupRouter from '../../routes/backup';

const DB_URL = process.env.DATABASE_URL ?? '';
/** psql rejects Prisma's `?schema=` parameter. */
const plainUrl = (url: string) => url.replace(/\?.*$/, '');

function clientMajor(cmd: string): number | null {
  try {
    const m = /(\d+)(?:\.\d+)?/.exec(execFileSync(cmd, ['--version'], { encoding: 'utf8' }));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function psql(url: string, sql: string): string {
  return execFileSync('psql', [plainUrl(url), '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}

const toolsOk = (clientMajor('psql') ?? 0) >= 16 && (clientMajor('pg_dump') ?? 0) >= 16;
if (DB_URL && !toolsOk) {
  if (process.env.CI) throw new Error('backupRestore integration test needs psql and pg_dump 16+ (install postgresql-client-16)');
  console.warn('backupRestore.integration: skipped, psql/pg_dump 16+ not found');
}
const canCreateDb = (() => {
  if (!DB_URL || !toolsOk) return false;
  try {
    return psql(DB_URL, 'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user') === 't';
  } catch {
    return false;
  }
})();
if (DB_URL && toolsOk && !canCreateDb) {
  console.warn('backupRestore.integration: round-trip case skipped, the database role has no CREATEDB');
}

const d = DB_URL && toolsOk ? describe : describe.skip;
const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const probe = `it_restore_probe_${tag}`;
const scratchDb = `entaris_restore_probe_${tag}`;
const scratchUrl = (() => {
  if (!DB_URL) return '';
  const u = new URL(DB_URL);
  u.pathname = `/${scratchDb}`;
  return u.toString();
})();

let prisma: PrismaClient;
let pool: Pool;
let dir: string;
let scratchCreated = false;

beforeAll(async () => {
  if (!DB_URL || !toolsOk) return;
  pool = new Pool({ connectionString: DB_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'));
  vi.stubEnv('BACKUP_DIR', dir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (DB_URL && toolsOk) {
    // Only reached when the all-or-nothing guarantee regressed and the probe survived.
    psql(DB_URL, `DROP TABLE IF EXISTS ${probe}`);
    if (scratchCreated) psql(DB_URL, `DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

/** Runs fn in a transaction that is always rolled back, with route handlers bound to it. */
async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      try {
        await fn(tx);
      } finally {
        state.tx = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

d('backup restore against a real database', () => {
  it('(a) rolls back a dump that fails halfway and answers 500', async () => {
    const bad = `bad-${tag}.sql.gz`;
    fs.writeFileSync(
      path.join(dir, bad),
      zlib.gzipSync(`CREATE TABLE ${probe} (x int);\nINSERT INTO ${probe} VALUES (1);\nSELECT * FROM it_no_such_table_${tag};\n`),
    );

    await inRollback(async (tx) => {
      const journalsBefore = Number(psql(DB_URL, 'SELECT count(*) FROM journal_entries'));
      const actor = await createCapUser(tx, ['doc.cancel']);

      const r = await callRoute(backupRouter, 'post', '/restore', { body: { filename: bad }, ...actor });

      expect(r.status).toBe(500);
      expect(r.body.code).toBe('RESTORE_FAILED');
      expect(r.body.error).toContain('data tidak berubah');
      expect(r.body.safetyBackup).toMatch(/^pre-restore-/);
      expect(fs.existsSync(path.join(dir, r.body.safetyBackup))).toBe(true);
      expect(psql(DB_URL, `SELECT to_regclass('public.${probe}') IS NULL`)).toBe('t');
      expect(Number(psql(DB_URL, 'SELECT count(*) FROM journal_entries'))).toBe(journalsBefore);
    });
  }, 120_000);

  it.skipIf(!canCreateDb)('(b) restores a createBackup dump into a scratch database with the same rows', async () => {
    const dump = await createBackup('backup');
    psql(DB_URL, `CREATE DATABASE ${scratchDb}`);
    scratchCreated = true;

    const { safetyBackup } = await restoreBackup(path.join(dir, dump.filename), { databaseUrl: scratchUrl });

    expect(safetyBackup).toMatch(/^pre-restore-/);
    for (const table of ['_prisma_migrations', '_loose_sql_migrations', 'accounts', 'users', 'roles']) {
      const sql = `SELECT count(*) FROM ${table}`;
      expect(psql(scratchUrl, sql), table).toBe(psql(DB_URL, sql));
    }
  }, 180_000);
});
