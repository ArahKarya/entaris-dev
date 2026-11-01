/**
 * Integration test: audit_trail is append-only and written before the response (E7-R11).
 *
 * A. The trigger refuses UPDATE, DELETE and TRUNCATE (one savepoint per step); DELETE of a demo
 *    row is allowed; with entaris.audit_purge set for the transaction everything is allowed.
 * A2. The old service-token scrub file, run as is with the trigger active, still removes the key.
 *    It has its own BEGIN/COMMIT, so it runs on a plain connection against committed fixture rows,
 *    which are purged afterwards.
 * B. A small Express app with the real middleware: a 400 leaves no audit row, and a 201 already
 *    has its row when `await fetch` returns.
 * C. The trigger health check is ok.
 * No fiscal year is created.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';
import { purgeAuditRows } from '../helpers/auditPurge';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { invalidatePermissionCache } from '../../services/permissionService';
import { checkRequiredTriggers } from '../../routes/health/schemaGuards';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const SCRUB_FILE = path.resolve(__dirname, '../../../prisma/migrations/20261003000000_scrub_ai_service_token_audit.sql');

let prisma: PrismaClient;
let pool: Pool;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

/** Runs fn in a transaction that is always rolled back, with lib/prisma bound to it. */
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

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

let savepointSeq = 0;
/** Runs one statement in a savepoint and reports whether Postgres refused it (always rolled back). */
async function attempt(tx: Tx, sql: string, ...params: unknown[]): Promise<{ refused: boolean; message: string }> {
  const sp = `audit_it_${++savepointSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    await tx.$executeRawUnsafe(sql, ...params);
    return { refused: false, message: '' };
  } catch (e) {
    return { refused: true, message: e instanceof Error ? e.message : String(e) };
  } finally {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
}

async function auditRow(tx: Tx, userId: string, extra: Record<string, unknown> = {}) {
  return tx.auditLog.create({
    data: { userId, action: 'CREATE', entityType: `it-audit-${tag()}`, entityId: 'x', newValues: { a: 1 }, ...extra },
  });
}

d('audit_trail append-only trigger', () => {
  it('refuses UPDATE, DELETE and TRUNCATE of normal rows', async () => {
    await inRollback(async (tx) => {
      const { userId } = await createCapUser(tx, []);
      const row = await auditRow(tx, userId);

      for (const sql of [
        `UPDATE audit_trail SET entity_id = 'changed' WHERE id = $1`,
        `DELETE FROM audit_trail WHERE id = $1`,
      ]) {
        const r = await attempt(tx, sql, row.id);
        expect(r.refused, sql).toBe(true);
        expect(r.message).toMatch(/append-only/);
      }
      const t = await attempt(tx, 'TRUNCATE TABLE audit_trail');
      expect(t.refused).toBe(true);
      expect(t.message).toMatch(/append-only/);

      expect((await tx.auditLog.findUniqueOrThrow({ where: { id: row.id } })).entityId).toBe('x');
    });
  });

  it('allows DELETE of a demo row but refuses UPDATE of it', async () => {
    await inRollback(async (tx) => {
      const { userId } = await createCapUser(tx, []);
      const demo = await auditRow(tx, userId, { via: 'demo' });

      expect((await attempt(tx, `UPDATE audit_trail SET entity_id = 'changed' WHERE id = $1`, demo.id)).refused).toBe(true);
      await tx.auditLog.delete({ where: { id: demo.id } });
      expect(await tx.auditLog.findUnique({ where: { id: demo.id } })).toBeNull();
    });
  });

  it('allows everything once entaris.audit_purge is set for the transaction', async () => {
    await inRollback(async (tx) => {
      const { userId } = await createCapUser(tx, []);
      const a = await auditRow(tx, userId);
      const b = await auditRow(tx, userId);
      await tx.$executeRawUnsafe(`SELECT set_config('entaris.audit_purge', 'on', true)`);

      await tx.auditLog.update({ where: { id: a.id }, data: { entityId: 'changed' } });
      expect((await tx.auditLog.findUniqueOrThrow({ where: { id: a.id } })).entityId).toBe('changed');
      await tx.auditLog.delete({ where: { id: b.id } });
      expect(await tx.auditLog.findUnique({ where: { id: b.id } })).toBeNull();
      expect((await attempt(tx, 'TRUNCATE TABLE audit_trail')).refused).toBe(false);

      await tx.$executeRawUnsafe(`SELECT set_config('entaris.audit_purge', 'off', true)`);
      expect((await attempt(tx, `DELETE FROM audit_trail WHERE id = $1`, a.id)).refused).toBe(true);
    });
  });
});

d('service-token scrub with the trigger active (A2)', () => {
  it('runs the migration file as is and removes serviceToken from both columns', async () => {
    const key = `it-scrub-${tag()}`;
    const user = await prisma.user.create({
      data: { username: key, fullName: `Uji ${key}`, email: `${key}@test.invalid`, passwordHash: '-', role: 'Viewer' },
    });
    try {
      const row = await prisma.auditLog.create({
        data: {
          userId: user.id, action: 'UPDATE', entityType: 'ai', entityId: key,
          oldValues: { serviceToken: 'old-plain', keep: 'o' }, newValues: { serviceToken: 'new-plain', keep: 'n' },
        },
      });

      await pool.query(readFileSync(SCRUB_FILE, 'utf8'));

      const after = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.newValues).toEqual({ keep: 'n' });
      expect(after.oldValues).toEqual({ keep: 'o' });
    } finally {
      await purgeAuditRows(prisma, { userId: user.id });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

d('audit middleware over HTTP (B)', () => {
  it('writes no row for a 400 and has the row in place when a 201 arrives', async () => {
    await inRollback(async (tx) => {
      const { userId } = await createCapUser(tx, []);
      // The snapshot registry binds its models at import, so load it while the harness tx is set.
      const { auditTrailMiddleware } = await import('../../middleware/auditTrail');
      const entity = `it-audit-${tag()}`;

      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => { req.user = { userId, role: 'Admin' }; next(); });
      app.use('/api', auditTrailMiddleware as express.RequestHandler);
      app.post(`/api/${entity}/bad`, (_req, res) => { res.status(400).json({ error: 'Tidak valid.' }); });
      app.post(`/api/${entity}`, (_req, res) => { res.status(201).json({ id: 'it-created-1' }); });
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      try {
        const bad = await fetch(`${base}/api/${entity}/bad`, { method: 'POST', headers: { 'x-request-id': 'it-bad-1' } });
        expect(bad.status).toBe(400);
        expect(bad.headers.get('x-request-id')).toBe('it-bad-1');
        expect(await tx.auditLog.count({ where: { entityType: entity } })).toBe(0);

        const ok = await fetch(`${base}/api/${entity}`, { method: 'POST' });
        expect(ok.status).toBe(201);
        expect(await ok.json()).toEqual({ id: 'it-created-1' });
        // No polling: the response is only sent after the INSERT.
        const rows = await tx.auditLog.findMany({ where: { entityType: entity } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ userId, action: 'CREATE', entityId: 'it-created-1' });
      } finally {
        await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      }
    });
  });
});

d('trigger health check (C)', () => {
  it('reports both audit triggers present and enabled', async () => {
    await inRollback(async () => {
      const r = await checkRequiredTriggers();
      expect(r).toMatchObject({ name: 'Required Database Triggers', status: 'ok', count: 0 });
    });
  });
});
