/**
 * Production journals through postJournal (PR-6.1c, owner decision #14).
 *
 * The run's journal JV-<runNumber> and its edit revisions -R<n> are posted by the shared posting
 * function: they carry source SYSTEM_DOC, go through the document account rule (an inactive or
 * group item account is refused instead of being posted to silently), and move stored balances
 * per line. The cancel model reverses them per line too, so after submit -> edit -> cancel every
 * account's stored balance still equals its live ledger entries, and no step recomputes an
 * account from its ledger. Everything runs in a rollback transaction on fixtures made here,
 * fiscal year 2102.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { ACCOUNT_GROUP, ACCOUNT_INACTIVE } from '../../services/ledger/accountGuard';
import { submitProductionRunInTx, type SubmitProductionRunInput } from '../../services/productionRunSubmit';
import { editProductionRunInTx } from '../../services/productionRunEdit';
import { cancelProductionRunInTx } from '../../services/productionRunCancel';
import {
  createProductionWorld,
  seedWorldStock,
  worldDate,
  journalLinesByRole,
  assertBalancesMatchAle,
  type ProductionWorld,
} from '../helpers/productionFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const YEAR = 2102;

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

async function inWorld(fn: (tx: Tx, world: ProductionWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      systemAccounts.invalidateCache();
      try {
        const world = await createProductionWorld(tx, YEAR);
        await fn(tx, world);
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** PRD R1: 1.000 kg GKP @ 6.000 -> 600 kg beras + 100 kg bekatul NRV 2.000, conversion 300/kg. */
function r1Body(world: ProductionWorld, over: Partial<SubmitProductionRunInput> = {}): SubmitProductionRunInput {
  return {
    date: worldDate(world),
    warehouseId: world.warehouseA.id,
    inputs: [{ itemId: world.items.gkp.id, quantity: 1000 }],
    outputs: [
      { itemId: world.items.beras.id, quantity: 600 },
      { itemId: world.items.bekatul.id, quantity: 100, unitPrice: 2000, isByProduct: true },
    ],
    costs: [{ description: 'Konversi', costSide: 'InputSide', basis: 'InputQty', rate: 300 }],
    ...over,
  };
}

const balances = async (tx: Tx, w: ProductionWorld) => {
  const rows = await tx.account.findMany({ where: { id: { in: Object.values(w.accounts).map((a) => a.id) } } });
  const byId = new Map(rows.map((r) => [r.id, Number(r.balance)]));
  return {
    inventory: byId.get(w.accounts.inventory.id),
    cogs: byId.get(w.accounts.cogs.id),
    conversion: byId.get(w.accounts.conversion.id),
  };
};

const journal = (tx: Tx, entryNumber: string) =>
  tx.journalEntry.findUniqueOrThrow({ where: { entryNumber }, select: { status: true, sourceType: true, sourceKey: true } });

/** Points the beras item at a fresh ASSET account built with `flags` (e.g. inactive, group). */
async function berasOnAccount(tx: Tx, w: ProductionWorld, flags: { isActive?: boolean; isGroup?: boolean }) {
  const account = await tx.account.create({
    data: {
      name: 'IT-6.1c beras account',
      accountNumber: `IT-61C-BRS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      accountType: 'ASSET',
      rootType: 'ASSET',
      ...flags,
    },
  });
  await tx.inventoryItem.update({ where: { id: w.items.beras.id }, data: { accountId: account.id } });
}

d('production journals through postJournal', () => {
  it('posts JV-<run> and -R1 as SYSTEM_DOC and keeps stored balances equal to the ledger through submit, edit and cancel', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const seeded = await balances(tx, w);

      const run = (await submitProductionRunInTx(tx, r1Body(w), w.userId))!;
      const base = `JV-${run.runNumber}`;
      expect(await journal(tx, base)).toEqual({ status: 'Submitted', sourceType: 'SYSTEM_DOC', sourceKey: null });
      await assertBalancesMatchAle(tx, w);
      // Balances moved by exactly the journal: inventory +300.000,02, conversion credit 300.000, COGS credit 0,02.
      const afterSubmit = await balances(tx, w);
      expect(afterSubmit.inventory! - seeded.inventory!).toBeCloseTo(300_000.02, 2);

      await editProductionRunInTx(tx, run.id, r1Body(w, {
        inputs: [{ itemId: w.items.gkp.id, quantity: 800 }],
        outputs: [
          { itemId: w.items.beras.id, quantity: 500 },
          { itemId: w.items.bekatul.id, quantity: 80, unitPrice: 2000, isByProduct: true },
        ],
      }), w.userId);
      expect((await journal(tx, base)).status).toBe('Cancelled');
      expect(await journal(tx, `${base}-R1`)).toEqual({ status: 'Submitted', sourceType: 'SYSTEM_DOC', sourceKey: null });
      expect((await journalLinesByRole(tx, w, `${base}-R1`)).lines.inventory).toEqual({ debit: 5_040_000, credit: 4_800_000 });
      await assertBalancesMatchAle(tx, w);

      await cancelProductionRunInTx(tx, run.id, { userId: w.userId, reason: 'IT 6.1c' });
      expect((await journal(tx, `${base}-R1`)).status).toBe('Cancelled');
      await assertBalancesMatchAle(tx, w);
      expect(await balances(tx, w)).toEqual(seeded);
    });
  });

  it('applies balances per line: an edit leaves an unrelated stored-balance difference alone', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, r1Body(w), w.userId))!;
      // A stored balance that differs from the ledger by 1.000 (as legacy drift would). The old
      // edit recomputed every account of the run's journals from the ledger and erased it.
      await tx.account.update({ where: { id: w.accounts.inventory.id }, data: { balance: { increment: 1000 } } });
      const before = await balances(tx, w);

      await editProductionRunInTx(tx, run.id, r1Body(w), w.userId);

      // Same body: the revision equals the voided original, so no balance moves.
      expect((await journalLinesByRole(tx, w, `JV-${run.runNumber}-R1`)).lines.inventory).toEqual({ debit: 6_300_000.02, credit: 6_000_000 });
      expect(await balances(tx, w)).toEqual(before);
    });
  });

  it('refuses a run whose output item posts to an inactive account', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      await berasOnAccount(tx, w, { isActive: false });
      await expect(submitProductionRunInTx(tx, r1Body(w), w.userId)).rejects.toMatchObject({ code: ACCOUNT_INACTIVE });
    });
  });

  it('refuses a run whose output item posts to a group account', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      await berasOnAccount(tx, w, { isGroup: true });
      await expect(submitProductionRunInTx(tx, r1Body(w), w.userId)).rejects.toMatchObject({ code: ACCOUNT_GROUP });
    });
  });

  it('refuses an edit that would post to an inactive item account', async () => {
    await inWorld(async (tx, w) => {
      await seedWorldStock(tx, w, 'gkp', 2000, 6000);
      const run = (await submitProductionRunInTx(tx, r1Body(w), w.userId))!;
      await berasOnAccount(tx, w, { isActive: false });
      await expect(editProductionRunInTx(tx, run.id, r1Body(w), w.userId)).rejects.toMatchObject({ code: ACCOUNT_INACTIVE });
    });
  });
});
