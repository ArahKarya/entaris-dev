// Moving a system account role to another account (E2-R8, plan step 4 §4 PR-4.12).
//
// Balance-sheet roles (ASSET / LIABILITY / EQUITY) carry their balance with them: the old
// account's net active ledger over its whole history is reclassed to the new account in one
// SYSTEM_DOC journal per role (sourceKey REMAP:<role>:<from>:<to>:<day>), per party for the party
// roles, dated the current business day. Without transferBalance a non-zero balance refuses the
// save (ACCOUNT_HAS_BALANCE). Profit and loss roles move without a reclass: the year-end close
// does not zero their ledger rows (routes/fiscalYears.ts posts one CLOSE pair and lowers
// accounts.balance), so the old account's net spans every year and moving it would pull closed
// years' expense into the current one. Their history stays on the old account and still rolls up
// into the profit and loss report through its group. Multi-account roles are never reclassed.
//
// Every move of a balance-sheet role, also one with nothing to reclass, and every clear is written
// to system_account_role_moves (the remap journal also names the old account in its sourceKey),
// so the old account stays a former role account (services/ledger/partyRules.ts
// loadFormerRoleMoves): a document voided later still lands on the party's subledger, and a former
// control account stays a control account. What such a void leaves on the old account is reported
// by the health check "Akun bekas peran kontrol bersaldo" and moved by the sweep, through the same
// reclass. Only the role's own residue counts there: journals a person made on the old account
// after the move are not the role's, and an account another role maps now is skipped.

import { Prisma, type RootType } from '@prisma/client';
import type { prisma as prismaClient } from '../lib/prisma';
import { BusinessError } from '../utils/errors';
import { businessToday, startOfBusinessDay } from '../utils/businessDate';
import type { JournalLineInput } from '../utils/journalLineRules';
import { DOCUMENT_RULE, type PostableRule } from './ledger/accountGuard';
import { postJournal } from './ledger/postJournal';
import { PARTY_ROLES, loadFormerRoleMoves } from './ledger/partyRules';
import { MENU_CANCELLABLE_SOURCES, sourceKeys } from './ledger/journalSource';
import { SYSTEM_ACCOUNT_ROLES, type SystemAccountRole } from '../types/systemAccounts';
import type { MappingPair } from './systemAccountMappingRules';
import { missingMappingError } from './systemAccounts';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prismaClient;

export const ACCOUNT_HAS_BALANCE = 'ACCOUNT_HAS_BALANCE';
export const REMAP_BALANCE_CHANGED = 'REMAP_BALANCE_CHANGED';
export const SWEEP_ROLE_INVALID = 'SWEEP_ROLE_INVALID';

/** Key of the advisory lock every mapping save and sweep takes first. */
export const REMAP_LOCK_KEY = 'system-accounts-remap';

/** Most lines in one reclass journal; a longer reclass is split into parts (sourceKey :<n>). */
export const REMAP_MAX_LINES = 500;

/**
 * Source side of a reclass: the old account may be a group or inactive account (a legacy mapping
 * such as AR on a group account), because its balance has to leave it. The only user of
 * allowGroupOrInactive; the target side uses DOCUMENT_RULE and must be a postable detail account.
 */
export const REMAP_SOURCE_RULE: PostableRule = { label: 'Akun asal reklas', allowControl: true, allowGroupOrInactive: true };

const BALANCE_SHEET: ReadonlySet<RootType> = new Set<RootType>(['ASSET', 'LIABILITY', 'EQUITY']);
const PARTY_ROLE_SET: ReadonlySet<string> = new Set(PARTY_ROLES);
const ZERO = new Prisma.Decimal(0);

/** Balance-sheet single-account roles: the only ones whose balance moves with the mapping. */
export function isReclassRole(role: SystemAccountRole): boolean {
  const meta = SYSTEM_ACCOUNT_ROLES[role];
  return !meta.multiAccount && BALANCE_SHEET.has(meta.expectedRootType);
}

