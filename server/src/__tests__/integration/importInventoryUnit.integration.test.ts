/**
 * Integration test: the inventory import never changes the unit of an item (E3-R5).
 *
 * Preview only (nothing is written). Fresh codes per case, created inside the rollback transaction.
 * - A row whose unit differs from an item already in the database is a row error.
 * - Two rows of one file with the same new code and different units: the second is a row error.
 * - Two rows with the same code and the same unit both pass.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createCapUser } from '../helpers/rbacFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null, file: null as { buffer: Buffer; originalname: string } | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));
vi.mock('../../routes/import/shared', async (orig) => ({
  ...(await orig<typeof import('../../routes/import/shared')>()),
  upload: { single: () => (req: any, _res: unknown, next: () => void) => { req.file = state.file; next(); } },
}));

import { invalidatePermissionCache } from '../../services/permissionService';
import inventoryImportRouter from '../../routes/import/inventory';

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

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function inRollback(fn: (tx: Tx, actor: { userId: string; role: string }) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        await fn(tx, await createCapUser(tx, []));
      } finally {
        state.tx = null;
        state.file = null;
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const HEADERS = ['code', 'name', 'unit', 'openingQty', 'openingPrice'] as const;
type Row = Record<(typeof HEADERS)[number], string>;

async function preview(actor: { userId: string; role: string }, rows: Row[]) {
  state.file = { buffer: Buffer.from([HEADERS.join(','), ...rows.map((r) => HEADERS.map((h) => r[h]).join(','))].join('\n')), originalname: 'inventory.csv' };
  const r = await callRoute(inventoryImportRouter, 'post', '/inventory', { userId: actor.userId, role: actor.role, query: { preview: 'true' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { data: Array<{ code: string; unit: string }>; errors: Array<{ row: number; message: string }> };
}

d('inventory import and the item unit (E3-R5)', () => {
  it('flags a row whose unit differs from an existing item', async () => {
    await inRollback(async (tx, actor) => {
      const code = `IT-IMU-${tag()}`;
      await tx.inventoryItem.create({ data: { code, name: 'Bekatul', unit: 'kg' } });
      const body = await preview(actor, [{ code, name: 'Bekatul', unit: 'ton', openingQty: '1', openingPrice: '1000' }]);
      expect(body.data).toHaveLength(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].row).toBe(2);
    });
  });

  it('flags a later row of the same file that repeats a new code with another unit', async () => {
    await inRollback(async (tx, actor) => {
      const code = `IT-IMU-${tag()}`;
      const body = await preview(actor, [
        { code, name: 'Bekatul', unit: 'kg', openingQty: '10000', openingPrice: '1000' },
        { code, name: 'Bekatul', unit: 'ton', openingQty: '10', openingPrice: '1000000' },
      ]);
      expect(body.data.map((r) => r.unit)).toEqual(['kg']);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].row).toBe(3);
    });
  });

  it('accepts repeated rows of one code with the same unit', async () => {
    await inRollback(async (_tx, actor) => {
      const code = `IT-IMU-${tag()}`;
      const body = await preview(actor, [
        { code, name: 'Bekatul', unit: 'kg', openingQty: '1', openingPrice: '1000' },
        { code, name: 'Bekatul', unit: 'kg', openingQty: '2', openingPrice: '1000' },
      ]);
      expect(body.errors).toHaveLength(0);
      expect(body.data).toHaveLength(2);
    });
  });
});
