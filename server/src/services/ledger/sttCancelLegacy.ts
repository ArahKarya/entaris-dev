// Legacy STT cancel data (E1-R6 migration, PR-6b, plan step 5 PR-5.2). Before the void model, an
// STT cancel posted a reversing journal JV-<stt>-CXL and marked the original JV-<stt> Cancelled
// without reversed_by_id (legacyCxlPair.ts). Two shapes are left in the books:
//   A  original Cancelled, its ledger rows still active, CXL Submitted: the ledger is right, only
//      the status is wrong (ale-vs-journal reports legacy-stt-pair).
//   B  original Cancelled and its ledger rows cancelled too (the old ALE sync fix rebuilt them from
//      the status), CXL Submitted: only the reversal is on the books, so inventory and the uninvoiced
//      payable are off by the STT amount, and no ledger check sees it.
// The fix gives both the final form the cancel model knows (cancelJournals.ts JOURNAL_ALREADY_REVERSED):
// original Submitted with reversed_by_id = the CXL. A keeps its ledger rows and balances, so totals do
// not move and it may be fixed in a closed year. B also reactivates the original's ledger rows and sets
// the stored balances of its accounts to the ledger (storedBalances.ts), so it only runs with
// includeAleFix, in open years after the lock date. The old ALE sync fix never touched balances, so
// whether the stored balance had dropped the original depends on a later balance-drift fix: B runs only
// when the stored balances equal the ledger without the original or still include exactly the
// original, never on top of other drift. Every other shape is reported only (C: a CXL booked to another fiscal year than its date,
// kept as is because moving it changes two years' totals, owner decision #5d; REVIEW: anything else).
import { Prisma } from '@prisma/client';
import { computeImpactDecimal } from '../../utils/accountBalance';
import { businessDayOf } from '../../utils/businessDate';
import { BusinessError } from '../../utils/errors';
import { journalFamilyWhere } from '../../utils/journalFamily';
import { assertPeriodOpen, FISCAL_YEAR_MISSING, fiscalYearOn, PERIOD_CLOSED, PERIOD_LOCKED } from '../../utils/periodGuard';
import { getPeriodLock } from '../periodLock';
import { legacyCxlPairSql } from './legacyCxlPair';
import { findAccountBalanceDrift, recalculateAccountBalances, STORED_BALANCE_TOLERANCE } from './storedBalances';

type Tx = Prisma.TransactionClient;

export const STT_CANCEL_SCRIPT = 'e1-stt-cancel-model';
export const STT_CANCEL_AUDIT_ACTION = 'E1_STT_CANCEL_LEGACY';

export type LegacySttClass = 'A' | 'B' | 'C' | 'PAIRED' | 'REVIEW';

export type LegacySttReason =
  | 'original-missing' // no JV-<stt> next to the CXL
  | 'dummy-journal' // demo data; the demo wipe owns it
  | 'stt-not-cancelled' // the STT itself is not Cancelled
  | 'original-not-cancelled' // JV-<stt> is not Cancelled (and not paired with the CXL)
  | 'cxl-not-submitted' // the CXL was cancelled or is a draft
  | 'already-reversed' // the original is marked reversed by another journal
  | 'cxl-ale-not-active' // the CXL has no ledger rows, or some are cancelled
  | 'lines-not-mirrored' // the CXL lines are not the original's lines with debit and credit swapped
  | 'ale-missing' // the original has no ledger rows at all
  | 'ale-mixed' // the original has active and cancelled ledger rows
  | 'ledger-not-lines' // a journal's ledger rows differ from its lines per account
  | 'fy-differs'; // a journal (or its ledger rows) is booked to another fiscal year than its date

/** Facts of one journal of the pair, as the classifier reads them. */
export interface LegacyJournalFacts {
  status: string;
  reversedById: string | null;
  isDummy: boolean;
  aleActive: number;
  aleCancelled: number;
  /** All ledger rows (active or not) sum to the lines, account by account. */
  ledgerMatchesLines: boolean;
  /** The journal and its ledger rows are booked to the fiscal year of the journal's date. */
  fiscalYearMatchesDate: boolean;
}

