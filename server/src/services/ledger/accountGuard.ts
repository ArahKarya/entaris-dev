// Single guard for "may this account be posted to directly?". An account must exist, be a detail
// (non-group) account, be active, have an allowed root type and, unless the rule allows it, not be
// a control account whose balance is owned by a subledger (AR, AP, deposits, GRNI, inventory).
// Reads only through the caller's transaction, never the process-wide systemAccounts cache, so a
// mapping changed in the same transaction (or by another instance) is always seen.

import type { Prisma, RootType } from '@prisma/client';
import type { SystemAccountRole } from '../../types/systemAccounts';
import { BusinessError } from '../../utils/errors';

type Tx = Prisma.TransactionClient;

/** Roles whose account balance must equal a subledger; posting there bypasses the module. */
export const CONTROL_ACCOUNT_ROLES = [
  'AR',
  'AP',
  'VENDOR_DEPOSIT',
  'CUSTOMER_DEPOSIT',
  'ACCRUED_PAYABLE',
  'INVENTORY',
] as const satisfies readonly SystemAccountRole[];

/** Not control accounts (the tax report is built from documents); opt in per rule via alsoRestrict. */
export const TAX_ACCOUNT_ROLES = ['TAX_INPUT', 'TAX_OUTPUT'] as const satisfies readonly SystemAccountRole[];

/** Item inventory accounts (InventoryItem.accountId with rootType ASSET) that no role maps. */
export const INVENTORY_ITEM = 'INVENTORY_ITEM';

export type ControlRole = (typeof CONTROL_ACCOUNT_ROLES)[number];
export type ControlKind = ControlRole | typeof INVENTORY_ITEM;
export type RestrictedKind = ControlKind | SystemAccountRole;

export const ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND';
export const ACCOUNT_GROUP = 'ACCOUNT_GROUP';
export const ACCOUNT_INACTIVE = 'ACCOUNT_INACTIVE';
export const ACCOUNT_ROOT_TYPE = 'ACCOUNT_ROOT_TYPE';
export const ACCOUNT_CONTROL = 'ACCOUNT_CONTROL';

/** Indonesian names for the error message (each has an exact i18n entry). */
const KIND_LABELS: Partial<Record<RestrictedKind, string>> = {
  AR: 'Piutang Usaha',
  AP: 'Hutang Usaha',
  VENDOR_DEPOSIT: 'Uang Muka Supplier',
  CUSTOMER_DEPOSIT: 'Uang Muka Customer',
  ACCRUED_PAYABLE: 'Hutang Belum Tagih',
  INVENTORY: 'Persediaan',
  INVENTORY_ITEM: 'Persediaan item',
  TAX_INPUT: 'PPN Masukan',
  TAX_OUTPUT: 'PPN Keluaran',
};

export interface PostableRule {
  /** What the account is for, as the message prefix, e.g. "Akun lawan". */
  label: string;
  rootTypes?: readonly RootType[];
  /** true allows every control and alsoRestrict account; a list allows only those kinds. Default false. */
  allowControl?: boolean | readonly RestrictedKind[];
  /** Extra roles treated like control accounts for this rule, e.g. TAX_ACCOUNT_ROLES for manual journals. */
  alsoRestrict?: readonly SystemAccountRole[];
  /** Appended to the control-account message, e.g. "Gunakan modul Pembayaran." */
  controlHint?: string;
}

export interface AccountLite {
  id: string;
  accountNumber: string;
  name: string;
  rootType: RootType;
  isGroup: boolean;
  isActive: boolean;
}

export interface AccountProblem {
  code: string;
  message: string;
}

const ACCOUNT_LITE_SELECT = {
  id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true,
} as const;

/**
 * Account id -> restricted kind for the control roles (plus extraRoles) and item inventory
 * accounts. A role mapping wins over the item-account kind for the same account.
 */
