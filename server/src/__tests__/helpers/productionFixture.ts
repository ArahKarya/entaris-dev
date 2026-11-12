import type { Prisma } from '@prisma/client';
import { expect } from 'vitest';
import { computeImpact } from '../../utils/accountBalance';
import { systemAccounts } from '../../services/systemAccounts';
import { createFiscalYear } from './periodFixture';
import { seedStock } from './inventoryFixture';

type Tx = Prisma.TransactionClient;

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export interface ProductionWorld {
  userId: string;
  year: number;
  warehouseA: { id: string };
  warehouseB: { id: string };
  /** Leaf accounts everything below posts to; the mapping is pointed at them inside the tx. */
  accounts: { inventory: { id: string }; cogs: { id: string }; conversion: { id: string } };
  items: Record<'gkp' | 'gkg' | 'beras' | 'bekatul' | 'pk' | 'karung', { id: string; name: string }>;
}

async function leaf(tx: Tx, label: string, type: 'ASSET' | 'EXPENSE') {
  return tx.account.create({
    data: { name: `IT-6.1a ${label}`, accountNumber: `IT-61A-${label}-${tag()}`, accountType: type, rootType: type },
  });
}

async function mapRole(tx: Tx, role: string, accountId: string) {
  await tx.systemAccountMapping.deleteMany({ where: { role } });
  await tx.systemAccountMapping.create({ data: { role, accountId } });
}

async function makeItem(tx: Tx, label: string, unit: string, accountId: string) {
  return tx.inventoryItem.create({
    data: { code: `IT-61A-${label}-${tag()}`, name: `IT-6.1a ${label}`, unit, isActive: true, accountId },
  });
}

/**
 * Self-contained production fixture, to be built inside a rollback transaction: a fiscal year, two
 * warehouses, leaf accounts for inventory / COGS / conversion (the latter two mapped to the system
 * roles, because a database may map COGS to a group account), and the items of the production
 * scenarios (GKP and GKG paddy, rice, bran, PK, and a Pcs sack). No stock is seeded; use seedStock.
 */
export async function createProductionWorld(tx: Tx, year: number): Promise<ProductionWorld> {
  await createFiscalYear(tx, { year });
  const user = await tx.user.findFirstOrThrow({ where: { role: 'Admin', isActive: true } });
  const inventory = await leaf(tx, 'INV', 'ASSET');
  const cogs = await leaf(tx, 'COGS', 'EXPENSE');
  const conversion = await leaf(tx, 'CONV', 'EXPENSE');
  await mapRole(tx, 'COGS', cogs.id);
  await mapRole(tx, 'PRODUCTION_CONVERSION', conversion.id);
  await mapRole(tx, 'INVENTORY', inventory.id);
  systemAccounts.invalidateCache();

  const warehouseA = await tx.warehouse.create({ data: { code: `IT-WA-${tag()}`, name: 'IT-6.1a gudang A' } as any });
  const warehouseB = await tx.warehouse.create({ data: { code: `IT-WB-${tag()}`, name: 'IT-6.1a gudang B' } as any });
  const [gkp, gkg, beras, bekatul, pk, karung] = await Promise.all([
    makeItem(tx, 'GKP', 'Kg', inventory.id),
    makeItem(tx, 'GKG', 'Kg', inventory.id),
    makeItem(tx, 'BERAS', 'Kg', inventory.id),
    makeItem(tx, 'BEKATUL', 'Kg', inventory.id),
    makeItem(tx, 'PK', 'Kg', inventory.id),
    makeItem(tx, 'KARUNG', 'Pcs', inventory.id),
  ]);
  return {
    userId: user.id,
    year,
    warehouseA,
    warehouseB,
    accounts: { inventory, cogs, conversion },
    items: { gkp, gkg, beras, bekatul, pk, karung },
  };
}

export const worldDate = (world: ProductionWorld, monthDay = '03-05') => `${world.year}-${monthDay}`;

export function seedWorldStock(
  tx: Tx,
  world: ProductionWorld,
  item: keyof ProductionWorld['items'],
  qty: number,
  avg: number,
  warehouse: 'A' | 'B' = 'A',
) {
  return seedStock(tx, {
    itemId: world.items[item].id,
    warehouseId: (warehouse === 'A' ? world.warehouseA : world.warehouseB).id,
    qty,
    avg,
    date: worldDate(world, '01-02'),
    userId: world.userId,
  });
}

/** Journal lines of one entry as account role -> { debit, credit } (summed per account). */
export async function journalLinesByRole(tx: Tx, world: ProductionWorld, entryNumber: string) {
  const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber }, include: { items: true } });
  const roleOf = new Map<string, string>([
    [world.accounts.inventory.id, 'inventory'],
    [world.accounts.cogs.id, 'cogs'],
    [world.accounts.conversion.id, 'conversion'],
  ]);
  const lines: Record<string, { debit: number; credit: number }> = {};
  for (const item of je.items) {
    const role = roleOf.get(item.accountId) ?? item.accountId;
    const acc = (lines[role] ??= { debit: 0, credit: 0 });
    acc.debit = Math.round((acc.debit + Number(item.debit)) * 100) / 100;
    acc.credit = Math.round((acc.credit + Number(item.credit)) * 100) / 100;
  }
  return { status: je.status, lines };
}

/** Stock movements of a production run, by item, oldest first, as plain numbers. */
export async function movementsOf(tx: Tx, runId: string, opts: { activeOnly?: boolean } = {}) {
  const rows = await tx.stockMovement.findMany({
    where: { referenceType: 'ProductionRun', referenceId: runId, ...(opts.activeOnly ? { isCancelled: false } : {}) },
    orderBy: { movementNumber: 'asc' },
  });
  return rows.map((m) => ({
    itemId: m.itemId,
    type: m.movementType,
    quantity: Number(m.quantity),
    unitCost: Number(m.unitCost),
    totalValue: Number(m.totalValue),
    unitCostLoaded: m.unitCostLoaded == null ? null : Number(m.unitCostLoaded),
    isCancelled: m.isCancelled,
  }));
}

/** Every fixture account's stored balance equals the sum of its live ledger entries. */
export async function assertBalancesMatchAle(tx: Tx, world: ProductionWorld) {
  const ids = Object.values(world.accounts).map((a) => a.id);
  const accounts = await tx.account.findMany({ where: { id: { in: ids } } });
  for (const acc of accounts) {
    const entries = await tx.accountingLedgerEntry.findMany({ where: { accountId: acc.id, isCancelled: false } });
    const fromAle = entries.reduce((s, e) => s + computeImpact(acc.rootType, Number(e.debit), Number(e.credit)), 0);
    expect(Number(acc.balance), `balance of ${acc.accountNumber}`).toBeCloseTo(fromAle, 2);
  }
}