export interface LegacySttFacts {
  sttStatus: string;
  original: LegacyJournalFacts | null;
  cxl: LegacyJournalFacts;
  cxlId: string;
  /** legacyCxlPairSql on the original: its reversed_by_id is empty and a Submitted CXL exists. */
  legacyPair: boolean;
  /** CXL lines = original lines with debit and credit swapped, per account and party. */
  linesMirrored: boolean;
}

const review = (reason: LegacySttReason) => ({ cls: 'REVIEW' as const, reason });

/** Class of one STT with a CXL journal (pure; first match wins). */
export function classifyLegacyStt(f: LegacySttFacts): { cls: LegacySttClass; reason: LegacySttReason | null } {
  const o = f.original;
  if (!o) return review('original-missing');
  if (o.status === 'Submitted' && o.reversedById === f.cxlId) return { cls: 'PAIRED', reason: null };
  if (o.isDummy || f.cxl.isDummy) return review('dummy-journal');
  if (f.sttStatus !== 'Cancelled') return review('stt-not-cancelled');
  if (o.status !== 'Cancelled') return review('original-not-cancelled');
  if (f.cxl.status !== 'Submitted') return review('cxl-not-submitted');
  if (!f.legacyPair) return review('already-reversed');
  if (f.cxl.aleActive === 0 || f.cxl.aleCancelled > 0) return review('cxl-ale-not-active');
  if (!f.linesMirrored) return review('lines-not-mirrored');
  if (o.aleActive === 0 && o.aleCancelled === 0) return review('ale-missing');
  if (o.aleActive > 0 && o.aleCancelled > 0) return review('ale-mixed');
  if (!o.ledgerMatchesLines || !f.cxl.ledgerMatchesLines) return review('ledger-not-lines');
  if (!o.fiscalYearMatchesDate || !f.cxl.fiscalYearMatchesDate) return { cls: 'C', reason: 'fy-differs' };
  return { cls: o.aleCancelled === 0 ? 'A' : 'B', reason: null };
}

export interface LegacySttJournal {
  id: string;
  entryNumber: string;
  status: string;
  day: string;
  fiscalYearName: string;
  yearClosed: boolean;
  cancelledAt: Date | null;
}

export interface LegacySttRow {
  sttId: string;
  sttNumber: string;
  sttStatus: string;
  cls: LegacySttClass;
  reason: LegacySttReason | null;
  original: LegacySttJournal | null;
  cxl: LegacySttJournal;
  /** Debit total of the original's lines (the CXL's when the original is missing). */
  amount: Prisma.Decimal;
  originalAleActive: number;
  originalAleCancelled: number;
  /** A journal of the pair is dated on or before the period lock date. */
  locked: boolean;
  /** fix = status only (A); fix-ledger = status, ledger rows and balances (B); none = report only. */
  action: 'fix' | 'fix-ledger' | 'none';
  /** B only: why includeAleFix would skip it now. */
  ledgerFixBlocked: 'closed-year' | 'locked' | 'stored-balance-drift' | null;
  /** B only: the stored balances of the original's accounts against the active ledger rows. */
  storedBalance: StoredBalanceCheck | null;
}

/**
 * How the stored balances of a B original's accounts stand before its ledger rows are reactivated:
 *   follows-ledger     stored = active ledger (without the original): a balance-drift fix ran after
 *                      the ALE sync; reactivating adds the original's impact.
 *   includes-original  stored = active ledger + the original's impact: no fix ran since; reactivating
 *                      makes the ledger match and the balances stay.
 *   drift              anything else (other drift on the account): B is skipped, recalculate first.
 */
export type StoredBalanceState = 'follows-ledger' | 'includes-original' | 'drift';

