// Rules for saving system account mappings (E2-R8). Pure: the route loads the rows, this decides
// which (role, account) pairs are new and whether two roles with different meanings would share
// an account. Pairs already stored are never re-checked, so saving an unrelated role cannot be
// blocked by legacy data (those are reported by the mapping audit instead).

import {
  ACCOUNT_ROLE_CONFLICT,
  EXCLUSIVE_MAPPING_ROLES,
  type SystemAccountRole,
} from '../types/systemAccounts';

export interface MappingPair {
  role: string;
  accountId: string;
}

const pairKey = (p: MappingPair): string => `${p.role}:${p.accountId}`;
const EXCLUSIVE = new Set<string>(EXCLUSIVE_MAPPING_ROLES);

/** Requested pairs that are not already stored: the only ones that get validated. */
export function changedMappings(requested: readonly MappingPair[], stored: readonly MappingPair[]): MappingPair[] {
  const existing = new Set(stored.map(pairKey));
  return requested.filter((p) => !existing.has(pairKey(p)));
}

/** Mapping state after the save: stored rows of roles that are not touched, plus the requested rows. */
export function resultingMappings(
  requested: readonly MappingPair[],
  stored: readonly MappingPair[],
  touchedRoles: ReadonlySet<string>,
): MappingPair[] {
  return [...stored.filter((p) => !touchedRoles.has(p.role)), ...requested];
}

export interface RoleConflict {
  code: typeof ACCOUNT_ROLE_CONFLICT;
  role: SystemAccountRole;
  otherRole: SystemAccountRole;
  accountId: string;
}

/**
 * First changed pair whose account is also held, after the save, by a different role when either of the two is exclusive.
 * Only changed pairs are examined, so an old shared mapping does not block unrelated edits.
 */
export function findRoleConflict(changed: readonly MappingPair[], after: readonly MappingPair[]): RoleConflict | null {
  for (const pair of changed) {
    const other = after.find(
      (p) => p.accountId === pair.accountId && p.role !== pair.role && (EXCLUSIVE.has(pair.role) || EXCLUSIVE.has(p.role)),
    );
    if (other) {
      return {
        code: ACCOUNT_ROLE_CONFLICT,
        role: pair.role as SystemAccountRole,
        otherRole: other.role as SystemAccountRole,
        accountId: pair.accountId,
      };
    }
  }
  return null;
}
