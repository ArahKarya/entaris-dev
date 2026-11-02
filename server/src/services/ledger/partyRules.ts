// Party rules for journal lines (E2-R4): which accounts carry a party (customer or supplier) and
// of which type. The party roles are the subledger accounts (receivable, payable, both deposits).
// The role map reads system account mappings through the caller's transaction (never the cache)
// and also holds accounts that held a party role before a remap, taken from the sourceKey of the
// remap reclass journals that are not cancelled, so a document voided after a remap still lands on
// the party's subledger.

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

export type PartyProblemCode =
  | typeof PARTY_REQUIRED
  | typeof PARTY_NOT_ALLOWED
  | typeof PARTY_TYPE_MISMATCH
  | typeof PARTY_NOT_FOUND;

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

interface FormerRoleAccount {
  role: PartyRole;
  accountId: string;
}

/** Accounts a party role moved away from, oldest reclass first (remap journals not cancelled). */
async function loadFormerRoleAccounts(tx: Tx): Promise<FormerRoleAccount[]> {
  const journals = await tx.journalEntry.findMany({
    where: { sourceType: 'SYSTEM_DOC', sourceKey: { startsWith: REMAP_KEY_PREFIX }, status: { not: 'Cancelled' } },
    select: { sourceKey: true },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  const out: FormerRoleAccount[] = [];
  for (const j of journals) {
    const key = parseRemapSourceKey(j.sourceKey);
    if (key && isPartyRole(key.role)) out.push({ role: key.role, accountId: key.fromAccountId });
  }
  return out;
}

/**
 * Account id -> party role: current mappings plus accounts that held a party role before a remap.
 * A current mapping wins over a former role; among former roles the latest reclass wins. Throws
 * PARTY_ROLE_AMBIGUOUS when one account is currently mapped under two party roles, since a line
 * there cannot tell whether its party is a customer or a supplier.
 */
export async function loadPartyRoleMap(tx: Tx): Promise<ReadonlyMap<string, PartyRole>> {
  const [mappings, former] = await Promise.all([
    tx.systemAccountMapping.findMany({
      where: { role: { in: [...PARTY_ROLES] } },
      select: { role: true, accountId: true, account: { select: { accountNumber: true, name: true } } },
    }),
    loadFormerRoleAccounts(tx),
  ]);
  const map = new Map<string, PartyRole>();
  for (const f of former) map.set(f.accountId, f.role);

  const current = new Map<string, PartyRole>();
  for (const m of mappings) {
    if (!isPartyRole(m.role)) continue;
    const seen = current.get(m.accountId);
    if (seen && seen !== m.role) {
      throw new BusinessError(
        `Akun ${m.account.accountNumber} ${m.account.name} dipetakan ke dua peran pihak (${ROLE_LABELS[seen]} dan ${ROLE_LABELS[m.role]}). Perbaiki pemetaan di Pengaturan > Akun Sistem.`,
        PARTY_ROLE_AMBIGUOUS,
      );
    }
    current.set(m.accountId, m.role);
  }
  for (const [id, role] of current) map.set(id, role);
  return map;
}

/** Account ids of one party role: current mappings, plus former ones with includeFormer. */
export async function roleAccountIds(
  tx: Tx,
  role: PartyRole,
  opts: { includeFormer?: boolean } = {},
): Promise<string[]> {
  const [mappings, former] = await Promise.all([
    tx.systemAccountMapping.findMany({ where: { role }, select: { accountId: true } }),
    opts.includeFormer ? loadFormerRoleAccounts(tx) : Promise.resolve([]),
  ]);
  return [...new Set([...mappings.map((m) => m.accountId), ...former.filter((f) => f.role === role).map((f) => f.accountId)])];
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
 * customer and supplier is refused under strict (manual journal) until party-role columns exist
 * (E2-PR9), because the line cannot say which side of that party it adjusts.
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
  if (line.partyType === 'Both') {
    if (rule === 'allowedOnly') return null;
    return {
      code: PARTY_TYPE_MISMATCH,
      message: `Akun ${ROLE_LABELS[role]} hanya menerima ${expected}; mitra yang terdaftar sebagai Customer sekaligus Supplier belum bisa dipakai di jurnal manual.`,
    };
  }
  if (line.partyType !== expected) {
    return {
      code: PARTY_TYPE_MISMATCH,
      message: `Akun ${ROLE_LABELS[role]} hanya menerima ${expected}; pihak yang dipilih bertipe ${line.partyType}.`,
    };
  }
  return null;
}