export interface StoredBalanceAccount {
  accountId: string;
  accountNumber: string;
  /** stored - active ledger, before the fix. */
  difference: Prisma.Decimal;
  /** The original's lines on this account, signed by its normal side. */
  originalImpact: Prisma.Decimal;
}

export interface StoredBalanceCheck {
  state: StoredBalanceState;
  accounts: StoredBalanceAccount[];
}

/** storedBalances.ts drift of the accounts of `items`, compared with their impact (read-only). */
export async function storedBalanceCheck(
  db: Tx,
  items: readonly { accountId: string; debit: Prisma.Decimal.Value; credit: Prisma.Decimal.Value }[],
): Promise<StoredBalanceCheck> {
  const totals = totalsBy(items, (i) => i.accountId);
  const ids = [...totals.keys()].sort();
  const accounts = await db.account.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, accountNumber: true, rootType: true } });
  const drift = await findAccountBalanceDrift(db, { accountIds: ids });
  const differenceOf = new Map(drift.rows.map((r) => [r.accountId, r.difference]));
  const rows = accounts.map((a) => {
    const t = totals.get(a.id)!;
    return {
      accountId: a.id,
      accountNumber: a.accountNumber,
      difference: differenceOf.get(a.id) ?? new Prisma.Decimal(0),
      originalImpact: computeImpactDecimal(a.rootType, t.debit, t.credit),
    };
  });
  const within = (x: Prisma.Decimal) => x.abs().lte(STORED_BALANCE_TOLERANCE);
  const state: StoredBalanceState =
    accounts.length !== ids.length ? 'drift'
      : rows.every((r) => within(r.difference)) ? 'follows-ledger'
        : rows.every((r) => within(r.difference.minus(r.originalImpact))) ? 'includes-original'
          : 'drift';
  return { state, accounts: rows };
}

export interface LegacySttScope {
  /** Pairs with either journal booked to this year. */
  fiscalYearId?: string;
  sttNumbers?: readonly string[];
}

interface PairRow {
  stt_id: string;
  stt_number: string;
  stt_status: string;
  original_id: string | null;
  cxl_id: string;
  legacy_pair: boolean;
}

