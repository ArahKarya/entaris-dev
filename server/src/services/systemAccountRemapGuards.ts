// Checks of one system account mapping save before any reclass is posted (E2-R8, plan step 4
// §4 PR-4.12), and the role move history it writes. A balance-sheet role's balance can only move
// with it when the old account holds that role alone: an account two roles share is not split,
// two roles leaving one account in the same save are refused, as is a role moving onto the
// account another moving role leaves (its balance would be planned before the first reclass
// lands). A balance-sheet role is not cleared while its account holds a balance, and INVENTORY
// does not move while items keep their stock on the old account under their own account setting.

import { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { SYSTEM_ACCOUNT_ROLES, type SystemAccountRole } from '../types/systemAccounts';
import type { MappingPair } from './systemAccountMappingRules';
import { accountResidue, hasResidue, isReclassRole, type BalancePlan, type RemapPlan } from './systemAccountRemap';

type Tx = Prisma.TransactionClient;

export const ACCOUNT_SHARED_WITH_ROLE = 'ACCOUNT_SHARED_WITH_ROLE';
export const REMAP_CHAIN = 'REMAP_CHAIN';
export const ROLE_CLEAR_HAS_BALANCE = 'ROLE_CLEAR_HAS_BALANCE';
export const INVENTORY_ACCOUNT_ITEMS = 'INVENTORY_ACCOUNT_ITEMS';

const label = (role: string) => SYSTEM_ACCOUNT_ROLES[role as SystemAccountRole].label;
const accountText = (a: { accountNumber: string; name: string }) => `${a.accountNumber} ${a.name}`.trim();

/**
 * Splits the balance plans of a save: `reclass` carry their balance, `shared` keep it because
 * another role still maps the old account after the save (`after`), so the account's balance is
 * not this role's alone. Refuses (ACCOUNT_SHARED_WITH_ROLE) a transfer asked for such a balance,
 * and two roles leaving one account with a balance in the same save. Pure.
 */
export function splitSharedPlans(
  plans: readonly RemapPlan[],
  after: readonly MappingPair[],
  transferBalance: boolean,
): { reclass: RemapPlan[]; shared: BalancePlan[] } {
  const reclass: RemapPlan[] = [];
  const shared: BalancePlan[] = [];
  for (const p of plans) {
    if (p.kind !== 'balance') {
      reclass.push(p);
      continue;
    }
    const leaving = plans.find((q) => q !== p && q.kind === 'balance' && q.from.id === p.from.id);
    if (leaving && hasResidue(p)) {
      throw new BusinessError(
        `Peran ${label(p.role)} dan peran ${label(leaving.role)} meninggalkan akun ${accountText(p.from)} yang bersaldo dalam simpanan yang sama; saldonya tidak dapat dipisah per peran. Pindahkan peran itu satu per satu.`,
        ACCOUNT_SHARED_WITH_ROLE,
      );
    }
    const keeper = after.find((m) => m.accountId === p.from.id && m.role !== p.role);
    if (!keeper) {
      reclass.push(p);
      continue;
    }
    if (hasResidue(p) && transferBalance) {
      throw new BusinessError(
        `Peran ${label(p.role)}: akun lama ${accountText(p.from)} juga dipakai peran ${label(keeper.role)}, jadi saldonya tidak dapat dipisah per peran dan tidak dipindahkan. Simpan peran ini tanpa memindahkan saldo.`,
        ACCOUNT_SHARED_WITH_ROLE,
      );
    }
    shared.push(p);
  }
  return { reclass, shared };
}

/**
 * Refuses a save where a balance-sheet role moves onto the account another balance-sheet role
 * leaves (a swap or a chain) while either holds a balance: the second balance would be read before
 * the first reclass lands on it. Pure.
 */
export function assertNoRemapChain(plans: readonly RemapPlan[]): void {
  for (const p of plans) {
    if (p.kind !== 'balance') continue;
    const source = plans.find((q) => q !== p && q.kind === 'balance' && q.from.id === p.to.id);
    if (source && (hasResidue(p) || hasResidue(source))) {
      throw new BusinessError(
        `Peran ${label(p.role)} pindah ke akun ${accountText(p.to)} yang ditinggalkan peran ${label(source.role)} dalam simpanan yang sama. Pindahkan satu peran per simpan, lewat akun lain bila perlu.`,
        REMAP_CHAIN,
      );
    }
  }
}

/** A balance-sheet single-account role cleared in this save, with the account it leaves. */
export interface RoleClear {
  role: SystemAccountRole;
  fromAccountId: string;
}

/**
 * Balance-sheet single-account roles this save clears (in clearRoles, not mapped again), with the
 * one account they leave. Refuses (ROLE_CLEAR_HAS_BALANCE) a clear whose account still holds a
 * balance and no other role maps it after the save: the balance would stay on an account that no
 * longer belongs to any role.
 */
export async function planRoleClears(
  tx: Tx,
  clearRoles: readonly string[],
  requested: readonly MappingPair[],
  stored: readonly MappingPair[],
  after: readonly MappingPair[],
): Promise<RoleClear[]> {
  const out: RoleClear[] = [];
  for (const role of [...new Set(clearRoles)].sort()) {
    if (requested.some((m) => m.role === role) || !isReclassRole(role as SystemAccountRole)) continue;
    const before = stored.filter((m) => m.role === role);
    if (before.length !== 1) continue;
    const fromAccountId = before[0].accountId;
    out.push({ role: role as SystemAccountRole, fromAccountId });
    if (after.some((m) => m.accountId === fromAccountId)) continue;
    const residue = await accountResidue(tx, role as SystemAccountRole, fromAccountId);
    if (residue.length === 0) continue;
    const account = await tx.account.findUnique({ where: { id: fromAccountId }, select: { accountNumber: true, name: true } });
    const net = residue.reduce((sum, l) => sum.plus(l.amount), new Prisma.Decimal(0));
    throw new BusinessError(
      `Peran ${label(role)}: akun ${account ? accountText(account) : fromAccountId} masih bersaldo ${net.toFixed(2)}. Peran neraca yang akunnya bersaldo tidak dapat dilepas; pindahkan ke akun lain beserta saldonya.`,
      ROLE_CLEAR_HAS_BALANCE,
    );
  }
  return out;
}

/**
 * INVENTORY moving with its balance: refused (INVENTORY_ACCOUNT_ITEMS) while items with stock name
 * the old account as their own account. Their stock would be reclassed while their postings keep
 * going to the old account. Clearing the item account first is allowed (it resolves to the same
 * account) and takes their stock along.
 */
export async function assertInventoryItemsFollow(tx: Tx, plans: readonly BalancePlan[]): Promise<void> {
  for (const p of plans) {
    if (p.role !== 'INVENTORY') continue;
    const items = await tx.inventoryItem.count({
      where: {
        accountId: p.from.id,
        OR: [{ currentStock: { not: 0 } }, { stocks: { some: { currentStock: { not: 0 } } } }],
      },
    });
    if (items > 0) {
      throw new BusinessError(
        `Peran ${label(p.role)}: ${items} barang bersaldo stok memakai akun lama ${accountText(p.from)} sebagai akun persediaannya sendiri. Kosongkan akun persediaan di barang itu dulu (barang lalu memakai akun peran), baru pindahkan peran.`,
        INVENTORY_ACCOUNT_ITEMS,
      );
    }
  }
}

export interface RoleMove {
  role: SystemAccountRole;
  fromAccountId: string;
  /** null for a clear. */
  toAccountId: string | null;
}

/**
 * Writes one history row per balance-sheet role move or clear of this save, also when nothing was
 * reclassed, so the old account stays a former role account (services/ledger/partyRules.ts
 * loadFormerRoleMoves). Called after the reclass journals, so the move time follows them.
 */
export async function recordRoleMoves(
  tx: Tx,
  moves: readonly RoleMove[],
  opts: { actorId: string; reason?: string },
): Promise<void> {
  if (moves.length === 0) return;
  const movedAt = new Date();
  await tx.systemAccountRoleMove.createMany({
    data: moves.map((m) => ({
      role: m.role,
      fromAccountId: m.fromAccountId,
      toAccountId: m.toAccountId,
      movedBy: opts.actorId,
      reason: opts.reason || null,
      movedAt,
    })),
  });
}
