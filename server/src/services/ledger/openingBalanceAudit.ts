// Audit of legacy opening-balance journals (E2-R11 migration, plan step 5 PR-5.6), the core of
// scripts/repair/e2-opening-balance-audit.ts. The plan is read-only. It lists every active opening
// journal without a sourceKey, per target (an account through JournalItem.accountId, a party
// subledger through partyId on its role account): journals typed OPENING, legacy journals the
// classifier calls OPENING (number OB-, narration "Saldo awal …") and deposit openings posted by
// the payment screen ("Saldo Awal Uang Muka …", typed NULL or SYSTEM_DOC). It also lists active
// non-opening journals against OPENING_EQUITY (opening balances recorded another way, e.g. "Setoran
// modal awal"), active OPENING/RECURRING sourceKeys held by more than one journal (the gate of the
// unique index, PR-5.14) and parties whose opening_outstanding differs from their opening journals.
//
// The one write gives a legacy journal its sourceKey (and source_type OPENING), so the opening
// balance service may later replace it. Automatically only for class single-two-line-opening: the
// only opening of its target, two lines (target + OPENING_EQUITY), and no other activity on the
// target before it, so its amount is the real opening balance and not an old PATCH delta against
// the running balance. Any other journal only when the accountant names it (keyJournals). Nothing
// is ever cancelled or re-dated here, and no ledger row or balance changes.

import { Prisma, type DocumentStatus, type JournalSourceType, type PrismaClient } from '@prisma/client';
import { addDays, businessDayOf } from '../../utils/businessDate';
import { missingMappingError } from '../systemAccounts';
import { loadControlAccountMap, OPENING_ACCOUNT_RULE, postableAccountProblem } from './accountGuard';
import { classifyLegacyJournal, sourceKeys, type OpeningPartyKind } from './journalSource';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

export const OPENING_AUDIT_SCRIPT = 'e2-opening-balance-audit';
export const OPENING_KEY_AUDIT_ACTION = 'KEY_OPENING_JOURNAL';
/** Non-opening journals against OPENING_EQUITY up to this many days after the cut-over are flagged. */
export const EQUITY_COUNTER_WINDOW_DAYS = 31;

/** Deposit opening posted by services/paymentSubmit.ts (isOpeningBalance), no source type or key. */
const DEPOSIT_OPENING_NARRATION = /^Saldo Awal Uang Muka (Vendor|Pelanggan):/;
const PARTY_ROLE_KINDS = { AR: 'AR', AP: 'AP', VENDOR_DEPOSIT: 'VDEP', CUSTOMER_DEPOSIT: 'CDEP' } as const;
/** Mapped roles an opening balance may never target besides the rule (owner decision #2b). */
const REFUSED_TARGET_ROLES = ['CURRENT_PROFIT'] as const;

export type OpeningDetection = 'source-type' | 'classifier' | 'deposit-narration';

export type OpeningAuditClass =
  /** Only opening of its target, target + OPENING_EQUITY, no earlier activity: --apply keys it. */
  | 'single-two-line-opening'
  /** The target had other activity before the journal: an old PATCH delta, not an opening. */
  | 'patch-delta'
  /** The target has more than one active opening journal, or one already holds the key. */
  | 'multi'
  /** Not exactly target + OPENING_EQUITY (more lines, or several targets in one journal). */
  | 'multi-line'
  /** Deposit opening owned by a deposit payment: replaced through the deposit only (PR-5.11). */
  | 'deposit-legacy'
  /** An account the opening balance service refuses (OPENING_ACCOUNT_RULE, CURRENT_PROFIT). */
  | 'refused-account'
  /** Draft (never posted to the ledger). */
  | 'not-submitted';

export type OpeningAuditTarget =
  | { kind: 'ACCOUNT'; accountId: string }
  | { kind: 'PARTY'; partyId: string; subledger: OpeningPartyKind; accountId: string };

