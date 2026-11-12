// Single guard for "may this account be posted to directly?". An account must exist, be a detail
// (non-group) account, be active, have an allowed root type and, unless the rule allows it, not be
// a control account whose balance is owned by a subledger (AR, AP, deposits, GRNI, inventory).
// Reads only through the caller's transaction, never the process-wide systemAccounts cache, so a
// mapping changed in the same transaction (or by another instance) is always seen.

import { Prisma, type RootType } from '@prisma/client';
import type { SystemAccountRole } from '../../types/systemAccounts';
import { BusinessError } from '../../utils/errors';
import { loadFormerRoleMoves } from './partyRules';

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
  OPENING_EQUITY: 'Ekuitas Saldo Awal',
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
  /**
   * Accept a group or inactive account. Only the source side of a system account remap reclass
   * uses it (REMAP_SOURCE_RULE in services/systemAccountRemap.ts): the balance must leave an old
   * mapping wherever it sits. Default false.
   */
  allowGroupOrInactive?: boolean;
  /**
   * The account must not be the parent group of the account mapped to `role`, nor sit anywhere
   * below it (1.4 for the INVENTORY account 1.4.0), so an unmapped sibling of the inventory
   * accounts is refused too. Without a mapping or a mapped account that has a parent, no group can
   * be named and the restriction does not apply. Refused with `code`.
   */
  outsideGroupOf?: { role: SystemAccountRole; code: string };
}

/** Control kinds a journal.control holder may post manually; the deposit roles are never among them. */
export const MANUAL_CONTROL_KINDS = [
  'AR',
  'AP',
  'INVENTORY',
  INVENTORY_ITEM,
  'TAX_INPUT',
  'TAX_OUTPUT',
  'ACCRUED_PAYABLE',
] as const satisfies readonly RestrictedKind[];

const DEPOSIT_HINT = 'Akun uang muka hanya bisa dikoreksi lewat modul Uang Muka.';
const NO_CONTROL_RIGHT_HINT = 'Butuh hak Jurnal ke akun kontrol (journal.control); akun uang muka hanya lewat modul Uang Muka.';
const CANCEL_CONTROL_HINT = 'Membatalkan jurnal yang memuat akun kontrol butuh hak Jurnal ke akun kontrol (journal.control).';

/**
 * Lines a person enters (manual journal, journal import, cash book). Control and tax accounts need
 * the journal.control capability. Customer and supplier deposit accounts are refused even then:
 * their subledger is built from deposit documents only, so corrections go through the Deposits module.
 */
export function manualJournalRule(canControl: boolean): PostableRule {
  return {
    label: 'Akun jurnal',
    allowControl: canControl ? MANUAL_CONTROL_KINDS : false,
    alsoRestrict: TAX_ACCOUNT_ROLES,
    controlHint: canControl ? DEPOSIT_HINT : NO_CONTROL_RIGHT_HINT,
  };
}

/**
 * Cancelling a hand-made journal from the Journal menu reverses its lines, which moves the same
 * balances a posting would. Control and tax accounts therefore need journal.control here too.
 * With it every kind may be reversed, deposit accounts included: an old manual or imported
 * journal (before E2-R4) may hold deposit lines, and undoing them is the correction.
 */
export function manualCancelRule(canControl: boolean): PostableRule {
  return {
    label: 'Batal jurnal',
    allowControl: canControl,
    alsoRestrict: TAX_ACCOUNT_ROLES,
    controlHint: CANCEL_CONTROL_HINT,
  };
}

/** Recurring journal templates: never control or tax accounts, whatever the user's rights (owner decision #3). */
export const TEMPLATE_RULE: PostableRule = {
  label: 'Akun template',
  allowControl: false,
  alsoRestrict: TAX_ACCOUNT_ROLES,
  controlHint: 'Template jurnal berulang tidak boleh memakai akun kontrol atau pajak.',
};

/**
 * Payment request and settlement journals. Their expense accounts are picked by the requester and
 * finance, not by code, so control and tax accounts are refused like a manual journal without
 * journal.control (there is no right that opens them here). The advance and cash accounts are not
 * restricted.
 */
export const PAYMENT_REQUEST_RULE: PostableRule = {
  label: 'Akun biaya',
  allowControl: false,
  alsoRestrict: TAX_ACCOUNT_ROLES,
  controlHint: 'Pengajuan dana tidak boleh memakai akun kontrol atau pajak; gunakan modul Pembayaran atau Uang Muka.',
};

/**
 * Accounts an opening balance may be set on (plan step 5 §2.4): asset, liability and equity detail
 * accounts, tax accounts included (owner decision #2b). Never a control account: receivable,
 * payable and deposit openings go through the party opening balance, inventory through the opening
 * stock import. The opening-balance service checks the target with it; the legacy opening audit
 * (services/ledger/openingBalanceAudit.ts) reports old openings on accounts it refuses.
 */
