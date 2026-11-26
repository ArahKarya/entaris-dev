/**
 * Integration test: inventory value vs the General Ledger (E3-R15, PR-6.13a), on fixtures made here
 * inside a rollback transaction (helpers/salesFlowFixture.ts; the item's account and a leaf
 * "Persediaan PK" without items sit under one fixture group). Every assertion is limited to the
 * fixture accounts, items and documents, so data elsewhere in the database does not matter.
 * - GL Persediaan PK 1.000.000 (a balanced journal), stock 0 -> the PK leaf is in the account set
 *   and breaks with a difference of 1.000.000; the audit lists the journal as journal-without-movement.
 * - A receipt of 10.000.000 and a delivery note of 4.000.000 not yet invoiced: GL 10.000.000, book
 *   6.000.000, the note a reconciliation item, difference 0 (warning, not error); after the invoice
 *   nothing is left (ok).
 * - A delivery note whose Out carries a journal of its own (the JV-DO shape) is not counted.
 * - A broken stock_value is found by the invariant check.
 * - The health check endpoint lists both new checks.
 * Every scenario ends with assertLedgerInvariant (warehouses included). Fiscal year 2124.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { callRoute, txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { assertLedgerInvariant } from '../helpers/ledgerInvariant';
import { createCapUser } from '../helpers/rbacFixture';
import { createSalesFlowWorld, deliver, invoiceDelivery, receiveStock, type SalesFlowWorld } from '../helpers/salesFlowFixture';
import { systemAccounts } from '../../services/systemAccounts';
import { invalidatePermissionCache } from '../../services/permissionService';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import {
  findInventoryGlDiffs,
  findStockValueInvariantBreaks,
  hasInventoryGlReconciliation,
  inventoryAccountSet,
  isInventoryGlBreak,
} from '../../services/inventory/inventoryGlCheck';
import { findInventoryGlAuditRows } from '../../services/inventory/inventoryGlAudit';
import { linkMovementJournal } from '../../services/inventory/inventoryLedger';
import healthCheckRouter from '../../routes/healthCheck';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const YEAR = 2124;
const DAY = `${YEAR}-03-10`;
const LATER = `${YEAR}-03-20`;
const JT = 1_000_000;

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

interface GlWorld extends SalesFlowWorld {
  pk: { id: string };
}

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

/** The sales-flow world with its inventory account moved under a fixture group, plus a leaf PK there without items. */
async function glWorld(tx: Tx): Promise<GlWorld> {
  const w = await createSalesFlowWorld(tx, YEAR);
  const t = tag();
  const group = await tx.account.create({
    data: { name: `IT-GL Persediaan ${t}`, accountNumber: `IT-GL-${t}`, accountType: 'ASSET', rootType: 'ASSET', isGroup: true },
  });
  await tx.account.update({ where: { id: w.accounts.inventory.id }, data: { parentId: group.id } });
  const pk = await tx.account.create({
    data: { name: `IT-GL Persediaan PK ${t}`, accountNumber: `IT-GL-${t}-PK`, accountType: 'ASSET', rootType: 'ASSET', parentId: group.id },
  });
  return { ...w, pk };
}