export interface RemapCandidate {
  role: SystemAccountRole;
  fromAccountId: string;
  toAccountId: string;
}

/**
 * Single-account roles whose one stored account is replaced by a different one in this request.
 * A role re-sent unchanged, newly mapped, cleared, or multi-account is not a candidate, so only a
 * real move is checked for a balance.
 */
export function remapCandidates(requested: readonly MappingPair[], stored: readonly MappingPair[]): RemapCandidate[] {
  const out: RemapCandidate[] = [];
  for (const role of [...new Set(requested.map((m) => m.role))].sort()) {
    const meta = SYSTEM_ACCOUNT_ROLES[role as SystemAccountRole];
    if (!meta || meta.multiAccount) continue;
    const before = stored.filter((m) => m.role === role);
    const after = requested.filter((m) => m.role === role);
    if (before.length !== 1 || after.length !== 1) continue;
    if (before[0].accountId === after[0].accountId) continue;
    out.push({ role: role as SystemAccountRole, fromAccountId: before[0].accountId, toAccountId: after[0].accountId });
  }
  return out;
}

/** Net active ledger (debit − credit) of one party on the old account; party null = rows without a party. */
export interface RemapLine {
  partyId: string | null;
  amount: Prisma.Decimal;
}

interface AccountRef {
  id: string;
  accountNumber: string;
  name: string;
}

export type RemapPlan =
  | { kind: 'pnl'; role: SystemAccountRole; from: AccountRef; to: AccountRef }
  | {
    kind: 'balance'; role: SystemAccountRole; from: AccountRef; to: AccountRef; lines: RemapLine[]; net: Prisma.Decimal;
    /** Former account: journals a person made after this move are not the role's residue. */
    movedAt?: Date;
  };

/** Journals a person makes (Journal menu, import, template, cash book). */
const HAND_MADE_SOURCES = [...MENU_CANCELLABLE_SOURCES];

/** With `movedAt`: leaves out ledger rows of hand-made journals posted after the move. */
function roleRowsFilter(movedAt: Date | undefined): Prisma.Sql {
  if (!movedAt) return Prisma.empty;
  return Prisma.sql`AND NOT (ale.created_at > ${movedAt} AND EXISTS (
    SELECT 1 FROM journal_entries je
     WHERE je.id = ale.reference_id AND je.source_type::text IN (${Prisma.join(HAND_MADE_SOURCES)})))`;
}

/**
 * What is left on an account for a role: per party for the party roles, one line without a party
 * otherwise. Zero lines are dropped, so [] = nothing to move. The whole history counts, except,
 * for a former account (`movedAt`), journals a person made there after the role left it.
 */
export async function accountResidue(
  db: Db,
  role: SystemAccountRole,
  accountId: string,
  movedAt?: Date,
): Promise<RemapLine[]> {
  const filter = roleRowsFilter(movedAt);
  if (PARTY_ROLE_SET.has(role)) {
    const rows = await db.$queryRaw<{ party_id: string | null; amount: string }[]>`
      SELECT ale.party_id, SUM(ale.debit - ale.credit)::text AS amount
        FROM accounting_ledger_entries ale
       WHERE ale.account_id = ${accountId} AND ale.is_cancelled = false ${filter}
       GROUP BY ale.party_id
      HAVING SUM(ale.debit - ale.credit) <> 0
       ORDER BY ale.party_id NULLS FIRST`;
    return rows.map((r) => ({ partyId: r.party_id, amount: new Prisma.Decimal(r.amount) }));
  }
  const rows = await db.$queryRaw<{ amount: string | null }[]>`
    SELECT SUM(ale.debit - ale.credit)::text AS amount
      FROM accounting_ledger_entries ale
     WHERE ale.account_id = ${accountId} AND ale.is_cancelled = false ${filter}`;
  const amount = new Prisma.Decimal(rows[0]?.amount ?? 0);
  return amount.isZero() ? [] : [{ partyId: null, amount }];
}