export interface LegacyOpeningRow {
  journalId: string;
  entryNumber: string;
  date: Date;
  day: string;
  status: DocumentStatus;
  sourceType: JournalSourceType | null;
  narration: string | null;
  fiscalYearClosed: boolean;
  detection: OpeningDetection;
  /** null when the journal has no line besides OPENING_EQUITY. */
  target: OpeningAuditTarget | null;
  accountNumber: string | null;
  accountName: string | null;
  partyName: string | null;
  /** Debit minus credit of the target's lines. */
  amount: Prisma.Decimal;
  lineCount: number;
  targetCount: number;
  /** Exactly two lines: the target and an OPENING_EQUITY account. */
  twoLine: boolean;
  /** Dated after the cut-over day (an opening normally sits on it). */
  afterCutover: boolean;
  /** Active non-opening ledger rows on the target dated before the journal. */
  priorActivity: boolean;
  /** Active unkeyed opening journals of the same target, this one included. */
  openingsForTarget: number;
  /** Another active journal already holds the proposed key. */
  keyedActive: boolean;
  ruleProblem: string | null;
  cls: OpeningAuditClass;
  proposedKey: string | null;
}

export interface EquityCounterRow {
  journalId: string;
  entryNumber: string;
  day: string;
  status: DocumentStatus;
  sourceType: JournalSourceType | null;
  narration: string | null;
  accountId: string;
  accountNumber: string;
  accountName: string;
  /** Debit minus credit of the counter account's lines. */
  amount: Prisma.Decimal;
  /** Dated on or before the cut-over plus EQUITY_COUNTER_WINDOW_DAYS. */
  nearCutover: boolean;
}

export interface DuplicateKeyRow {
  sourceType: string;
  sourceKey: string;
  entryNumbers: string[];
}

export interface PartyOpeningRow {
  partyId: string;
  name: string;
  partyType: string;
  openingOutstanding: Prisma.Decimal;
  /** Receivable (debit − credit) plus payable (credit − debit) of the party's active opening journals. */
  fromJournals: Prisma.Decimal;
  difference: Prisma.Decimal;
}

export interface OpeningAuditReport {
  /** Start of the earliest open fiscal year (business day), or the day given; null without one. */
  cutoverDay: string | null;
  openings: LegacyOpeningRow[];
  equityCounters: EquityCounterRow[];
  duplicates: DuplicateKeyRow[];
  parties: PartyOpeningRow[];
}

export interface OpeningAuditOptions {
  /** Cut-over day (YYYY-MM-DD) instead of the start of the earliest open fiscal year. */
  cutoverDay?: string;
}

const ZERO = new Prisma.Decimal(0);

/** Active OPENING / RECURRING sourceKeys held by more than one journal (must be none before PR-5.14). */
export async function findActiveDuplicateKeys(db: Db): Promise<DuplicateKeyRow[]> {
  const rows = await db.$queryRaw<Array<{ source_type: string; source_key: string; entries: string[] }>>`
    SELECT source_type::text AS source_type, source_key, array_agg(entry_number ORDER BY entry_number) AS entries
    FROM journal_entries
    WHERE source_type IN ('OPENING', 'RECURRING') AND source_key IS NOT NULL AND status <> 'Cancelled'
    GROUP BY source_type, source_key
    HAVING count(*) > 1
    ORDER BY source_type, source_key`;
  return rows.map((r) => ({ sourceType: r.source_type, sourceKey: r.source_key, entryNumbers: r.entries }));
}

async function defaultCutoverDay(db: Db): Promise<string | null> {
  const fy = await db.fiscalYear.findFirst({ where: { isClosed: false }, orderBy: { startDate: 'asc' }, select: { startDate: true } });
  return fy ? businessDayOf(fy.startDate) : null;
}

interface RoleAccounts {
  openingEquity: Set<string>;
  /** Party role account -> subledger kind. */
  partyKind: Map<string, OpeningPartyKind>;
  /** Subledger kind -> its role accounts. */
  kindAccounts: Map<OpeningPartyKind, string[]>;
  refused: Map<string, string>;
}

