// Party rules for journal lines (E2-R4): which accounts carry a party (customer or supplier) and
// of which type. The party roles are the subledger accounts (receivable, payable, both deposits).
// The role map reads system account mappings through the caller's transaction (never the cache)
// and also holds accounts that held a party role before a remap (loadFormerRoleMoves: the role
// move history and the sourceKey of the remap reclass journals that are not cancelled), so a
// document voided after a remap still lands on the party's subledger.

import type { PartyType, Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { REMAP_KEY_PREFIX, parseRemapSourceKey } from './journalSource';

type Tx = Prisma.TransactionClient;

export const PARTY_ROLES = ['AR', 'AP', 'CUSTOMER_DEPOSIT', 'VENDOR_DEPOSIT'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/**
 * strict: a party-role account needs a party and every other account refuses one (manual journal,
 * import). allowedOnly: a party is optional but only on a party-role account (document journals).
 * off: not checked.
 */
export type PartyRule = 'strict' | 'allowedOnly' | 'off';

export const PARTY_REQUIRED = 'PARTY_REQUIRED';
export const PARTY_NOT_ALLOWED = 'PARTY_NOT_ALLOWED';
export const PARTY_TYPE_MISMATCH = 'PARTY_TYPE_MISMATCH';
export const PARTY_NOT_FOUND = 'PARTY_NOT_FOUND';
export const PARTY_ROLE_AMBIGUOUS = 'PARTY_ROLE_AMBIGUOUS';
/** Journal import: a party name that two parties share cannot say which one a line means. */
export const PARTY_AMBIGUOUS_NAME = 'PARTY_AMBIGUOUS_NAME';

export type PartyProblemCode =
  | typeof PARTY_REQUIRED
  | typeof PARTY_NOT_ALLOWED
  | typeof PARTY_TYPE_MISMATCH
  | typeof PARTY_NOT_FOUND
  | typeof PARTY_AMBIGUOUS_NAME;

export interface PartyProblem {
  code: PartyProblemCode;
  message: string;
}

/** The party type each role accepts. */
export const PARTY_TYPE_OF_ROLE: Readonly<Record<PartyRole, 'Customer' | 'Supplier'>> = {
  AR: 'Customer',
  CUSTOMER_DEPOSIT: 'Customer',
  AP: 'Supplier',
  VENDOR_DEPOSIT: 'Supplier',
};

/** Indonesian role names for messages (each has an exact i18n entry). */
const ROLE_LABELS: Readonly<Record<PartyRole, string>> = {
  AR: 'Piutang Usaha',
  AP: 'Hutang Usaha',
  CUSTOMER_DEPOSIT: 'Uang Muka Customer',
  VENDOR_DEPOSIT: 'Uang Muka Supplier',
};

const isPartyRole = (role: string): role is PartyRole => (PARTY_ROLES as readonly string[]).includes(role);

export interface FormerRoleAccount {
  role: PartyRole;
  accountId: string;
}

export interface FormerRoleMove {
  role: string;
  accountId: string;
  /** Where the role went; null when it was cleared. */
  toAccountId: string | null;
  movedAt: Date;
  /** history: a row of system_account_role_moves; journal: a remap reclass journal (also a sweep). */
  source: 'history' | 'journal';
}

/**
 * Every move of a system account role off an account, oldest first: the role move history
 * (written by every balance-sheet move, also one with nothing to reclass, and every clear) plus
 * the remap reclass journals not cancelled (sweeps, and fixtures without a history row).
 */
export async function loadFormerRoleMoves(tx: Tx): Promise<FormerRoleMove[]> {
  const [moves, journals] = await Promise.all([
    tx.systemAccountRoleMove.findMany({
      select: { role: true, fromAccountId: true, toAccountId: true, movedAt: true },
      orderBy: { movedAt: 'asc' },
    }),
    tx.journalEntry.findMany({
      where: { sourceType: 'SYSTEM_DOC', sourceKey: { startsWith: REMAP_KEY_PREFIX }, status: { not: 'Cancelled' } },
      select: { sourceKey: true, createdAt: true },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  const out: FormerRoleMove[] = moves.map((m) => ({
    role: m.role, accountId: m.fromAccountId, toAccountId: m.toAccountId, movedAt: m.movedAt, source: 'history',
  }));
  for (const j of journals) {
    const key = parseRemapSourceKey(j.sourceKey);
    if (key) {
      out.push({ role: key.role, accountId: key.fromAccountId, toAccountId: key.toAccountId, movedAt: j.createdAt, source: 'journal' });
    }
  }
  return out.sort((a, b) => a.movedAt.getTime() - b.movedAt.getTime());
}

/** Accounts a party role moved away from, oldest move first. */
export async function loadFormerRoleAccounts(tx: Tx): Promise<FormerRoleAccount[]> {
  const out: FormerRoleAccount[] = [];
  for (const m of await loadFormerRoleMoves(tx)) {
    if (isPartyRole(m.role)) out.push({ role: m.role, accountId: m.accountId });
  }
  return out;
}

async function accountName(tx: Tx, accountId: string): Promise<{ accountNumber: string; name: string }> {
  const acc = await tx.account.findUnique({ where: { id: accountId }, select: { accountNumber: true, name: true } });
  return acc ?? { accountNumber: accountId, name: '' };
}

interface PartyRoleResolution {
  /** Account id -> party role; an account in conflict keeps the first role found. */
  roles: Map<string, PartyRole>;
  /** Account id -> the roles it holds and the error that names them, for accounts holding two or more. */
  conflicts: Map<string, { roles: Set<PartyRole>; error: BusinessError }>;
}

/**
 * The one resolution rule for party roles: account id -> its single party role, from current
 * mappings plus (with includeFormer) accounts that held a party role before a remap. An account
 * holding two party roles, current or former, is recorded as a conflict (PARTY_ROLE_AMBIGUOUS):
 * a line there cannot tell whether its party is a customer or a supplier and the subledgers would
 * count it twice. Callers throw it only when it touches what they read, so one bad mapping does
 * not stop every document of the other roles. A role remapped back to an account it held before
 * is the same role, not a conflict.
 */
async function resolvePartyRoles(tx: Tx, opts: { includeFormer: boolean }): Promise<PartyRoleResolution> {
  const [mappings, former] = await Promise.all([
    tx.systemAccountMapping.findMany({
      where: { role: { in: [...PARTY_ROLES] } },
      select: { role: true, accountId: true, account: { select: { accountNumber: true, name: true } } },
    }),
    opts.includeFormer ? loadFormerRoleAccounts(tx) : Promise.resolve([]),
  ]);
  const roles = new Map<string, PartyRole>();
  const conflicts: PartyRoleResolution['conflicts'] = new Map();
  const note = (accountId: string, seen: PartyRole, role: PartyRole, error: () => BusinessError) => {
    const known = conflicts.get(accountId);
    if (known) known.roles.add(role);
    else conflicts.set(accountId, { roles: new Set([seen, role]), error: error() });
  };
  for (const m of mappings) {
    if (!isPartyRole(m.role)) continue;
    const role = m.role;
    const seen = roles.get(m.accountId);
    if (seen && seen !== role) {
      note(m.accountId, seen, role, () => new BusinessError(
        `Akun ${m.account.accountNumber} ${m.account.name} dipetakan ke dua peran pihak (${ROLE_LABELS[seen]} dan ${ROLE_LABELS[role]}). Perbaiki pemetaan di Pengaturan > Akun Sistem.`,
        PARTY_ROLE_AMBIGUOUS,
      ));
      continue;
    }
    roles.set(m.accountId, role);
  }
  for (const f of former) {
    const seen = roles.get(f.accountId);
    if (seen && seen !== f.role) {
      if (conflicts.has(f.accountId)) {
        conflicts.get(f.accountId)!.roles.add(f.role);
        continue;
      }
      const acc = await accountName(tx, f.accountId);
      note(f.accountId, seen, f.role, () => new BusinessError(
        `Akun ${acc.accountNumber} ${acc.name} memegang dua peran pihak (${ROLE_LABELS[seen]} dan ${ROLE_LABELS[f.role]}) lewat pemindahan akun sistem. Satu akun hanya boleh memegang satu peran pihak; pilih akun lain di Pengaturan > Akun Sistem.`,
        PARTY_ROLE_AMBIGUOUS,
      ));
      continue;
    }
    roles.set(f.accountId, f.role);
  }
  return { roles, conflicts };
}

/**
 * Account id -> party role: current mappings plus accounts that held a party role before a remap.
 * Throws PARTY_ROLE_AMBIGUOUS when one of `accountIds` holds two party roles; without `accountIds`,
 * when any account does.
 */
export async function loadPartyRoleMap(tx: Tx, accountIds?: readonly string[]): Promise<ReadonlyMap<string, PartyRole>> {
  const { roles, conflicts } = await resolvePartyRoles(tx, { includeFormer: true });
  const ids = accountIds ?? [...conflicts.keys()];
  for (const id of ids) {
    const conflict = conflicts.get(id);
    if (conflict) throw conflict.error;
  }
  return roles;
}

/**
 * Account ids of one party role: current mappings, plus former ones with includeFormer. Built from
 * the same resolution as loadPartyRoleMap, so an account is never listed under two roles. Throws
 * PARTY_ROLE_AMBIGUOUS only when an account of this role also holds another one; a conflict
 * between other roles does not concern it.
 */
export async function roleAccountIds(
  tx: Tx,
  role: PartyRole,
  opts: { includeFormer?: boolean } = {},
): Promise<string[]> {
  const { roles, conflicts } = await resolvePartyRoles(tx, { includeFormer: !!opts.includeFormer });
  for (const conflict of conflicts.values()) {
    if (conflict.roles.has(role)) throw conflict.error;
  }
  return [...roles].filter(([, r]) => r === role).map(([id]) => id);
}

/** Party id -> party type for the given ids (missing ids are absent). */
export async function loadPartyTypes(tx: Tx, partyIds: readonly (string | null | undefined)[]): Promise<Map<string, PartyType>> {
  const ids = [...new Set(partyIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const parties = await tx.party.findMany({ where: { id: { in: ids } }, select: { id: true, partyType: true } });
  return new Map(parties.map((p) => [p.id, p.partyType]));
}

export interface PartyLineInput {
  partyId: string | null;
  /** Type of the line's party; null/undefined with a partyId means the party does not exist. */
  partyType?: PartyType | null;
}

/**
 * Why a line's party does not fit its account under the rule, or null. `role` = the account's
 * party role from loadPartyRoleMap (undefined for any other account). A party registered as both
 * customer and supplier fits every party role: the account says which side of the party the line
 * adjusts (the party carries its receivable and payable apart, services/ledger/partySides.ts).
 */
export function partyLineProblem(line: PartyLineInput, role: PartyRole | undefined, rule: PartyRule): PartyProblem | null {
  if (rule === 'off') return null;
  if (!role) {
    if (!line.partyId) return null;
    return {
      code: PARTY_NOT_ALLOWED,
      message: 'Pihak hanya boleh diisi di baris akun Piutang Usaha, Hutang Usaha, atau Uang Muka; kosongkan pihak di baris ini.',
    };
  }
  const expected = PARTY_TYPE_OF_ROLE[role];
  if (!line.partyId) {
    if (rule === 'allowedOnly') return null;
    return { code: PARTY_REQUIRED, message: `Baris ke akun ${ROLE_LABELS[role]} wajib memilih ${expected}.` };
  }
  if (!line.partyType) return { code: PARTY_NOT_FOUND, message: 'Pihak tidak ditemukan.' };
  if (line.partyType === 'Both') return null;
  if (line.partyType !== expected) {
    return {
      code: PARTY_TYPE_MISMATCH,
      message: `Akun ${ROLE_LABELS[role]} hanya menerima ${expected}; pihak yang dipilih bertipe ${line.partyType}.`,
    };
  }
  return null;
}