async function accountRefs(db: Db, ids: readonly string[]): Promise<Map<string, AccountRef>> {
  const rows = await db.account.findMany({ where: { id: { in: [...ids] } }, select: { id: true, accountNumber: true, name: true } });
  return new Map(rows.map((a) => [a.id, a]));
}

const refOf = (refs: Map<string, AccountRef>, id: string): AccountRef => refs.get(id) ?? { id, accountNumber: id, name: '' };

/**
 * The plan of one move: profit and loss roles never reclass; balance-sheet roles carry their
 * residue. `movedAt` = the old account is a former account the role left then (sweep).
 */
export async function planRemap(db: Db, candidate: RemapCandidate, movedAt?: Date): Promise<RemapPlan> {
  const refs = await accountRefs(db, [candidate.fromAccountId, candidate.toAccountId]);
  const from = refOf(refs, candidate.fromAccountId);
  const to = refOf(refs, candidate.toAccountId);
  if (!isReclassRole(candidate.role)) return { kind: 'pnl', role: candidate.role, from, to };
  const lines = await accountResidue(db, candidate.role, candidate.fromAccountId, movedAt);
  const net = lines.reduce((sum, l) => sum.plus(l.amount), ZERO);
  return { kind: 'balance', role: candidate.role, from, to, lines, net, ...(movedAt ? { movedAt } : {}) };
}

/** A reclass to post: a balance plan with something on the old account. */
export type BalancePlan = Extract<RemapPlan, { kind: 'balance' }>;
export const hasResidue = (p: RemapPlan): p is BalancePlan => p.kind === 'balance' && p.lines.length > 0;

const accountLabel = (a: AccountRef) => `${a.accountNumber} ${a.name}`.trim();

export interface RemapBalance {
  role: SystemAccountRole;
  roleLabel: string;
  fromAccountId: string;
  fromAccount: string;
  toAccountId: string;
  toAccount: string;
  /** Net debit − credit on the old account, 2 decimals. */
  amount: string;
  /** Lines with a party (party roles only). */
  partyCount: number;
}

export function balanceOf(p: BalancePlan): RemapBalance {
  return {
    role: p.role,
    roleLabel: SYSTEM_ACCOUNT_ROLES[p.role].label,
    fromAccountId: p.from.id,
    fromAccount: accountLabel(p.from),
    toAccountId: p.to.id,
    toAccount: accountLabel(p.to),
    amount: p.net.toFixed(2),
    partyCount: p.lines.filter((l) => l.partyId).length,
  };
}

/** ACCOUNT_HAS_BALANCE with the balances, so the client can show them in the transfer dialog. */
export class AccountHasBalanceError extends BusinessError {
  constructor(readonly balances: RemapBalance[]) {
    const first = balances[0];
    super(
      `Peran ${first.roleLabel}: akun lama ${first.fromAccount} masih bersaldo ${first.amount}. Pindahkan saldo ke akun baru dengan alasan, atau batalkan perubahan peran ini.`,
      ACCOUNT_HAS_BALANCE,
    );
    this.name = 'AccountHasBalanceError';
  }
}

/** Refuses the save while a moving balance-sheet role leaves a balance behind and no transfer was asked. */
export function assertTransferAllowed(plans: readonly RemapPlan[], transferBalance: boolean): void {
  const pending = plans.filter(hasResidue);
  if (pending.length > 0 && !transferBalance) throw new AccountHasBalanceError(pending.map(balanceOf));
}

/**
 * Reclass lines in journals of at most REMAP_MAX_LINES lines. Each residue line becomes a pair:
 * the opposite side on the old account, the same side on the new one, same party. Pure.
 */
