/**
 * Integration test: POST /api/settings/reset-data gates and its safety backup (E7-R12).
 *
 * The reset needs settings edit + rbac.manage + doc.cancel (Admin by default) and always takes a
 * pre-reset safety backup first; when that backup fails the reset stops with 500 before any
 * TRUNCATE. backupService is mocked: the success path (TRUNCATE + seed through a child process)
 * is never run here, because it would wipe the test database and deadlock with the rollback
 * transaction. No fiscal year is created.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
const backup = vi.hoisted(() => ({
  createBackup: vi.fn(),
  invalidateRuntimeCaches: vi.fn(),
}));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../services/backupService', () => ({
  SAFETY_BACKUP_FAILED: 'SAFETY_BACKUP_FAILED',
  createBackup: backup.createBackup,
  invalidateRuntimeCaches: backup.invalidateRuntimeCaches,
}));

import { invalidatePermissionCache } from '../../services/permissionService';
import dummyDataRouter from '../../routes/settings/dummyData';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

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

beforeEach(() => {
  backup.createBackup.mockReset();
  backup.invalidateRuntimeCaches.mockReset();
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

const RESET = { body: { confirmation: 'RESET' } };

/** A party row the test owns: it must survive every refused or aborted reset. */
async function probeParty(tx: Tx) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return tx.party.create({ data: { name: `Uji reset ${tag}`, partyType: 'Customer' } });
}

d('POST /settings/reset-data gates', () => {
  it('refuses a role with settings edit and doc.cancel but no rbac.manage', async () => {
    await inRollback(async (tx) => {
      const party = await probeParty(tx);
      const actor = await createCapUser(tx, ['doc.cancel'], { perms: { settings: 'edit' } });
      const r = await callRoute(dummyDataRouter, 'post', '/reset-data', { ...RESET, ...actor });
      expect(r.status).toBe(403);
      expect(backup.createBackup).not.toHaveBeenCalled();
      expect(await tx.party.count({ where: { id: party.id } })).toBe(1);
    });
  });

  it('refuses a role with settings edit and rbac.manage but no doc.cancel', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, ['rbac.manage'], { perms: { settings: 'edit' } });
      const r = await callRoute(dummyDataRouter, 'post', '/reset-data', { ...RESET, ...actor });
      expect(r.status).toBe(403);
      expect(backup.createBackup).not.toHaveBeenCalled();
    });
  });

  it('refuses a role with both capabilities but only settings view', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, ['rbac.manage', 'doc.cancel'], { perms: { settings: 'view' } });
      const r = await callRoute(dummyDataRouter, 'post', '/reset-data', { ...RESET, ...actor });
      expect(r.status).toBe(403);
      expect(backup.createBackup).not.toHaveBeenCalled();
    });
  });

  it('asks for the RESET confirmation before taking a backup', async () => {
    await inRollback(async (tx) => {
      const actor = await createCapUser(tx, ['rbac.manage', 'doc.cancel'], { perms: { settings: 'edit' } });
      const r = await callRoute(dummyDataRouter, 'post', '/reset-data', { body: { confirmation: 'reset' }, ...actor });
      expect(r.status).toBe(400);
      expect(backup.createBackup).not.toHaveBeenCalled();
    });
  });

  it('stops with 500 and deletes nothing when the pre-reset safety backup fails', async () => {
    await inRollback(async (tx) => {
      const party = await probeParty(tx);
      backup.createBackup.mockRejectedValue(new Error('pg_dump exited 1: disk full'));
      const actor = await createCapUser(tx, ['rbac.manage', 'doc.cancel'], { perms: { settings: 'edit' } });
      const journalsBefore = await tx.journalEntry.count();
      const usersBefore = await tx.user.count();

      const r = await callRoute(dummyDataRouter, 'post', '/reset-data', { ...RESET, ...actor });

      expect(r.status).toBe(500);
      expect(r.body.code).toBe('SAFETY_BACKUP_FAILED');
      expect(r.body.error).toContain('reset dibatalkan');
      expect(backup.createBackup).toHaveBeenCalledWith('pre-reset');
      expect(await tx.party.count({ where: { id: party.id } })).toBe(1);
      expect(await tx.journalEntry.count()).toBe(journalsBefore);
      expect(await tx.user.count()).toBe(usersBefore);
      expect(backup.invalidateRuntimeCaches).not.toHaveBeenCalled();
    });
  });
});