async function inWorld(fn: (tx: Tx, w: GlWorld) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      invalidatePermissionCache();
      try {
        const w = await glWorld(tx);
        await fn(tx, w);
        await assertLedgerInvariant(tx, [w.item.id], { warehouses: true });
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
        invalidatePermissionCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

/** A submitted, balanced journal DR `debitId` / CR `creditId` with its ledger rows. */
async function journal(tx: Tx, w: SalesFlowWorld, day: string, debitId: string, creditId: string, amount: number) {
  const at = new Date(`${day}T03:00:00.000Z`);
  const lines = [
    { accountId: debitId, debit: amount, credit: 0 },
    { accountId: creditId, debit: 0, credit: amount },
  ];
  const je = await tx.journalEntry.create({
    data: {
      entryNumber: `IT-GL-${tag()}`, date: at, narration: 'IT-GL fixture', status: 'Submitted', fiscalYearId: w.fyId,
      createdBy: w.userId, submittedAt: new Date(), items: { create: lines },
    },
  });
  await tx.accountingLedgerEntry.createMany({
    data: lines.map((l) => ({ ...l, date: at, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId: w.fyId })),
  });
  return je;
}

const money = (v: Decimal | null) => (v === null ? null : v.toFixed(2));

async function accountRow(tx: Tx, accountId: string) {
  const { accounts } = await findInventoryGlDiffs(tx, { accountIds: [accountId] });
  expect(accounts).toHaveLength(1);
  const r = accounts[0]!;
  return {
    gl: money(r.gl), book: money(r.bookValue), qtyTimesAvg: money(r.qtyTimesAvg), doUninvoiced: money(r.doUninvoiced),
    difference: money(r.difference), broken: isInventoryGlBreak(r), reconciling: hasInventoryGlReconciliation(r),
  };
}

d('inventory vs GL check (PR-6.13a)', () => {
  it('GL Persediaan PK 1.000.000 with stock 0 -> error 1.000.000 on the PK leaf, listed by the audit', async () => {
    await inWorld(async (tx, w) => {
      const set = await inventoryAccountSet(tx);
      expect(set.find((a) => a.id === w.pk.id)?.kinds).toEqual(['sibling']);
      expect(set.find((a) => a.id === w.accounts.inventory.id)?.kinds).toContain('item');

      const je = await journal(tx, w, DAY, w.pk.id, w.accounts.receiptOffset.id, JT);
      expect(await accountRow(tx, w.pk.id)).toEqual({
        gl: '1000000.00', book: '0.00', qtyTimesAvg: '0.00', doUninvoiced: '0.00', difference: '1000000.00', broken: true, reconciling: false,
      });

      const findings = (await findInventoryGlAuditRows(tx)).filter((f) => f.reference === je.entryNumber);
      expect(findings.map((f) => [f.class, f.kind, f.amount.toFixed(2)])).toEqual([['B', 'journal-without-movement', '1000000.00']]);
    });
  });

  it('a delivery note not invoiced is a reconciliation item (difference 0); after the invoice nothing is left', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 10_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 400 }]);
      expect(await accountRow(tx, w.accounts.inventory.id)).toEqual({
        gl: '10000000.00', book: '6000000.00', qtyTimesAvg: '6000000.00', doUninvoiced: '4000000.00', difference: '0.00',
        broken: false, reconciling: true,
      });
      const audit = (await findInventoryGlAuditRows(tx)).filter((f) => f.reference === doc.doNumber);
      expect(audit.map((f) => [f.class, f.kind, f.amount.toFixed(2)])).toEqual([['R', 'do-uninvoiced', '4000000.00']]);

      await invoiceDelivery(tx, w, LATER, doc, { rate: 15_000 });
      expect(await accountRow(tx, w.accounts.inventory.id)).toEqual({
        gl: '6000000.00', book: '6000000.00', qtyTimesAvg: '6000000.00', doUninvoiced: '0.00', difference: '0.00',
        broken: false, reconciling: false,
      });
      expect((await findInventoryGlAuditRows(tx)).filter((f) => f.reference === doc.doNumber)).toEqual([]);

      const asOf = await findInventoryGlDiffs(tx, { accountIds: [w.accounts.inventory.id], asOf: new Date(`${LATER}T00:00:00+07:00`) });
      expect(money(asOf.accounts[0]!.doUninvoiced)).toBe('4000000.00');
      expect(money(asOf.accounts[0]!.difference)).toBe('0.00');
      expect(asOf.accounts[0]!.qtyTimesAvg).toBeNull();
    });
  });

  it('a delivery note whose Out carries its own journal (JV-DO shape) is not counted as uninvoiced', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 1_000, avg: 10_000, day: DAY });
      const doc = await deliver(tx, w, DAY, [{ qty: 400 }]);
      // Delivery journal: DR a clearing account (stand-in) / CR the item's inventory account, the Out's value.
      const je = await journal(tx, w, DAY, w.accounts.receiptOffset.id, w.accounts.inventory.id, 4 * JT);
      await linkMovementJournal(tx, doc.items[0]!.stockMovementId!, je.id);
      expect(await accountRow(tx, w.accounts.inventory.id)).toEqual({
        gl: '6000000.00', book: '6000000.00', qtyTimesAvg: '6000000.00', doUninvoiced: '0.00', difference: '0.00',
        broken: false, reconciling: false,
      });
    });
  });

  it('finds a stock_value that no longer matches its movements', async () => {
    await inWorld(async (tx, w) => {
      await receiveStock(tx, w, { warehouseId: w.warehouseA.id, qty: 100, avg: 10_000, day: DAY });
      await tx.$executeRaw`UPDATE inventory_items SET stock_value = stock_value + 500 WHERE id = ${w.item.id}`;
      const breaks = (await findStockValueInvariantBreaks(tx)).rows.filter((r) => r.itemId === w.item.id);
      expect(breaks.map((r) => [r.kind, r.difference.toFixed(2)])).toEqual([['valueSum', '500.00'], ['average', '500.00']]);
      expect((await accountRow(tx, w.accounts.inventory.id)).difference).toBe('-500.00');
      await tx.$executeRaw`UPDATE inventory_items SET stock_value = stock_value - 500 WHERE id = ${w.item.id}`;
      expect((await findStockValueInvariantBreaks(tx)).rows.filter((r) => r.itemId === w.item.id)).toEqual([]);
    });
  });

  it('GET /health-check lists the inventory vs GL and stock value invariant checks', async () => {
    await inWorld(async (tx) => {
      const actor = await createCapUser(tx, []);
      const res = await callRoute(healthCheckRouter, 'get', '/', { userId: actor.userId, role: actor.role });
      expect(res.status).toBe(200);
      const names = (res.body as { data: { checks: { name: string; status: string }[] } }).data.checks.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['Inventory vs GL', 'Stock Value Invariant']));
    });
  });
});