export function reclassJournals(plan: BalancePlan, maxLines = REMAP_MAX_LINES): JournalLineInput[][] {
  const pairs = plan.lines.map((l): JournalLineInput[] => {
    const abs = l.amount.abs();
    const debitOnOld = l.amount.isNegative();
    const description = `Reklas ${SYSTEM_ACCOUNT_ROLES[plan.role].label}`;
    return [
      { accountId: plan.from.id, debit: debitOnOld ? abs : 0, credit: debitOnOld ? 0 : abs, partyId: l.partyId, description },
      { accountId: plan.to.id, debit: debitOnOld ? 0 : abs, credit: debitOnOld ? abs : 0, partyId: l.partyId, description },
    ];
  });
  const perJournal = Math.max(1, Math.floor(maxLines / 2));
  const journals: JournalLineInput[][] = [];
  for (let i = 0; i < pairs.length; i += perJournal) journals.push(pairs.slice(i, i + perJournal).flat());
  return journals;
}

export interface RemapTransfer extends RemapBalance {
  journalNumbers: string[];
}

export interface ApplyRemapOptions {
  actorId: string;
  reason: string;
  now?: Date;
}

/**
 * Posts the reclass of one balance plan, dated the current business day (the period guard in
 * postJournal refuses a closed or locked day). Party rule off: the party lines copy the old
 * account's ledger rows, and at posting time only one of the two accounts holds the role. The
 * old account takes REMAP_SOURCE_RULE, the new one DOCUMENT_RULE.
 */
export async function applyRemap(tx: Tx, plan: BalancePlan, opts: ApplyRemapOptions): Promise<RemapTransfer> {
  const now = opts.now ?? new Date();
  const day = businessToday(now);
  const journals = reclassJournals(plan);
  const label = SYSTEM_ACCOUNT_ROLES[plan.role].label;
  const journalNumbers: string[] = [];
  for (const [i, lines] of journals.entries()) {
    const { journal } = await postJournal(tx, {
      date: startOfBusinessDay(day),
      narration: `Reklas akun sistem ${label}: ${accountLabel(plan.from)} ke ${accountLabel(plan.to)}. ${opts.reason}`,
      lines,
      sourceType: 'SYSTEM_DOC',
      sourceKey: sourceKeys.remap(plan.role, plan.from.id, plan.to.id, day, journals.length > 1 ? i + 1 : undefined),
      createdBy: opts.actorId,
      accountRule: DOCUMENT_RULE,
      lineRules: new Map([[plan.from.id, REMAP_SOURCE_RULE]]),
      partyRule: 'off',
      partyEffect: 'none',
      now,
    });
    journalNumbers.push(journal.entryNumber);
  }
  return { ...balanceOf(plan), journalNumbers };
}

/**
 * After the reclass and the mapping change: the old account must be empty for the role. Something
 * posted to it in between (committed before our journal locked the account) leaves a residue, and
 * the whole save rolls back.
 */
export async function assertRemapEmptied(tx: Tx, plans: readonly BalancePlan[]): Promise<void> {
  for (const p of plans) {
    if ((await accountResidue(tx, p.role, p.from.id, p.movedAt)).length > 0) {
      throw new BusinessError(
        `Saldo akun ${accountLabel(p.from)} berubah selama reklas peran ${SYSTEM_ACCOUNT_ROLES[p.role].label}. Tidak ada yang disimpan; ulangi.`,
        REMAP_BALANCE_CHANGED,
      );
    }
  }
}

