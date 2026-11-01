/**
 * Integration test: POST /api/backup/upload stores every upload under a fresh name (E7-R12).
 *
 * A small Express app mounts the real backup router (multer included) with BACKUP_DIR in a temp
 * folder, and the test uploads through fetch + FormData. Uploading `backup-2026-10-01.sql.gz`
 * twice gives two different `upload-*` files and leaves an official backup with that very name
 * untouched. A role without doc.cancel gets 403 before multer writes anything. Capabilities are
 * read from a rollback transaction (lib/prisma is swapped for it). No fiscal year is created.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import backupRouter from '../../routes/backup';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let dir: string;
let server: Server | null = null;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  vi.unstubAllEnvs();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
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
    }, { timeout: 30000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** Serves the backup router as `actor` on a random local port; returns the base URL. */
async function serve(actor: { userId: string; role: string }): Promise<string> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-upload-'));
  vi.stubEnv('BACKUP_DIR', dir);
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof actor }).user = actor;
    next();
  });
  app.use('/api/backup', backupRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function uploadAs(base: string, name: string, content: string) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/gzip' }), name);
  const res = await fetch(`${base}/api/backup/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

d('POST /backup/upload', () => {
  it('stores each upload under its own upload-* name and never overwrites an official backup', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, ['doc.cancel'], { perms: { audit: 'edit' } });
      const base = await serve(actor);
      const official = path.join(dir, 'backup-2026-10-01.sql.gz');
      fs.writeFileSync(official, 'official');

      const first = await uploadAs(base, 'backup-2026-10-01.sql.gz', 'first');
      const second = await uploadAs(base, 'backup-2026-10-01.sql.gz', 'second');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.filename).toMatch(/^upload-\d{14}-[0-9a-f]{8}\.sql\.gz$/);
      expect(second.body.filename).toMatch(/^upload-/);
      expect(first.body.filename).not.toBe(second.body.filename);
      expect(fs.readFileSync(path.join(dir, first.body.filename), 'utf8')).toBe('first');
      expect(fs.readFileSync(path.join(dir, second.body.filename), 'utf8')).toBe('second');
      expect(fs.readFileSync(official, 'utf8')).toBe('official');
    });
  });

  it('refuses a role without doc.cancel before the file reaches the disk', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, [], { perms: { audit: 'edit' } });
      const base = await serve(actor);

      const r = await uploadAs(base, 'backup-2026-10-01.sql.gz', 'sneaky');

      expect(r.status).toBe(403);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });

  it('answers 400 for a file that is not .sql.gz', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, ['doc.cancel'], { perms: { audit: 'edit' } });
      const base = await serve(actor);
      const form = new FormData();
      form.append('file', new Blob(['x'], { type: 'text/plain' }), 'notes.txt');
      const res = await fetch(`${base}/api/backup/upload`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });
});