export const OPENING_ACCOUNT_RULE: PostableRule = {
  label: 'Akun saldo awal',
  rootTypes: ['ASSET', 'LIABILITY', 'EQUITY'],
  allowControl: false,
  alsoRestrict: [],
  controlHint: 'Saldo awal piutang, hutang, dan uang muka diisi lewat saldo awal pihak; persediaan lewat impor stok awal.',
};

/** Error code: the offset account of a manual stock movement sits in the inventory account group. */
export const STOCK_OFFSET_INVENTORY = 'STOCK_OFFSET_INVENTORY';

/**
 * The offset account of a manual stock movement (E3-R4, owner decision #7), the account a person
 * picks against inventory: a detail, active account that is no control account (receivable,
 * payable, deposits, GRNI, inventory), not the opening balance equity (opening stock goes through
 * the opening stock import), no tax account, and not inside the inventory account group.
 */
export const STOCK_OFFSET_RULE: PostableRule = {
  label: 'Akun lawan mutasi stok',
  allowControl: false,
  alsoRestrict: ['OPENING_EQUITY', ...TAX_ACCOUNT_ROLES],
  controlHint: 'Pilih akun lawan biasa; stok awal diisi lewat impor stok awal.',
  outsideGroupOf: { role: 'INVENTORY', code: STOCK_OFFSET_INVENTORY },
};

/** System journals whose accounts are all chosen by code (year-end close, reclass target side). Not the cash book or payment requests. */
export const DOCUMENT_RULE: PostableRule = { label: 'Akun posting', allowControl: true };

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
 * Account id -> restricted kinds for the control roles (plus extraRoles) and item inventory
 * accounts. One account can be mapped under several roles; it keeps all of them, in `roles`
 * order. Role mappings replace the item-account kind for the same account. An account that held
 * one of these roles before a remap keeps that role as a kind too: a former party account still
 * counts in the party subledger (roleAccountIds includeFormer), so a former deposit account stays
 * closed to manual journals and a former AR/AP, inventory or GRNI account still needs
 * journal.control; what a voided document leaves there is the role's, and the sweep moves it.
 */
export async function loadControlAccountMap(
  tx: Tx,
  extraRoles: readonly SystemAccountRole[] = [],
): Promise<Map<string, readonly RestrictedKind[]>> {
  const roles = [...new Set<string>([...CONTROL_ACCOUNT_ROLES, ...extraRoles])];
  const [mappings, items, former] = await Promise.all([
    tx.systemAccountMapping.findMany({ where: { role: { in: roles } }, select: { role: true, accountId: true } }),
    tx.inventoryItem.findMany({
      where: { accountId: { not: null }, account: { rootType: 'ASSET' } },
      select: { accountId: true },
      distinct: ['accountId'],
    }),
    loadFormerRoleMoves(tx),
  ]);
  const claims = [...mappings, ...former];
  const byRole = new Map<string, RestrictedKind[]>();
  for (const role of roles) {
    const ids = claims.filter((m) => m.role === role).map((m) => m.accountId);
    for (const id of new Set(ids)) byRole.set(id, [...(byRole.get(id) ?? []), role as RestrictedKind]);
  }
  const map = new Map<string, readonly RestrictedKind[]>();
  for (const item of items) if (item.accountId) map.set(item.accountId, [INVENTORY_ITEM]);
  for (const [id, kinds] of byRole) map.set(id, kinds);
  return map;
}

/** The control kind of an account (the first in CONTROL_ACCOUNT_ROLES order), or null. */
export async function isControlAccount(tx: Tx, accountId: string): Promise<ControlKind | null> {
  return ((await loadControlAccountMap(tx)).get(accountId)?.[0] as ControlKind | undefined) ?? null;
}

function controlAllowed(kind: RestrictedKind, allow: PostableRule['allowControl']): boolean {
  if (allow === true) return true;
  return Array.isArray(allow) && allow.includes(kind);
}

/**
 * Why the account cannot be posted under the rule, or null. `restricted` = its kinds from the
 * control map; the account is postable only when the rule allows every one of them.
 */
export function postableAccountProblem(
  acc: AccountLite | null,
  rule: PostableRule,
  restricted: readonly RestrictedKind[] | null,
): AccountProblem | null {
  if (!acc) {
    return { code: ACCOUNT_NOT_FOUND, message: `${rule.label}: akun tidak ditemukan.` };
  }
  if (acc.isGroup && !rule.allowGroupOrInactive) {
    return { code: ACCOUNT_GROUP, message: `${rule.label}: ${acc.accountNumber} ${acc.name} adalah akun grup; pilih akun detail.` };
  }
  if (!acc.isActive && !rule.allowGroupOrInactive) {
    return { code: ACCOUNT_INACTIVE, message: `${rule.label}: akun ${acc.accountNumber} ${acc.name} tidak aktif.` };
  }
  if (rule.rootTypes && !rule.rootTypes.includes(acc.rootType)) {
    return {
      code: ACCOUNT_ROOT_TYPE,
      message: `${rule.label}: akun ${acc.accountNumber} ${acc.name} bertipe ${acc.rootType}, seharusnya ${rule.rootTypes.join('/')}.`,
    };
  }
  return restrictedKindProblem(acc, rule, restricted);
}