async function loadRoleAccounts(db: Db): Promise<RoleAccounts> {
  const roles = ['OPENING_EQUITY', ...Object.keys(PARTY_ROLE_KINDS), ...REFUSED_TARGET_ROLES];
  const mappings = await db.systemAccountMapping.findMany({ where: { role: { in: roles } }, select: { role: true, accountId: true } });
  const out: RoleAccounts = { openingEquity: new Set(), partyKind: new Map(), kindAccounts: new Map(), refused: new Map() };
  for (const m of mappings) {
    if (m.role === 'OPENING_EQUITY') out.openingEquity.add(m.accountId);
    else if (m.role in PARTY_ROLE_KINDS) {
      const kind = PARTY_ROLE_KINDS[m.role as keyof typeof PARTY_ROLE_KINDS];
      out.partyKind.set(m.accountId, kind);
      out.kindAccounts.set(kind, [...(out.kindAccounts.get(kind) ?? []), m.accountId]);
    } else out.refused.set(m.accountId, m.role);
  }
  if (out.openingEquity.size === 0) throw missingMappingError('OPENING_EQUITY');
  return out;
}

const OPENING_JOURNAL_SELECT = {
  id: true, entryNumber: true, date: true, status: true, sourceType: true, sourceKey: true, narration: true,
  fiscalYearId: true, createdAt: true,
  fiscalYear: { select: { isClosed: true } },
  payment: { select: { paymentType: true } },
  stockMovement: { select: { referenceType: true } },
  _count: { select: { depreciationEntries: true } },
  items: { select: { accountId: true, partyId: true, debit: true, credit: true, account: { select: { accountNumber: true, name: true } } } },
} satisfies Prisma.JournalEntrySelect;

type OpeningJournal = Prisma.JournalEntryGetPayload<{ select: typeof OPENING_JOURNAL_SELECT }>;

/** Active journals that may be openings: typed OPENING, legacy OPENING candidates, deposit openings. */
async function loadOpeningJournals(db: Db): Promise<{ journals: OpeningJournal[]; cashBook: Set<string> }> {
  const journals = await db.journalEntry.findMany({
    where: {
      status: { not: 'Cancelled' },
      OR: [
        { sourceType: 'OPENING' },
        {
          sourceType: null,
          OR: [
            { entryNumber: { startsWith: 'OB-' } },
            { narration: { startsWith: 'Saldo awal ' } },
            { stockMovement: { referenceType: 'OpeningBalance' } },
          ],
        },
        { sourceKey: null, narration: { startsWith: 'Saldo Awal Uang Muka ' } },
      ],
    },
    select: OPENING_JOURNAL_SELECT,
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });
  const legacyIds = journals.filter((j) => j.sourceType === null).map((j) => j.id);
  const rows = legacyIds.length
    ? await db.cashBookDraftRow.findMany({ where: { journalEntryId: { in: legacyIds } }, select: { journalEntryId: true } })
    : [];
  return { journals, cashBook: new Set(rows.map((r) => r.journalEntryId).filter((id): id is string => id !== null)) };
}

/** Why a journal counts as an unkeyed opening, or null. */
function detect(j: OpeningJournal, cashBook: ReadonlySet<string>): OpeningDetection | null {
  if (j.sourceKey !== null) return null;
  if (DEPOSIT_OPENING_NARRATION.test(j.narration ?? '')) return 'deposit-narration';
  if (j.sourceType === 'OPENING') return 'source-type';
  if (j.sourceType !== null) return null;
  // Only the facts the rules above OPENING read; every rule after them is never reached for an OPENING.
  const c = classifyLegacyJournal({
    entryNumber: j.entryNumber,
    narration: j.narration,
    fiscalYearId: j.fiscalYearId,
    createdAt: j.createdAt,
    depreciationEntryCount: j._count.depreciationEntries,
    inCashBookDraft: cashBook.has(j.id),
    openingStockMovement: j.stockMovement?.referenceType === 'OpeningBalance',
    hasDocumentLink: false,
    manualAudit: false,
    recurringAudit: false,
    matchesRecurringTemplate: false,
    nearImportBatch: false,
  });
  return c.type === 'OPENING' ? 'classifier' : null;
}

