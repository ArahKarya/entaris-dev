/**
 * Integration test: runCapBackfill (services/rbacSeed.ts) against real data_fix_markers and
 * role_capabilities rows.
 *
 * The backfill opens its own transactions, so this file cannot use a rollback sentinel. It works
 * on a throwaway role and marker keys unique to the run, and deletes both afterwards; the built-in
 * roles are never touched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { runCapBackfill } from '../../services/rbacSeed';
import type { CapBackfill } from '../../constants/modules';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const KEY_PREFIX = `it_cap_backfill:${RUN}:`;
const CAPS = ['doc.cancel', 'approval.view_all'];

let pools: Pool[] = [];
let clients: PrismaClient[] = [];
let prisma: PrismaClient;
let roleKey: string;
let roleId: string;
let seq = 0;

function newClient(): PrismaClient {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  pools.push(pool);
  clients.push(client);
  return client;
}

function entry(caps: readonly string[] = CAPS): CapBackfill {
  seq += 1;
  return { key: `${KEY_PREFIX}${seq}`, role: roleKey, caps };
}

async function markerCount(key: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "data_fix_markers" WHERE "key" = ${key}`;
  return rows[0]!.n;
}

async function capsOfRole(): Promise<string[]> {
  const rows = await prisma.roleCapability.findMany({ where: { roleId }, select: { capability: true } });
  return rows.map((r) => r.capability).sort();
}

beforeAll(async () => {
  if (!hasDb) return;
  prisma = newClient();
});

afterAll(async () => {
  if (prisma) {
    await prisma.$executeRaw`DELETE FROM "data_fix_markers" WHERE "key" LIKE ${`${KEY_PREFIX}%`}`;
  }
  await Promise.all(clients.map((c) => c.$disconnect()));
  await Promise.all(pools.map((p) => p.end()));
  clients = [];
  pools = [];
});

beforeEach(async () => {
  if (!hasDb) return;
  roleKey = `it-cap-backfill-${RUN}-${seq}`;
  const role = await prisma.role.create({ data: { key: roleKey, name: 'IT cap backfill' } });
  roleId = role.id;
});

afterEach(async () => {
  if (!hasDb) return;
  await prisma.role.deleteMany({ where: { id: roleId } }); // caps cascade
});

d('runCapBackfill', () => {
  it('grants the caps once and records the marker', async () => {
    const e = entry();
    expect(await runCapBackfill(prisma, [e])).toBe(1);
    expect(await capsOfRole()).toEqual([...CAPS].sort());
    expect(await markerCount(e.key)).toBe(1);

    expect(await runCapBackfill(prisma, [e])).toBe(0);
    expect(await capsOfRole()).toEqual([...CAPS].sort());
  });

  it('keeps a cap an admin removed after the backfill ran', async () => {
    const e = entry();
    await runCapBackfill(prisma, [e]);
    await prisma.roleCapability.deleteMany({ where: { roleId, capability: 'doc.cancel' } });

    expect(await runCapBackfill(prisma, [e])).toBe(0);
    expect(await capsOfRole()).toEqual(['approval.view_all']);
  });

  it('two parallel boots apply the entry once', async () => {
    const e = entry();
    const [a, b] = await Promise.all([runCapBackfill(newClient(), [e]), runCapBackfill(newClient(), [e])]);
    expect(a + b).toBe(1);
    expect(await markerCount(e.key)).toBe(1);
    expect(await capsOfRole()).toEqual([...CAPS].sort());
  });

  it('a failed grant leaves no marker, so the entry retries on the next boot', async () => {
    const bad = entry(['bad\u0000cap']); // Postgres rejects NUL in text, failing createMany
    expect(await runCapBackfill(prisma, [bad])).toBe(0);
    expect(await markerCount(bad.key)).toBe(0);
    expect(await capsOfRole()).toEqual([]);

    const retry = { ...bad, caps: CAPS };
    expect(await runCapBackfill(prisma, [retry])).toBe(1);
    expect(await capsOfRole()).toEqual([...CAPS].sort());
  });
});