export async function loadControlAccountMap(
  tx: Tx,
  extraRoles: readonly SystemAccountRole[] = [],
): Promise<Map<string, RestrictedKind>> {
  const roles = [...new Set<string>([...CONTROL_ACCOUNT_ROLES, ...extraRoles])];
  const [mappings, items] = await Promise.all([
    tx.systemAccountMapping.findMany({ where: { role: { in: roles } }, select: { role: true, accountId: true } }),
    tx.inventoryItem.findMany({
      where: { accountId: { not: null }, account: { rootType: 'ASSET' } },
      select: { accountId: true },
      distinct: ['accountId'],
    }),
  ]);
  const map = new Map<string, RestrictedKind>();
  for (const item of items) if (item.accountId) map.set(item.accountId, INVENTORY_ITEM);
  for (const m of mappings) map.set(m.accountId, m.role as RestrictedKind);
  return map;
}

/** The control kind of an account, or null when it is not a control account. */
export async function isControlAccount(tx: Tx, accountId: string): Promise<ControlKind | null> {
  return ((await loadControlAccountMap(tx)).get(accountId) as ControlKind | undefined) ?? null;
}

function controlAllowed(kind: RestrictedKind, allow: PostableRule['allowControl']): boolean {
  if (allow === true) return true;
  return Array.isArray(allow) && allow.includes(kind);
}

/** Why the account cannot be posted under the rule, or null. `restricted` = its kind from the control map. */
export function postableAccountProblem(
  acc: AccountLite | null,
  rule: PostableRule,
  restricted: RestrictedKind | null,
): AccountProblem | null {
  if (!acc) {
    return { code: ACCOUNT_NOT_FOUND, message: `${rule.label}: akun tidak ditemukan.` };
  }
  if (acc.isGroup) {
    return { code: ACCOUNT_GROUP, message: `${rule.label}: ${acc.accountNumber} ${acc.name} adalah akun grup; pilih akun detail.` };
  }
  if (!acc.isActive) {
    return { code: ACCOUNT_INACTIVE, message: `${rule.label}: akun ${acc.accountNumber} ${acc.name} tidak aktif.` };
  }
  if (rule.rootTypes && !rule.rootTypes.includes(acc.rootType)) {
    return {
      code: ACCOUNT_ROOT_TYPE,
      message: `${rule.label}: akun ${acc.accountNumber} ${acc.name} bertipe ${acc.rootType}, seharusnya ${rule.rootTypes.join('/')}.`,
    };
  }
  if (restricted && !controlAllowed(restricted, rule.allowControl)) {
    const kindLabel = KIND_LABELS[restricted] ?? restricted;
    const hint = rule.controlHint ? ` ${rule.controlHint}` : '';
    return {
      code: ACCOUNT_CONTROL,
      message: `${rule.label}: akun ${acc.accountNumber} ${acc.name} adalah akun kontrol ${kindLabel} dan tidak boleh diposting langsung.${hint}`,
    };
  }
  return null;
}

/** Loads the accounts and throws BusinessError (with an ACCOUNT_* code) on the first problem. */
export async function assertPostableAccounts(
  tx: Tx,
  ids: readonly string[],
  rule: PostableRule,
): Promise<Map<string, AccountLite>> {
  const unique = [...new Set(ids)];
  const needsControlMap = rule.allowControl !== true;
  const [accounts, control] = await Promise.all([
    tx.account.findMany({ where: { id: { in: unique } }, select: ACCOUNT_LITE_SELECT }),
    needsControlMap ? loadControlAccountMap(tx, rule.alsoRestrict) : Promise.resolve(new Map<string, RestrictedKind>()),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of unique) {
    const problem = postableAccountProblem(byId.get(id) ?? null, rule, control.get(id) ?? null);
    if (problem) throw new BusinessError(problem.message, problem.code);
  }
  return byId;
}

/** Single-account form of assertPostableAccounts. */
export async function assertPostableAccount(tx: Tx, accountId: string, rule: PostableRule): Promise<AccountLite> {
  const map = await assertPostableAccounts(tx, [accountId], rule);
  return map.get(accountId)!;
}