interface TargetLines {
  target: OpeningAuditTarget;
  amount: Prisma.Decimal;
  accountNumber: string;
  accountName: string;
}

/** The journal's lines other than OPENING_EQUITY, grouped per target. */
function journalTargets(j: OpeningJournal, roles: RoleAccounts): TargetLines[] {
  const byKey = new Map<string, TargetLines>();
  for (const item of j.items) {
    if (roles.openingEquity.has(item.accountId)) continue;
    const kind = item.partyId ? roles.partyKind.get(item.accountId) : undefined;
    const target: OpeningAuditTarget = kind && item.partyId
      ? { kind: 'PARTY', partyId: item.partyId, subledger: kind, accountId: item.accountId }
      : { kind: 'ACCOUNT', accountId: item.accountId };
    const key = targetKey(target);
    const prev = byKey.get(key);
    const net = new Prisma.Decimal(item.debit).minus(item.credit);
    byKey.set(key, prev
      ? { ...prev, amount: prev.amount.plus(net) }
      : { target, amount: net, accountNumber: item.account.accountNumber, accountName: item.account.name });
  }
  return [...byKey.values()];
}

function targetKey(t: OpeningAuditTarget): string {
  return t.kind === 'ACCOUNT' ? sourceKeys.openingAccount(t.accountId) : sourceKeys.openingParty(t.partyId, t.subledger);
}