/** Takes the advisory lock shared by mapping saves and sweeps (held until the transaction ends). */
export async function lockRemaps(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${REMAP_LOCK_KEY}))`;
}

interface FormerAccount {
  role: SystemAccountRole;
  fromAccountId: string;
  /** Where the role went last; null when it was cleared. */
  toAccountId: string | null;
  /** The last time the role left this account. */
  movedAt: Date;
  source: 'history' | 'journal';
}

/**
 * (role, old account) of every balance-sheet role move, oldest first, without repeats. The move
 * time is the last history row (a sweep journal is no move: it would hide what a person posted
 * there before it); a pair known only from remap journals takes the first one.
 */
async function formerAccounts(db: Db): Promise<FormerAccount[]> {
  const byKey = new Map<string, FormerAccount>();
  const moves = await loadFormerRoleMoves(db);
  for (const m of [...moves.filter((x) => x.source === 'history'), ...moves.filter((x) => x.source === 'journal')]) {
    if (!(m.role in SYSTEM_ACCOUNT_ROLES)) continue;
    const role = m.role as SystemAccountRole;
    const key = `${role}:${m.accountId}`;
    const known = byKey.get(key);
    if (!isReclassRole(role) || (known && m.source === 'journal')) continue;
    byKey.set(key, { role, fromAccountId: m.accountId, toAccountId: m.toAccountId, movedAt: m.movedAt, source: m.source });
  }
  return [...byKey.values()];
}

/**
 * A former account whose balance is no longer only the role's: another role maps it now (two
 * non-exclusive roles may share an account), or, for INVENTORY, an item keeps its stock there.
 */
async function formerAccountInUse(db: Db, f: FormerAccount, mappings: readonly MappingPair[]): Promise<boolean> {
  if (mappings.some((m) => m.accountId === f.fromAccountId)) return true;
  if (f.role !== 'INVENTORY') return false;
  return (await db.inventoryItem.count({ where: { accountId: f.fromAccountId } })) > 0;
}

export interface FormerResidue extends RemapBalance {
  /** false when the role has no mapped account to sweep to. */
  sweepable: boolean;
}

/**
 * Former accounts of balance-sheet roles that still hold something for the role, typically after
 * a document dated before the remap was voided. An account the role (or another role) maps now,
 * and a former inventory account an item still uses, are skipped. `role` narrows the list.
 */
export async function findFormerResidues(db: Db, role?: SystemAccountRole): Promise<FormerResidue[]> {
  const [former, mappings] = await Promise.all([
    formerAccounts(db),
    db.systemAccountMapping.findMany({ select: { role: true, accountId: true } }),
  ]);
  const out: FormerResidue[] = [];
  for (const f of former) {
    if (role && f.role !== role) continue;
    if (await formerAccountInUse(db, f, mappings)) continue;
    const current = mappings.filter((m) => m.role === f.role).map((m) => m.accountId);
    const toAccountId = current.length === 1 ? current[0] : (f.toAccountId ?? f.fromAccountId);
    const plan = await planRemap(db, { role: f.role, fromAccountId: f.fromAccountId, toAccountId }, f.movedAt);
    if (hasResidue(plan)) out.push({ ...balanceOf(plan), sweepable: current.length === 1 });
  }
  return out;
}

/**
 * Moves what is left on the role's former accounts to the account it is mapped to now, through
 * the same reclass as a remap. [] when nothing is left.
 */
export async function sweepFormerAccounts(tx: Tx, role: SystemAccountRole, opts: ApplyRemapOptions): Promise<RemapTransfer[]> {
  const meta = SYSTEM_ACCOUNT_ROLES[role];
  if (!isReclassRole(role)) {
    throw new BusinessError(
      `Peran ${meta.label} bukan peran neraca dengan satu akun; sisa saldo akun lamanya tidak dipindahkan.`,
      SWEEP_ROLE_INVALID,
    );
  }
  await lockRemaps(tx);
  const mappings = await tx.systemAccountMapping.findMany({ select: { role: true, accountId: true } });
  const current = mappings.filter((m) => m.role === role);
  if (current.length !== 1) {
    throw missingMappingError(role);
  }
  const toAccountId = current[0].accountId;
  const transfers: RemapTransfer[] = [];
  const posted: BalancePlan[] = [];
  for (const f of await formerAccounts(tx)) {
    if (f.role !== role || (await formerAccountInUse(tx, f, mappings))) continue;
    const plan = await planRemap(tx, { role, fromAccountId: f.fromAccountId, toAccountId }, f.movedAt);
    if (!hasResidue(plan)) continue;
    transfers.push(await applyRemap(tx, plan, opts));
    posted.push(plan);
  }
  await assertRemapEmptied(tx, posted);
  return transfers;
}
