import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { runCapBackfill } from '../rbacSeed';
import { logger } from '../../lib/logger';
import {
  BACKFILL_CAPS,
  BUILTIN_ROLES,
  CAPABILITY_KEYS,
  DEFAULT_CAPS,
  type CapBackfill,
} from '../../constants/modules';

const ENTRY: CapBackfill = { key: 'rbac_caps:test', role: 'Accountant', caps: ['doc.cancel'] };

interface Options {
  marked?: number[];
  role?: { id: string; isSuperAdmin: boolean } | null;
  createManyError?: Error;
}

function makeClient(opts: Options = {}) {
  const marked = [...(opts.marked ?? [1])];
  const tx = {
    $executeRaw: vi.fn(async () => marked.shift() ?? 0),
    role: { findUnique: vi.fn(async () => (opts.role === undefined ? { id: 'r-acc', isSuperAdmin: false } : opts.role)) },
    roleCapability: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        if (opts.createManyError) throw opts.createManyError;
        return { count: args.data.length };
      }),
    },
  };
  const client = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ t: 'data_fix_markers' }]),
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { client: client as any, tx };
}

/** SQL text of a tagged-template $executeRaw call. */
function sqlOf(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

beforeEach(() => vi.clearAllMocks());

describe('runCapBackfill', () => {
  it('does nothing, not even the marker table, when there are no entries', async () => {
    const { client } = makeClient();
    expect(await runCapBackfill(client, [])).toBe(0);
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('records the marker and grants the caps with skipDuplicates', async () => {
    const { client, tx } = makeClient();
    expect(await runCapBackfill(client, [ENTRY])).toBe(1);
    expect(sqlOf(client.$executeRaw.mock.calls[0])).toMatch(/CREATE TABLE IF NOT EXISTS "data_fix_markers"/);
    const insert = tx.$executeRaw.mock.calls[0] as unknown[];
    expect(sqlOf(insert)).toMatch(/INSERT INTO "data_fix_markers".*ON CONFLICT \("key"\) DO NOTHING/);
    expect(insert[1]).toBe('rbac_caps:test');
    expect(tx.roleCapability.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'r-acc', capability: 'doc.cancel' }],
      skipDuplicates: true,
    });
  });

  it('skips the grant when the marker already exists (earlier boot or a parallel one)', async () => {
    const { client, tx } = makeClient({ marked: [0] });
    expect(await runCapBackfill(client, [ENTRY])).toBe(0);
    expect(tx.role.findUnique).not.toHaveBeenCalled();
    expect(tx.roleCapability.createMany).not.toHaveBeenCalled();
  });

  it('records the marker but grants nothing to a missing or super-admin role', async () => {
    for (const role of [null, { id: 'r-admin', isSuperAdmin: true }]) {
      const { client, tx } = makeClient({ role });
      expect(await runCapBackfill(client, [ENTRY])).toBe(1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.roleCapability.createMany).not.toHaveBeenCalled();
    }
  });

  it('a failed grant rejects the transaction, is logged and does not stop later entries', async () => {
    const { client } = makeClient({ marked: [1, 1], createManyError: new Error('boom') });
    const applied = await runCapBackfill(client, [ENTRY, { ...ENTRY, key: 'rbac_caps:test-2' }]);
    expect(applied).toBe(0);
    expect(client.$transaction).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('tolerates a concurrent marker-table create when the table exists afterwards', async () => {
    const { client } = makeClient();
    client.$executeRaw.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'));
    expect(await runCapBackfill(client, [ENTRY])).toBe(1);
  });

  it('logs and skips every entry when the marker table cannot be created', async () => {
    const { client } = makeClient();
    client.$executeRaw.mockRejectedValueOnce(new Error('permission denied'));
    client.$queryRaw.mockResolvedValueOnce([{ t: null }]);
    expect(await runCapBackfill(client, [ENTRY])).toBe(0);
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('BACKFILL_CAPS', () => {
  const nonSuperRoles = BUILTIN_ROLES.filter((r) => !r.isSuperAdmin).map((r) => r.key);

  it('grants doc.cancel to Accountant once, before the movement edit gate needs it', async () => {
    const entry = BACKFILL_CAPS.find((e) => e.key === 'e1-accountant-doc-cancel');
    expect(entry).toEqual({ key: 'e1-accountant-doc-cancel', role: 'Accountant', caps: ['doc.cancel'] });
    expect(DEFAULT_CAPS.Accountant).toContain('doc.cancel');

    // First boot inserts the marker and grants; the next boot finds the marker and skips.
    const { client, tx } = makeClient({ marked: [1, 0] });
    expect(await runCapBackfill(client, [entry!])).toBe(1);
    expect(await runCapBackfill(client, [entry!])).toBe(0);
    expect(tx.role.findUnique).toHaveBeenCalledWith({ where: { key: 'Accountant' } });
    expect(tx.roleCapability.createMany).toHaveBeenCalledTimes(1);
    expect(tx.roleCapability.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'r-acc', capability: 'doc.cancel' }],
      skipDuplicates: true,
    });
  });

  it('has unique marker keys', () => {
    const keys = BACKFILL_CAPS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only grants catalogue caps to non-super built-in roles, matching DEFAULT_CAPS', () => {
    for (const entry of BACKFILL_CAPS) {
      expect(nonSuperRoles).toContain(entry.role);
      for (const cap of entry.caps) {
        // A cap missing from the catalogue would be dropped the next time an admin saves the role.
        expect(CAPABILITY_KEYS).toContain(cap);
        expect(DEFAULT_CAPS[entry.role]).toContain(cap);
      }
    }
  });
});