/** Active ledger rows on the target before `before` that come from neither an opening journal nor the excluded ids. */
async function hasPriorActivity(db: Db, target: OpeningAuditTarget, before: Date, openingIds: readonly string[], roles: RoleAccounts): Promise<boolean> {
  const where = target.kind === 'ACCOUNT'
    ? Prisma.sql`a.account_id = ${target.accountId}`
    : Prisma.sql`a.party_id = ${target.partyId} AND a.account_id = ANY(${roles.kindAccounts.get(target.subledger) ?? []}::text[])`;
  const [row] = await db.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM accounting_ledger_entries a
      LEFT JOIN journal_entries je ON a.reference_type = 'JournalEntry' AND je.id = a.reference_id
      WHERE ${where} AND NOT a.is_cancelled AND a.date < ${before}
        AND (je.id IS NULL OR (je.source_type IS DISTINCT FROM 'OPENING' AND NOT (je.id = ANY(${openingIds}::text[]))))
    ) AS found`;
  return Boolean(row?.found);
}

function classify(r: Omit<LegacyOpeningRow, 'cls'>, isDeposit: boolean): OpeningAuditClass {
  if (isDeposit) return 'deposit-legacy';
  if (r.status !== 'Submitted') return 'not-submitted';
  if (!r.twoLine) return 'multi-line';
  if (r.ruleProblem) return 'refused-account';
  if (r.openingsForTarget > 1 || r.keyedActive) return 'multi';
  if (r.priorActivity) return 'patch-delta';
  return 'single-two-line-opening';
}

async function accountRuleProblems(db: Db, accountIds: readonly string[], roles: RoleAccounts): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const accounts = await db.account.findMany({
    where: { id: { in: [...accountIds] } },
    select: { id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true },
  });
  const control = await loadControlAccountMap(db as Tx);
  for (const acc of accounts) {
    const refusedRole = roles.refused.get(acc.id);
    const problem = refusedRole ? { code: refusedRole } : postableAccountProblem(acc, OPENING_ACCOUNT_RULE, control.get(acc.id) ?? null);
    if (problem) out.set(acc.id, problem.code);
  }
  return out;
}

async function legacyRows(
  db: Db,
  journals: OpeningJournal[],
  cashBook: ReadonlySet<string>,
  roles: RoleAccounts,
  openingIds: readonly string[],
  cutoverDay: string | null,
): Promise<LegacyOpeningRow[]> {
  const legacy = journals.flatMap((j) => {
    const detection = detect(j, cashBook);
    return detection ? [{ j, detection, targets: journalTargets(j, roles) }] : [];
  });
  const activeKeys = new Set(journals.filter((j) => j.sourceKey !== null).map((j) => j.sourceKey as string));
  const perTarget = new Map<string, number>();
  for (const { targets } of legacy) for (const t of targets) perTarget.set(targetKey(t.target), (perTarget.get(targetKey(t.target)) ?? 0) + 1);

  const accountIds = [...new Set(legacy.flatMap(({ targets }) => targets.filter((t) => t.target.kind === 'ACCOUNT').map((t) => t.target.accountId)))];
  const partyIds = [...new Set(legacy.flatMap(({ targets }) => targets.flatMap((t) => (t.target.kind === 'PARTY' ? [t.target.partyId] : []))))];
  const problems = await accountRuleProblems(db, accountIds, roles);
  const parties = await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } });
  const partyName = new Map(parties.map((p) => [p.id, p.name]));

  const rows: LegacyOpeningRow[] = [];
  for (const { j, detection, targets } of legacy) {
    const isDeposit = detection === 'deposit-narration' || j.payment?.paymentType === 'VendorDeposit' || j.payment?.paymentType === 'CustomerDeposit';
    const day = businessDayOf(j.date);
    const base = {
      journalId: j.id, entryNumber: j.entryNumber, date: j.date, day, status: j.status, sourceType: j.sourceType,
      narration: j.narration, fiscalYearClosed: j.fiscalYear.isClosed, detection, lineCount: j.items.length,
      targetCount: targets.length, afterCutover: cutoverDay !== null && day > cutoverDay,
    };
    if (targets.length === 0) {
      const row = { ...base, target: null, accountNumber: null, accountName: null, partyName: null, amount: ZERO, twoLine: false,
        priorActivity: false, openingsForTarget: 0, keyedActive: false, ruleProblem: null, proposedKey: null };
      rows.push({ ...row, cls: classify(row, isDeposit) });
      continue;
    }
    for (const t of targets) {
      const key = targetKey(t.target);
      const deposit = isDeposit || (t.target.kind === 'PARTY' && (t.target.subledger === 'VDEP' || t.target.subledger === 'CDEP'));
      const row = {
        ...base,
        target: t.target,
        accountNumber: t.accountNumber,
        accountName: t.accountName,
        partyName: t.target.kind === 'PARTY' ? partyName.get(t.target.partyId) ?? null : null,
        amount: t.amount,
        twoLine: j.items.length === 2 && targets.length === 1 && j.items.some((i) => roles.openingEquity.has(i.accountId)),
        priorActivity: await hasPriorActivity(db, t.target, j.date, openingIds, roles),
        openingsForTarget: perTarget.get(key) ?? 0,
        keyedActive: activeKeys.has(key),
        ruleProblem: t.target.kind === 'ACCOUNT' ? problems.get(t.target.accountId) ?? null : null,
        proposedKey: key,
      };
      rows.push({ ...row, cls: classify(row, deposit) });
    }
  }
  return rows;
}

/** Active non-opening journals against OPENING_EQUITY, one row per counter account. */
async function equityCounterRows(db: Db, roles: RoleAccounts, openingIds: readonly string[], cutoverDay: string | null): Promise<EquityCounterRow[]> {
  const journals = await db.journalEntry.findMany({
    where: {
      status: { not: 'Cancelled' },
      id: { notIn: [...openingIds] },
      OR: [{ sourceType: null }, { sourceType: { not: 'OPENING' } }],
      items: { some: { accountId: { in: [...roles.openingEquity] } } },
    },
    select: {
      id: true, entryNumber: true, date: true, status: true, sourceType: true, narration: true,
      items: { select: { accountId: true, debit: true, credit: true, account: { select: { accountNumber: true, name: true } } } },
    },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });
  const limit = cutoverDay ? addDays(cutoverDay, EQUITY_COUNTER_WINDOW_DAYS) : null;
  return journals.flatMap((j) => {
    const day = businessDayOf(j.date);
    const byAccount = new Map<string, EquityCounterRow>();
    for (const item of j.items) {
      if (roles.openingEquity.has(item.accountId)) continue;
      const net = new Prisma.Decimal(item.debit).minus(item.credit);
      const prev = byAccount.get(item.accountId);
      byAccount.set(item.accountId, prev ? { ...prev, amount: prev.amount.plus(net) } : {
        journalId: j.id, entryNumber: j.entryNumber, day, status: j.status, sourceType: j.sourceType, narration: j.narration,
        accountId: item.accountId, accountNumber: item.account.accountNumber, accountName: item.account.name, amount: net,
        nearCutover: limit !== null && day <= limit,
      });
    }
    return [...byAccount.values()];
  });
}

/** Parties whose opening_outstanding differs from their active receivable/payable opening journals. */
async function partyRows(db: Db, journals: OpeningJournal[], cashBook: ReadonlySet<string>, roles: RoleAccounts): Promise<PartyOpeningRow[]> {
  const sums = new Map<string, Prisma.Decimal>();
  for (const j of journals) {
    if (j.sourceKey === null && !detect(j, cashBook)) continue;
    for (const item of j.items) {
      const kind = roles.partyKind.get(item.accountId);
      if (!item.partyId || (kind !== 'AR' && kind !== 'AP')) continue;
      const net = new Prisma.Decimal(item.debit).minus(item.credit);
      sums.set(item.partyId, (sums.get(item.partyId) ?? ZERO).plus(kind === 'AR' ? net : net.negated()));
    }
  }
  const parties = await db.party.findMany({
    where: { OR: [{ openingOutstanding: { not: 0 } }, { id: { in: [...sums.keys()] } }] },
    select: { id: true, name: true, partyType: true, openingOutstanding: true },
    orderBy: { name: 'asc' },
  });
  return parties.flatMap((p) => {
    const fromJournals = sums.get(p.id) ?? ZERO;
    const difference = new Prisma.Decimal(p.openingOutstanding).minus(fromJournals);
    return difference.isZero()
      ? []
      : [{ partyId: p.id, name: p.name, partyType: p.partyType, openingOutstanding: new Prisma.Decimal(p.openingOutstanding), fromJournals, difference }];
  });
}

/** The read-only audit. Run it inside a transaction for one consistent snapshot. */
export async function planOpeningBalanceAudit(db: Db, opts: OpeningAuditOptions = {}): Promise<OpeningAuditReport> {
  const cutoverDay = opts.cutoverDay ?? (await defaultCutoverDay(db));
  const roles = await loadRoleAccounts(db);
  const { journals, cashBook } = await loadOpeningJournals(db);
  const openingIds = journals.filter((j) => j.sourceType === 'OPENING' || j.sourceKey !== null || detect(j, cashBook)).map((j) => j.id);
  return {
    cutoverDay,
    openings: await legacyRows(db, journals, cashBook, roles, openingIds, cutoverDay),
    equityCounters: await equityCounterRows(db, roles, openingIds, cutoverDay),
    duplicates: await findActiveDuplicateKeys(db),
    parties: await partyRows(db, journals, cashBook, roles),
  };
}

export class OpeningAuditRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningAuditRefusal';
  }
}

export interface ApplyOpeningKeysOptions extends OpeningAuditOptions {
  /** Accountant who approved the keys; required when writing. */
  approvedBy: string | null;
  /** Entry numbers the accountant keys explicitly, whatever their class. */
  keyJournals?: readonly string[];
  /** false = only report what would be keyed (dry run). */
  write: boolean;
}

export interface KeyedOpening {
  journalId: string;
  entryNumber: string;
  sourceKey: string;
  cls: OpeningAuditClass;
  explicit: boolean;
}

export interface ApplyOpeningKeysResult {
  report: OpeningAuditReport;
  keyed: KeyedOpening[];
}

/** Why an explicitly named journal cannot be keyed, or null. */
function explicitProblem(entryNumber: string, rows: readonly LegacyOpeningRow[], takenKeys: ReadonlySet<string>): string | null {
  const own = rows.filter((r) => r.entryNumber === entryNumber);
  if (own.length === 0) return `${entryNumber}: not an active opening journal without a sourceKey`;
  if (own.length > 1 || !own[0]!.target) return `${entryNumber}: touches ${own.length > 1 ? 'several targets' : 'no target'}; one key cannot cover it`;
  const row = own[0]!;
  if (row.status !== 'Submitted') return `${entryNumber}: status ${row.status}, only a submitted journal is keyed`;
  if (row.sourceType !== null && row.sourceType !== 'OPENING' && row.sourceType !== 'SYSTEM_DOC') {
    return `${entryNumber}: source type ${row.sourceType} is not an opening`;
  }
  if (row.keyedActive || takenKeys.has(row.proposedKey as string)) return `${entryNumber}: another active journal holds ${row.proposedKey}`;
  return null;
}

/**
 * Gives sourceKey (and source_type OPENING) to every single-two-line-opening journal and to the
 * journals the accountant names, in the caller's transaction. The plan is made again inside it,
 * so the classes are those of the moment of writing. A named journal that cannot be keyed (not an
 * unkeyed opening, several targets, a draft, or its key already held) refuses the whole run before
 * anything is written. One audit row per keyed journal, naming the accountant.
 */
export async function applyOpeningKeys(tx: Tx, opts: ApplyOpeningKeysOptions): Promise<ApplyOpeningKeysResult> {
  const approvedBy = opts.approvedBy?.trim() ?? '';
  if (opts.write && !approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  const report = await planOpeningBalanceAudit(tx, opts);
  const named = [...new Set(opts.keyJournals ?? [])];

  const planned: KeyedOpening[] = [];
  const taken = new Set<string>();
  const problems: string[] = [];
  for (const entryNumber of named) {
    const problem = explicitProblem(entryNumber, report.openings, taken);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const row = report.openings.find((r) => r.entryNumber === entryNumber)!;
    taken.add(row.proposedKey as string);
    planned.push({ journalId: row.journalId, entryNumber, sourceKey: row.proposedKey as string, cls: row.cls, explicit: true });
  }
  if (problems.length > 0) throw new OpeningAuditRefusal(`Nothing was keyed:\n  ${problems.join('\n  ')}`);
  for (const row of report.openings) {
    if (row.cls !== 'single-two-line-opening' || named.includes(row.entryNumber)) continue;
    planned.push({ journalId: row.journalId, entryNumber: row.entryNumber, sourceKey: row.proposedKey as string, cls: row.cls, explicit: false });
  }
  if (!opts.write || planned.length === 0) return { report, keyed: planned };

  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');
  const ids = planned.map((p) => p.journalId).sort();
  await tx.$queryRaw`SELECT id FROM journal_entries WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;

  const keyed: KeyedOpening[] = [];
  for (const p of planned) {
    const before = report.openings.find((r) => r.journalId === p.journalId)!;
    const holder = await tx.journalEntry.findFirst({ where: { sourceKey: p.sourceKey, status: { not: 'Cancelled' } }, select: { entryNumber: true } });
    if (holder) throw new OpeningAuditRefusal(`Nothing was keyed: ${holder.entryNumber} took ${p.sourceKey} while the run was planned.`);
    const { count } = await tx.journalEntry.updateMany({
      where: { id: p.journalId, sourceKey: null, status: 'Submitted' },
      data: { sourceKey: p.sourceKey, sourceType: 'OPENING' },
    });
    if (count !== 1) throw new OpeningAuditRefusal(`Nothing was keyed: ${p.entryNumber} changed while the run was planned.`);
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: OPENING_KEY_AUDIT_ACTION,
        entityType: 'JournalEntry',
        entityId: p.journalId,
        oldValues: { sourceType: before.sourceType, sourceKey: null },
        newValues: { sourceType: 'OPENING', sourceKey: p.sourceKey, class: p.cls, explicit: p.explicit, approvedBy },
        via: 'repair',
        viaMeta: { script: OPENING_AUDIT_SCRIPT, approvedBy },
      },
    });
    keyed.push(p);
  }
  return { report, keyed };
}