/**
 * The control part of postableAccountProblem alone: why the rule does not allow one of the
 * account's restricted kinds, or null. Used where the account's group or active state does not
 * matter, e.g. reversing an existing journal (manualCancelRule).
 */
export function restrictedKindProblem(
  acc: Pick<AccountLite, 'accountNumber' | 'name'>,
  rule: PostableRule,
  restricted: readonly RestrictedKind[] | null,
): AccountProblem | null {
  const blocked = restricted?.find((kind) => !controlAllowed(kind, rule.allowControl));
  if (blocked) {
    const kindLabel = KIND_LABELS[blocked] ?? blocked;
    const hint = rule.controlHint ? ` ${rule.controlHint}` : '';
    return {
      code: ACCOUNT_CONTROL,
      message: `${rule.label}: akun ${acc.accountNumber} ${acc.name} adalah akun kontrol ${kindLabel} dan tidak boleh diposting langsung.${hint}`,
    };
  }
  return null;
}

export interface AssertPostableOptions {
  /**
   * Lock the account rows (FOR UPDATE, in id order) before reading them, so a COA edit or a remap
   * cannot deactivate or regroup an account between this check and the posting's writes; the lock
   * is held until the caller's transaction ends. FOR UPDATE rather than FOR SHARE: two postings to
   * the same account would both hold a share lock and then deadlock on the balance UPDATE.
   */
  lockRows?: boolean;
  /** Rule per account id, replacing `rule` for that account (the remap reclass, plan §2.3, and the opening balance). */
  lineRules?: ReadonlyMap<string, PostableRule>;
}

const MAX_TREE_DEPTH = 12;

/** The parent group of the account mapped to `role`, or null when none can be named. */
async function mappedGroupId(tx: Tx, role: SystemAccountRole): Promise<string | null> {
  const mapping = await tx.systemAccountMapping.findFirst({
    where: { role },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { account: { select: { parentId: true } } },
  });
  return mapping?.account.parentId ?? null;
}

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

async function assertOutsideGroup(tx: Tx, acc: AccountLite, rule: PostableRule): Promise<void> {
  const outside = rule.outsideGroupOf;
  if (!outside) return;
  const groupId = await mappedGroupId(tx, outside.role);
  if (groupId && (await isInSubtree(tx, acc.id, groupId))) {
    throw new BusinessError(
      `${rule.label}: akun ${acc.accountNumber} ${acc.name} berada di kelompok akun ${KIND_LABELS[outside.role] ?? outside.role}.`,
      outside.code,
    );
  }
}

/** Loads the accounts and throws BusinessError (with an ACCOUNT_* code) on the first problem. */
export async function assertPostableAccounts(
  tx: Tx,
  ids: readonly string[],
  rule: PostableRule,
  opts: AssertPostableOptions = {},
): Promise<Map<string, AccountLite>> {
  const unique = [...new Set(ids)];
  if (opts.lockRows && unique.length > 0) {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id IN (${Prisma.join([...unique].sort())}) ORDER BY id FOR UPDATE`;
  }
  const ruleOf = (id: string): PostableRule => opts.lineRules?.get(id) ?? rule;
  const rules = unique.map(ruleOf);
  const needsControlMap = rules.some((r) => r.allowControl !== true);
  const alsoRestrict = [...new Set(rules.flatMap((r) => r.alsoRestrict ?? []))];
  const [accounts, control] = await Promise.all([
    tx.account.findMany({ where: { id: { in: unique } }, select: ACCOUNT_LITE_SELECT }),
    needsControlMap ? loadControlAccountMap(tx, alsoRestrict) : Promise.resolve(new Map<string, readonly RestrictedKind[]>()),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of unique) {
    const problem = postableAccountProblem(byId.get(id) ?? null, ruleOf(id), control.get(id) ?? null);
    if (problem) throw new BusinessError(problem.message, problem.code);
    await assertOutsideGroup(tx, byId.get(id)!, ruleOf(id));
  }
  return byId;
}

/** Single-account form of assertPostableAccounts. */
export async function assertPostableAccount(tx: Tx, accountId: string, rule: PostableRule): Promise<AccountLite> {
  const map = await assertPostableAccounts(tx, [accountId], rule);
  return map.get(accountId)!;
}
