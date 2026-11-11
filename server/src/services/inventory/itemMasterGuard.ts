// Guards on the inventory item master (E2-R6, E3-R5). The account is an ASSET detail account inside
// the inventory subtree (the group the INVENTORY role account sits in); the Persediaan control
// account and other item accounts are allowed because they are exactly what stock is posted to.
// Once an item carries stock, or has a delivery order not yet invoiced, the master fields that
// stock and its value depend on are locked: the account, the unit, and switching the item off.

import { Prisma, type PrismaClient } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { assertPostableAccount, TAX_ACCOUNT_ROLES, type PostableRule } from '../ledger/accountGuard';

type Tx = Prisma.TransactionClient;

export const ITEM_ACCOUNT_HAS_STOCK = 'ITEM_ACCOUNT_HAS_STOCK';
export const ITEM_ACCOUNT_NOT_INVENTORY = 'ITEM_ACCOUNT_NOT_INVENTORY';
export const ITEM_UNIT_IN_USE = 'ITEM_UNIT_IN_USE';
export const ITEM_HAS_STOCK = 'ITEM_HAS_STOCK';

export const ITEM_ACCOUNT_RULE: PostableRule = {
  label: 'Akun persediaan item',
  rootTypes: ['ASSET'],
  allowControl: ['INVENTORY', 'INVENTORY_ITEM'],
  alsoRestrict: TAX_ACCOUNT_ROLES,
};

/** The account stock posts to: the item's own, else the account mapped to the INVENTORY role. */
export async function inventoryAccountFor(tx: Tx, item: { accountId: string | null }): Promise<string | null> {
  if (item.accountId) return item.accountId;
  const mapped = await tx.systemAccountMapping.findFirst({
    where: { role: 'INVENTORY' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { accountId: true },
  });
  return mapped?.accountId ?? null;
}

const MAX_TREE_DEPTH = 12;

/** True when the account is `groupId` or sits anywhere below it in the chart. */
async function isInSubtree(tx: Tx, accountId: string, groupId: string): Promise<boolean> {
  let current: string | null = accountId;
  for (let depth = 0; current && depth < MAX_TREE_DEPTH; depth++) {
    if (current === groupId) return true;
    const row: { parentId: string | null } | null = await tx.account.findUnique({ where: { id: current }, select: { parentId: true } });
    current = row?.parentId ?? null;
  }
  return false;
}

/**
 * The inventory subtree is the parent group of the account mapped to the INVENTORY role (1.4 for
 * 1.4.0). Without a mapping, or a mapped account that has no parent, no subtree can be named and
 * only ITEM_ACCOUNT_RULE applies.
 */
async function inventoryGroupId(tx: Tx): Promise<string | null> {
  const mappedId = await inventoryAccountFor(tx, { accountId: null });
  if (!mappedId) return null;
  const mapped = await tx.account.findUnique({ where: { id: mappedId }, select: { parentId: true } });
  return mapped?.parentId ?? null;
}

/** POST: the account must be a valid item account inside the inventory subtree; a new item has no stock. */
export async function assertItemAccountValid(tx: Tx, accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  await assertPostableAccount(tx, accountId, ITEM_ACCOUNT_RULE);
  const groupId = await inventoryGroupId(tx);
  if (groupId && !(await isInSubtree(tx, accountId, groupId))) {
    const acc = await tx.account.findUnique({ where: { id: accountId }, select: { accountNumber: true, name: true } });
    const label = acc ? `${acc.accountNumber} ${acc.name}` : accountId;
    throw new BusinessError(
      `Akun persediaan item: akun ${label} bukan bagian dari kelompok akun Persediaan.`,
      ITEM_ACCOUNT_NOT_INVENTORY,
    );
  }
}

/**
 * PUT: `newAccountId` is the requested `accountId` (null clears it). Does nothing when the stored
 * account is kept. Otherwise the new account must be valid and, when the account that stock posts
 * to actually changes, the item must hold no stock (quantity 0 in the item and every warehouse;
 * negative stock counts as stock). Call it in the transaction that holds the item row lock.
 */
export async function assertItemAccountChange(tx: Tx, itemId: string, newAccountId: string | null): Promise<void> {
  const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { accountId: true, currentStock: true } });
  if (!item || item.accountId === newAccountId) return;

  await assertItemAccountValid(tx, newAccountId);

  const [before, after] = await Promise.all([
    inventoryAccountFor(tx, item),
    inventoryAccountFor(tx, { accountId: newAccountId }),
  ]);
  if (before === after) return;

  if (await itemHoldsStock(tx, itemId, item.currentStock)) {
    throw new BusinessError(
      'Akun persediaan item tidak dapat diganti selama item masih memiliki stok (termasuk stok negatif). Kosongkan stok di semua gudang terlebih dahulu.',
      ITEM_ACCOUNT_HAS_STOCK,
    );
  }
  if (await itemHasUninvoicedDelivery(tx, itemId)) {
    throw new BusinessError(
      'Akun persediaan item tidak dapat diganti selama item masih ada di Surat Jalan yang belum ditagih. Buat Invoice dari Surat Jalan itu atau batalkan dulu.',
      ITEM_ACCOUNT_HAS_STOCK,
    );
  }
}