function pairScopeSql(scope: LegacySttScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (scope.fiscalYearId) parts.push(Prisma.sql`(o.fiscal_year_id = ${scope.fiscalYearId} OR c.fiscal_year_id = ${scope.fiscalYearId})`);
  if (scope.sttNumbers) parts.push(Prisma.sql`g.stt_number IN (${Prisma.join([...scope.sttNumbers])})`);
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

type Totals = Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>;

function totalsBy<T extends { debit: Prisma.Decimal.Value; credit: Prisma.Decimal.Value }>(rows: readonly T[], key: (r: T) => string): Totals {
  const out: Totals = new Map();
  for (const r of rows) {
    const t = out.get(key(r)) ?? { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
    out.set(key(r), { debit: t.debit.plus(r.debit), credit: t.credit.plus(r.credit) });
  }
  return out;
}

/** a equals b, or b with debit and credit swapped when `swap`. */
function sameTotals(a: Totals, b: Totals, swap = false): boolean {
  if (a.size !== b.size) return false;
  for (const [k, t] of a) {
    const u = b.get(k);
    if (!u) return false;
    const [debit, credit] = swap ? [u.credit, u.debit] : [u.debit, u.credit];
    if (!t.debit.equals(debit) || !t.credit.equals(credit)) return false;
  }
  return true;
}

/**
 * Every STT with a JV-<stt>-CXL journal, classified, ordered by STT number. Read-only (SELECT
 * only), in the caller's transaction or client; the close check legacy-stt-cancel runs it per year.
 */
export async function planSttCancelLegacy(db: Tx, scope: LegacySttScope = {}): Promise<LegacySttRow[]> {
  if (scope.sttNumbers && scope.sttNumbers.length === 0) return [];
  const pairs = await db.$queryRaw<PairRow[]>`
    SELECT g.id AS stt_id, g.stt_number, g.status::text AS stt_status, o.id AS original_id, c.id AS cxl_id,
           COALESCE(${legacyCxlPairSql('o')}, false) AS legacy_pair
      FROM goods_receipts g
      JOIN journal_entries c ON c.entry_number = 'JV-' || g.stt_number || '-CXL'
      LEFT JOIN journal_entries o ON o.entry_number = 'JV-' || g.stt_number
      ${pairScopeSql(scope)}
     ORDER BY g.stt_number`;
  if (pairs.length === 0) return [];

  const ids = pairs.flatMap((p) => (p.original_id ? [p.original_id, p.cxl_id] : [p.cxl_id]));
  const [journals, ledger, lock] = await Promise.all([
    db.journalEntry.findMany({ where: { id: { in: ids } }, include: { items: true, fiscalYear: { select: { name: true, isClosed: true } } } }),
    db.accountingLedgerEntry.findMany({
      where: { referenceType: 'JournalEntry', referenceId: { in: ids } },
      select: { referenceId: true, accountId: true, debit: true, credit: true, isCancelled: true, fiscalYearId: true },
    }),
    getPeriodLock(db),
  ]);
  const byId = new Map(journals.map((j) => [j.id, j]));

  const journalFacts = async (id: string) => {
    const j = byId.get(id)!;
    const rows = ledger.filter((r) => r.referenceId === id);
    const fyOfDate = await fiscalYearOn(db, j.date);
    const facts: LegacyJournalFacts = {
      status: j.status,
      reversedById: j.reversedById,
      isDummy: j.isDummy,
      aleActive: rows.filter((r) => !r.isCancelled).length,
      aleCancelled: rows.filter((r) => r.isCancelled).length,
      ledgerMatchesLines: sameTotals(totalsBy(rows, (r) => r.accountId), totalsBy(j.items, (i) => i.accountId)),
      fiscalYearMatchesDate: fyOfDate?.id === j.fiscalYearId && rows.every((r) => r.fiscalYearId === j.fiscalYearId),
    };
    const view: LegacySttJournal = {
      id: j.id,
      entryNumber: j.entryNumber,
      status: j.status,
      day: businessDayOf(j.date),
      fiscalYearName: j.fiscalYear.name,
      yearClosed: j.fiscalYear.isClosed,
      cancelledAt: j.cancelledAt,
    };
    return { facts, view, items: j.items };
  };

  const rows: LegacySttRow[] = [];
  for (const p of pairs) {
    const cxl = await journalFacts(p.cxl_id);
    const original = p.original_id ? await journalFacts(p.original_id) : null;
    const lineKey = (i: { accountId: string; partyId: string | null }) => `${i.accountId}|${i.partyId ?? ''}`;
    const { cls, reason } = classifyLegacyStt({
      sttStatus: p.stt_status,
      original: original?.facts ?? null,
      cxl: cxl.facts,
      cxlId: p.cxl_id,
      legacyPair: p.legacy_pair,
      linesMirrored: !!original && sameTotals(totalsBy(original.items, lineKey), totalsBy(cxl.items, lineKey), true),
    });
    const lockDate = lock.lockDate;
    const locked = lockDate !== null && [original?.view.day, cxl.view.day].some((d) => d !== undefined && d <= lockDate);
    const closed = !!original?.view.yearClosed || cxl.view.yearClosed;
    const storedBalance = cls === 'B' ? await storedBalanceCheck(db, original!.items) : null;
    rows.push({
      sttId: p.stt_id,
      sttNumber: p.stt_number,
      sttStatus: p.stt_status,
      cls,
      reason,
      original: original?.view ?? null,
      cxl: cxl.view,
      amount: (original ?? cxl).items.reduce((s, i) => s.plus(i.debit), new Prisma.Decimal(0)),
      originalAleActive: original?.facts.aleActive ?? 0,
      originalAleCancelled: original?.facts.aleCancelled ?? 0,
      locked,
      action: cls === 'A' ? 'fix' : cls === 'B' ? 'fix-ledger' : 'none',
      ledgerFixBlocked: cls !== 'B' ? null
        : closed ? 'closed-year'
          : locked ? 'locked'
            : storedBalance!.state === 'drift' ? 'stored-balance-drift'
              : null,
      storedBalance,
    });
  }
  return rows;
}

export class SttCancelRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttCancelRefusal';
  }
}

