/**
 * The Inventory Variance account (role INVENTORY_VARIANCE) as the default offset of stock that
 * leaves without a counterparty: a manual Stock Out or Adjustment Out without an offset (PR-6.3a),
 * and later the stock count and the drift repair (owner decision #2). Real shrinkage must not land
 * in the rounding account or on a group, so posting to the default is refused while the role is
 * mapped to the same account as ROUNDING_ACCOUNT or to a group account; the accountant creates a
 * separate Inventory Variance detail account (the PRD suggests 6.38) and maps the role to it.
 * The health check (routes/health/inventoryChecks.ts) reports the same state ahead of time.
 */
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { missingMappingError, type MappedAccount } from '../systemAccounts';

type Db = Prisma.TransactionClient;

/** Error code (400): INVENTORY_VARIANCE is shared with ROUNDING_ACCOUNT or mapped to a group. */
export const INVENTORY_VARIANCE_UNSAFE = 'INVENTORY_VARIANCE_UNSAFE';

export type VarianceAccountState =
  | { status: 'ok'; account: MappedAccount }
  | { status: 'missing' }
  | { status: 'group' | 'shared'; account: MappedAccount };

async function firstMapping(db: Db, role: 'INVENTORY_VARIANCE' | 'ROUNDING_ACCOUNT') {
  return db.systemAccountMapping.findFirst({
    where: { role },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { account: { select: { id: true, accountNumber: true, name: true, isGroup: true } } },
  });
}

/** Read-only: whether the INVENTORY_VARIANCE mapping can take postings. */
export async function inspectVarianceAccount(db: Db): Promise<VarianceAccountState> {
  const [variance, rounding] = await Promise.all([firstMapping(db, 'INVENTORY_VARIANCE'), firstMapping(db, 'ROUNDING_ACCOUNT')]);
  if (!variance) return { status: 'missing' };
  const { isGroup, ...account } = variance.account;
  if (isGroup) return { status: 'group', account };
  if (rounding?.account.id === account.id) return { status: 'shared', account };
  return { status: 'ok', account };
}

/**
 * The INVENTORY_VARIANCE account for a posting. Throws ACCOUNT_MAPPING_MISSING when unmapped and
 * INVENTORY_VARIANCE_UNSAFE (400) when it is a group or the rounding account. Whether the account
 * is active is left to the posting's account rule.
 */
export async function assertVarianceAccountUsable(tx: Db): Promise<MappedAccount> {
  const state = await inspectVarianceAccount(tx);
  if (state.status === 'missing') throw missingMappingError('INVENTORY_VARIANCE');
  if (state.status === 'ok') return state.account;
  const { accountNumber, name } = state.account;
  throw new BusinessError(
    state.status === 'group'
      ? `Akun Selisih Persediaan dipetakan ke akun grup ${accountNumber} ${name}. Minta akuntan membuat akun rinci Selisih Persediaan dan memetakannya di Pengaturan > Akun Sistem.`
      : `Akun Selisih Persediaan sama dengan akun Pembulatan (${accountNumber} ${name}). Minta akuntan membuat akun rinci Selisih Persediaan tersendiri dan memetakannya di Pengaturan > Akun Sistem.`,
    INVENTORY_VARIANCE_UNSAFE,
  );
}