/** Stock on hand, negative included, in the item total or in any warehouse. */
async function itemHoldsStock(tx: Tx, itemId: string, itemTotal: Prisma.Decimal): Promise<boolean> {
  if (!itemTotal.isZero()) return true;
  return (await tx.inventoryStock.count({ where: { itemId, currentStock: { not: 0 } } })) > 0;
}

/** A submitted delivery order (Surat Jalan) naming the item that no Invoice has picked up yet. */
async function itemHasUninvoicedDelivery(tx: Tx, itemId: string): Promise<boolean> {
  const n = await tx.deliveryOrderItem.count({
    where: { inventoryItemId: itemId, deliveryOrder: { status: 'Submitted', invoiceId: null } },
  });
  return n > 0;
}

export interface ItemMasterPatch {
  unit?: string;
  isActive?: boolean;
  /** The requested accountId; null clears it, undefined leaves it. */
  accountId?: string | null;
}

/**
 * PUT: one entry point for the master fields stock depends on. Call it in the transaction that holds
 * the item row lock. Unit: refused while the item has an active movement or any stock. Deactivating: refused while the item has stock or an uninvoiced delivery order. Account: see
 * assertItemAccountChange. Anything else on the item (name, category, minimum stock) is free.
 */
export async function assertItemChangeAllowed(tx: Tx, itemId: string, patch: ItemMasterPatch): Promise<void> {
  const item = await tx.inventoryItem.findUnique({
    where: { id: itemId },
    select: { unit: true, isActive: true, currentStock: true },
  });
  if (!item) return;

  if (patch.unit !== undefined && patch.unit !== item.unit) {
    const used = (await tx.stockMovement.count({ where: { itemId, isCancelled: false } })) > 0
      || (await itemHoldsStock(tx, itemId, item.currentStock));
    if (used) {
      throw new BusinessError(
        'Satuan item tidak dapat diganti karena item sudah punya mutasi stok atau stok. Buat item baru dengan satuan yang diinginkan.',
        ITEM_UNIT_IN_USE,
      );
    }
  }

  if (patch.isActive === false && item.isActive) {
    if ((await itemHoldsStock(tx, itemId, item.currentStock)) || (await itemHasUninvoicedDelivery(tx, itemId))) {
      throw new BusinessError(
        'Item tidak dapat dinonaktifkan selama masih memiliki stok (termasuk stok negatif) atau ada di Surat Jalan yang belum ditagih.',
        ITEM_HAS_STOCK,
      );
    }
  }

  if (patch.accountId !== undefined) await assertItemAccountChange(tx, itemId, patch.accountId);
}

/** Master rows that were switched off while they still hold stock (read-only report, e3-inactive-master-stock). */
export interface InactiveMasterFinding {
  kind: 'item' | 'warehouse';
  id: string;
  code: string;
  name: string;
  quantity: string;
  uninvoicedDeliveries: number;
}

export async function findInactiveMasterWithStock(db: Tx | PrismaClient): Promise<InactiveMasterFinding[]> {
  const [items, warehouses] = await Promise.all([
    db.inventoryItem.findMany({
      where: { isActive: false },
      select: { id: true, code: true, name: true, currentStock: true, stocks: { select: { currentStock: true } } },
    }),
    db.warehouse.findMany({
      where: { isActive: false },
      select: { id: true, code: true, name: true, stocks: { where: { currentStock: { not: 0 } }, select: { currentStock: true } } },
    }),
  ]);
  const findings: InactiveMasterFinding[] = [];
  for (const i of items) {
    const sj = await db.deliveryOrderItem.count({
      where: { inventoryItemId: i.id, deliveryOrder: { status: 'Submitted', invoiceId: null } },
    });
    const held = !i.currentStock.isZero() || i.stocks.some((s) => !s.currentStock.isZero());
    if (held || sj > 0) {
      findings.push({ kind: 'item', id: i.id, code: i.code, name: i.name, quantity: i.currentStock.toString(), uninvoicedDeliveries: sj });
    }
  }
  for (const w of warehouses) {
    if (w.stocks.length === 0) continue;
    const total = w.stocks.reduce((sum, s) => sum.plus(s.currentStock), new Prisma.Decimal(0));
    findings.push({ kind: 'warehouse', id: w.id, code: w.code, name: w.name, quantity: total.toString(), uninvoicedDeliveries: 0 });
  }
  return findings;
}
