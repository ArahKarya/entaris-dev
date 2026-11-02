// Which account an inventory item may keep its stock value in (E2-R6). The account is an ASSET
// detail account; the Persediaan control account and other item accounts are allowed because they
// are exactly what stock is posted to. Changing it while any stock is on hand would leave that
// value on the old account, so it is refused until the stock is zero everywhere.

import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { assertPostableAccount, TAX_ACCOUNT_ROLES, type PostableRule } from '../ledger/accountGuard';

type Tx = Prisma.TransactionClient;

export const ITEM_ACCOUNT_HAS_STOCK = 'ITEM_ACCOUNT_HAS_STOCK';

export const ITEM_ACCOUNT_RULE: PostableRule = {
  label: 'Akun persediaan item',
  rootTypes: ['ASSET'],
  allowControl: ['INVENTORY', 'INVENTORY_ITEM'],
  alsoRestrict: TAX_ACCOUNT_ROLES,
};

/** The account stock posts to: the item's own, else the account mapped to the INVENTORY role. */
async function effectiveAccountId(tx: Tx, accountId: string | null): Promise<string | null> {
  if (accountId) return accountId;
  const mapped = await tx.systemAccountMapping.findFirst({
    where: { role: 'INVENTORY' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { accountId: true },
  });
  return mapped?.accountId ?? null;
}

/** POST: the account only has to be a valid item account; a new item has no stock. */
export async function assertItemAccountValid(tx: Tx, accountId: string | null | undefined): Promise<void> {
  if (accountId) await assertPostableAccount(tx, accountId, ITEM_ACCOUNT_RULE);
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
    effectiveAccountId(tx, item.accountId),
    effectiveAccountId(tx, newAccountId),
  ]);
  if (before === after) return;

  const warehouseStock = await tx.inventoryStock.count({ where: { itemId, currentStock: { not: 0 } } });
  if (!item.currentStock.isZero() || warehouseStock > 0) {
    throw new BusinessError(
      'Akun persediaan item tidak dapat diganti selama item masih memiliki stok (termasuk stok negatif). Kosongkan stok di semua gudang terlebih dahulu.',
      ITEM_ACCOUNT_HAS_STOCK,
    );
  }
}