export interface SttCancelApplyOptions {
  /** Accountant who approved the CSV; required. */
  approvedBy: string;
  /** Also fix class B (reactivates ledger rows and changes balance-sheet balances). */
  includeAleFix?: boolean;
}

export interface SttCancelApplyResult {
  approvedBy: string;
  /** STT numbers fixed as class A (status only). */
  fixed: string[];
  /** STT numbers fixed as class B (status, ledger rows, balances). */
  ledgerFixed: string[];
  skipped: { sttNumber: string; why: string }[];
}

const PERIOD_SKIPS = new Set([PERIOD_CLOSED, PERIOD_LOCKED, FISCAL_YEAR_MISSING]);

/** Why B cannot touch the ledger of the pair now (closed year, lock date), or null. */
async function periodProblem(tx: Tx, journals: readonly { fiscalYearId: string; date: Date }[]): Promise<string | null> {
  try {
    for (const j of journals) await assertPeriodOpen(tx, { fiscalYearId: j.fiscalYearId, date: j.date }, 'penerimaan barang');
    return null;
  } catch (e) {
    if (e instanceof BusinessError && e.code && PERIOD_SKIPS.has(e.code)) return `${e.code}: open the year or move the lock back first`;
    throw e;
  }
}

/**
 * Fixes the A rows of `plan` (and the B rows with includeAleFix) in the caller's transaction. Both
 * journals of every planned pair are locked (FOR UPDATE, id order) and classified again; a pair whose
 * class or journals changed since the plan is skipped, as is a B pair whose year is closed or whose
 * date is on or before the lock date. One audit row per fixed original, with its old cancel fields.
 */
export async function applySttCancelLegacy(tx: Tx, plan: readonly LegacySttRow[], opts: SttCancelApplyOptions): Promise<SttCancelApplyResult> {
  const approvedBy = opts.approvedBy?.trim() ?? '';
  if (!approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  const result: SttCancelApplyResult = { approvedBy, fixed: [], ledgerFixed: [], skipped: [] };
  const todo = plan.filter((r) => r.action !== 'none');
  if (todo.length === 0) return result;

  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');
  const ids = todo.flatMap((r) => [r.original!.id, r.cxl.id]).sort();
  await tx.$queryRaw`SELECT id FROM journal_entries WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  const fresh = new Map((await planSttCancelLegacy(tx, { sttNumbers: todo.map((r) => r.sttNumber) })).map((r) => [r.sttNumber, r]));

  for (const planned of todo) {
    const now = fresh.get(planned.sttNumber);
    const skip = (why: string) => result.skipped.push({ sttNumber: planned.sttNumber, why });
    if (!now || now.cls !== planned.cls || now.original?.id !== planned.original!.id || now.cxl.id !== planned.cxl.id) {
      skip(`changed since the plan (now ${now ? now.cls : 'gone'})`);
      continue;
    }
    if (now.cls === 'B' && !opts.includeAleFix) {
      skip('class B changes the ledger: run with --include-ale-fix');
      continue;
    }
    const family = await tx.journalEntry.findMany({ where: journalFamilyWhere(`JV-${now.sttNumber}`), include: { items: true } });
    const original = family.find((j) => j.id === now.original!.id)!;
    const cxl = family.find((j) => j.id === now.cxl.id)!;
    let storedIds: string[] = [];
    let storedState: StoredBalanceState | null = null;
    if (now.cls === 'B') {
      const problem = await periodProblem(tx, [original, cxl]);
      if (problem) {
        skip(problem);
        continue;
      }
      // Read again per pair: an earlier B pair in this run may share the accounts.
      const stored = await storedBalanceCheck(tx, original.items);
      if (stored.state === 'drift') {
        const detail = stored.accounts.map((a) => `${a.accountNumber} ${a.difference.toFixed(2)}`).join(', ');
        skip(`stored-balance-drift: stored balances differ from the ledger (${detail}); run the stored-balance recalculation first`);
        continue;
      }
      storedIds = stored.accounts.map((a) => a.accountId);
      storedState = stored.state;
    }

    const { count } = await tx.journalEntry.updateMany({
      where: { id: original.id, status: 'Cancelled', reversedById: null },
      data: { status: 'Submitted', cancelledAt: null, cancelledById: null, cancelReason: null, reversedById: cxl.id },
    });
    if (count !== 1) {
      skip('changed since the plan (journal no longer Cancelled)');
      continue;
    }
    if (now.cls === 'B') {
      // One statement for the whole group, so a ledger balance trigger sees it balanced at commit.
      const ale = await tx.accountingLedgerEntry.updateMany({
        where: { referenceType: 'JournalEntry', referenceId: original.id, isCancelled: true },
        data: { isCancelled: false },
      });
      if (ale.count !== now.originalAleCancelled) {
        throw new SttCancelRefusal(`Nothing was changed: the ledger rows of ${original.entryNumber} changed while the run was planned.`);
      }
      // The one balance rule: the stored balances of the pair's accounts become the active ledger,
      // which now includes the original. follows-ledger adds its impact; includes-original is a no-op.
      if (storedIds.length > 0) await recalculateAccountBalances(tx, storedIds);
      const left = await findAccountBalanceDrift(tx, { accountIds: storedIds });
      if (left.total > 0) {
        throw new SttCancelRefusal(`Nothing was changed: the stored balances of ${original.entryNumber} still differ from the ledger after the fix.`);
      }
    }
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: STT_CANCEL_AUDIT_ACTION,
        entityType: 'JournalEntry',
        entityId: original.id,
        oldValues: {
          status: original.status,
          cancelledAt: original.cancelledAt?.toISOString() ?? null,
          cancelledById: original.cancelledById,
          cancelReason: original.cancelReason,
          reversedById: null,
          aleActive: now.originalAleActive,
          aleCancelled: now.originalAleCancelled,
        },
        newValues: {
          status: 'Submitted',
          reversedById: cxl.id,
          cxlEntryNumber: cxl.entryNumber,
          sttNumber: now.sttNumber,
          class: now.cls,
          ledgerReactivated: now.cls === 'B',
          storedBalance: storedState,
          amount: now.amount.toFixed(2),
          approvedBy,
        },
        via: 'repair',
        viaMeta: { script: STT_CANCEL_SCRIPT, approvedBy },
      },
    });
    (now.cls === 'B' ? result.ledgerFixed : result.fixed).push(now.sttNumber);
  }
  return result;
}

/** Times the old health-check fixes ran (audit_trail), the evidence of how class B came about. */
export async function legacyFixRuns(db: Tx): Promise<{ aleSync: Date[]; balanceDrift: Date[] }> {
  const rows = await db.auditLog.findMany({
    where: { action: { in: ['FIX_ALE_SYNC', 'FIX_ACCOUNT_BALANCE_DRIFT'] } },
    orderBy: { createdAt: 'asc' },
    select: { action: true, createdAt: true },
  });
  return {
    aleSync: rows.filter((r) => r.action === 'FIX_ALE_SYNC').map((r) => r.createdAt),
    balanceDrift: rows.filter((r) => r.action === 'FIX_ACCOUNT_BALANCE_DRIFT').map((r) => r.createdAt),
  };
}
