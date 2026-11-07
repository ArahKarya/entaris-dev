// The one opening balance service and the one cut-over date (E2-R11, plan step 5 §2.4). Every
// opening balance writer (the COA screen, the COA import; the party opening balance and the
// opening deposit later) calls setOpeningBalanceInTx in its own transaction:
//   1. the cut-over date: company_settings.cutover_date, or the start of the earliest open fiscal
//      year; an asOfDate on another day is refused (OPENING_DATE_MISMATCH);
//   2. the target account: a balance sheet detail account, never a control account
//      (OPENING_ACCOUNT_RULE) nor the opening equity / current profit account (OPENING_ACCOUNT_KIND);
//   3. the JV advisory lock of the cut-over month, then the target and opening equity rows
//      (the order of every other JV writer: number first, accounts after);
//   4. the active opening journals of the target: keyed ones (sourceKey OPENING:ACCOUNT:<id>) are
//      this service's own; an unkeyed legacy one (old COA screen, old import, OB- number) refuses
//      the whole call (OPENING_LEGACY_REVIEW) until the opening audit script keys it;
//   5. the same journal again is 'unchanged': nothing is cancelled or posted;
//   6. otherwise the keyed journals are voided and the difference between the amount and the
//      ledger before the cut-over day (openingBase) is posted on the cut-over day.
// The amount is the account's balance AT the cut-over date, read from the ledger, never from
// accounts.balance (E2-R15). Party targets (AR, AP, deposits) are declared here and arrive in PR-5.11.

import { Prisma, type PrismaClient } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { businessDayOf, startOfBusinessDay, addDays } from '../../utils/businessDate';
import { FISCAL_YEAR_MISSING, fiscalYearOn, fiscalYearRange, type PeriodGuardOptions } from '../../utils/periodGuard';
import { cancelTrail, type CancelTrail } from '../../utils/cancelClaim';
import { mappedAccount } from '../systemAccounts';
import { lockAccounts } from '../coa/accountStructure';
import { assertPostableAccount, DOCUMENT_RULE, loadControlAccountMap, OPENING_ACCOUNT_RULE, postableAccountProblem, type AccountLite } from './accountGuard';
import { cancelJournalsInTx, type JournalWithItems } from './cancelJournals';
import { classifyLegacyJournal, sourceKeys, type OpeningPartyKind } from './journalSource';
import { postJournal } from './postJournal';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;
type Decimal = Prisma.Decimal;

/** asOfDate is not the cut-over date. */
export const OPENING_DATE_MISMATCH = 'OPENING_DATE_MISMATCH';
/** The account is the opening equity or the current profit account. */
export const OPENING_ACCOUNT_KIND = 'OPENING_ACCOUNT_KIND';
/** A party's opening balance is already used by a payment or an application (PR-5.11). */
export const OPENING_IN_USE = 'OPENING_IN_USE';
/** A party's opening balance below zero (PR-5.11). */
export const OPENING_NEGATIVE = 'OPENING_NEGATIVE';
/** The target still has an opening journal without a key; the opening audit decides it first. */
export const OPENING_LEGACY_REVIEW = 'OPENING_LEGACY_REVIEW';
/** The party has receivable or payable ledger rows before the cut-over date (PR-5.11). */
export const OPENING_PARTY_HAS_HISTORY = 'OPENING_PARTY_HAS_HISTORY';
/** Posting through the period lock without the period.lock right, or through AIRA. */
export const OPENING_LOCK_RIGHT = 'OPENING_LOCK_RIGHT';

/** audit_trail actions of this service. */
export const SET_CUTOVER_DATE_ACTION = 'SET_CUTOVER_DATE';
export const OPENING_THROUGH_LOCK_ACTION = 'OPENING_THROUGH_LOCK';

export type OpeningTarget =
  | { kind: 'ACCOUNT'; accountId: string }
  | { kind: 'PARTY'; partyId: string; subledger: OpeningPartyKind };

export interface SetOpeningInput {
  target: OpeningTarget;
  /** The balance at the cut-over date on the account's normal side; negative for a contra balance. */
  amount: Prisma.Decimal.Value;
  /** YYYY-MM-DD; when given it must be the cut-over date. */
  asOfDate?: string;
  userId: string;
  /** Stored on the replaced journals; default: this user, "replaced by a new opening balance". */
  trail?: CancelTrail;
  /** Post or replace through the monthly period lock (owner decision #10); the caller checks period.lock. */
  throughLock?: { reason: string };
}

export interface OpeningOutcome {
  action: 'posted' | 'replaced' | 'cancelled' | 'unchanged';
  asOfDate: string;
  amount: Decimal;
  /** The opening journal now active for the target (the new one, or the unchanged one), or null. */
  journal: JournalWithItems | null;
  /** Entry numbers of the journals this call voided. */
  cancelled: string[];
}

export interface CutoverPeek {
  day: string;
  /** true when company_settings already holds the date; false when it is derived (not stored). */
  stored: boolean;
}

const ZERO = new Prisma.Decimal(0);
const SETTINGS_SLUG = 'default';
const REPLACED_REASON = 'Diganti saldo awal baru';
const DEPOSIT_OPENING_NARRATION = /^Saldo Awal Uang Muka (Vendor|Pelanggan)\b/;

const dateDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Start day of the earliest open fiscal year; FISCAL_YEAR_MISSING when no year is open. */
async function earliestOpenYearStart(db: Db): Promise<string> {
  const fy = await db.fiscalYear.findFirst({ where: { isClosed: false }, orderBy: { startDate: 'asc' } });
  if (!fy) {
    throw new BusinessError(
      'Belum ada tahun buku terbuka; tanggal cut-over saldo awal diambil dari awal tahun buku terbuka paling awal. Buat tahun buku terlebih dahulu.',
      FISCAL_YEAR_MISSING,
    );
  }
  return fiscalYearRange(fy).startDay;
}

/** The cut-over date without writing anything (dialogs, previews, GET routes). */
export async function peekCutoverDate(db: Db): Promise<CutoverPeek> {
  const settings = await db.companySettings.findUnique({ where: { slug: SETTINGS_SLUG }, select: { cutoverDate: true } });
  if (settings?.cutoverDate) return { day: dateDay(settings.cutoverDate), stored: true };
  return { day: await earliestOpenYearStart(db), stored: false };
}

/**
 * The cut-over date, stored on first use: the settings row is created when missing and locked
 * FOR UPDATE; an empty date is filled with the start of the earliest open fiscal year and one
 * SET_CUTOVER_DATE audit row is written. Called only by a posting that writes a journal; the
 * date never changes on its own afterwards (owner decision #1).
 */
export async function resolveCutoverDate(tx: Tx, userId: string): Promise<string> {
  await tx.companySettings.upsert({
    where: { slug: SETTINGS_SLUG },
    update: {},
    create: { slug: SETTINGS_SLUG, companyName: '' },
  });
  const [row] = await tx.$queryRaw<{ id: string; cutover_date: string | null }[]>`
    SELECT id, cutover_date::text AS cutover_date FROM company_settings WHERE slug = ${SETTINGS_SLUG} FOR UPDATE`;
  if (row.cutover_date) return row.cutover_date;
  const day = await earliestOpenYearStart(tx);
  await tx.$executeRaw`UPDATE company_settings SET cutover_date = ${day}::date WHERE id = ${row.id} AND cutover_date IS NULL`;
  await tx.auditLog.create({
    data: {
      userId,
      action: SET_CUTOVER_DATE_ACTION,
      entityType: 'CompanySettings',
      entityId: row.id,
      oldValues: { cutoverDate: null },
      newValues: { cutoverDate: day },
    },
  });
  return day;
}

/** The instant of every opening journal of `day`: its business-day start (posting and openingBase share it). */
export function openingJournalInstant(day: string): Date {
  return startOfBusinessDay(day);
}

function accountIdOf(target: OpeningTarget): string {
  if (target.kind !== 'ACCOUNT') {
    throw new BusinessError('Saldo awal pihak belum didukung oleh layanan saldo awal.');
  }
  return target.accountId;
}

/** True for a legacy (unkeyed, source NULL) journal the old rules classify as an opening balance. */
function isLegacyOpening(j: JournalWithItems): boolean {
  if (j.sourceType === 'OPENING') return true;
  if (DEPOSIT_OPENING_NARRATION.test(j.narration ?? '')) return true;
  if (j.sourceType !== null) return false;
  const facts = {
    entryNumber: j.entryNumber, narration: j.narration, fiscalYearId: j.fiscalYearId, createdAt: j.createdAt,
    depreciationEntryCount: 0, inCashBookDraft: false, openingStockMovement: false, hasDocumentLink: false,
    manualAudit: false, recurringAudit: false, matchesRecurringTemplate: false, nearImportBatch: false,
  };
  return classifyLegacyJournal(facts).type === 'OPENING';
}

/**
 * Active (not Cancelled) opening journals touching the target: `keyed` carry this target's
 * sourceKey; `legacy` have no key and are an opening balance by source type, by the legacy
 * classification (OB- number, "Saldo awal …" narration) or as an opening deposit journal.
 */
export async function findActiveOpeningJournals(
  tx: Db,
  target: OpeningTarget,
): Promise<{ keyed: JournalWithItems[]; legacy: JournalWithItems[] }> {
  const accountId = accountIdOf(target);
  const key = sourceKeys.openingAccount(accountId);
  const rows = await tx.journalEntry.findMany({
    where: {
      status: { not: 'Cancelled' },
      items: { some: { accountId } },
      OR: [
        { sourceKey: key },
        {
          sourceKey: null,
          OR: [
            { sourceType: 'OPENING' },
            { sourceType: null, entryNumber: { startsWith: 'OB-' } },
            { narration: { startsWith: 'Saldo awal', mode: 'insensitive' } },
          ],
        },
      ],
    },
    include: { items: true },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });
  return {
    keyed: rows.filter((j) => j.sourceKey === key),
    legacy: rows.filter((j) => j.sourceKey === null && isLegacyOpening(j)),
  };
}

/** Normal-side sign: debit minus credit for asset accounts, credit minus debit otherwise. */
const debitNormal = (rootType: string): boolean => rootType === 'ASSET' || rootType === 'EXPENSE';
const signed = (rootType: string, debit: Prisma.Decimal.Value, credit: Prisma.Decimal.Value): Decimal =>
  debitNormal(rootType) ? new Prisma.Decimal(debit).sub(credit) : new Prisma.Decimal(credit).sub(debit);

/**
 * The account's balance at the cut-over day before this service's own journals, normal side,
 * from the ledger: every active ledger row dated before openingJournalInstant(day), plus the
 * active rows ON that day of journals that also touch the opening equity account and are not an
 * OPENING:* journal of this service (an opening balance entered another way, e.g. "Setoran modal
 * awal" against 3.1 on 1 January, or the same entry from a journal import or a recurring template,
 * which carry an IMPORT:/RECURRING: key). Journals in `excludeJournalIds` are left out.
 */
export async function openingBase(tx: Db, accountId: string, day: string, excludeJournalIds: readonly string[]): Promise<Decimal> {
  const [account, equity] = await Promise.all([
    tx.account.findUnique({ where: { id: accountId }, select: { rootType: true } }),
    tx.systemAccountMapping.findFirst({ where: { role: 'OPENING_EQUITY' }, orderBy: { sortOrder: 'asc' }, select: { accountId: true } }),
  ]);
  if (!account) return ZERO;
  const from = openingJournalInstant(day);
  const to = openingJournalInstant(addDays(day, 1));
  const excluded = [...excludeJournalIds];
  const [row] = await tx.$queryRaw<{ debit: Decimal | null; credit: Decimal | null }[]>`
    SELECT SUM(ale.debit) AS debit, SUM(ale.credit) AS credit
    FROM accounting_ledger_entries ale
    WHERE ale.account_id = ${accountId}
      AND ale.is_cancelled = false
      AND NOT (ale.reference_type = 'JournalEntry' AND ale.reference_id = ANY(${excluded}::text[]))
      AND (
        ale.date < ${from}
        OR (
          ale.date >= ${from} AND ale.date < ${to}
          AND ale.reference_type = 'JournalEntry'
          AND EXISTS (
            SELECT 1 FROM journal_entries je
            WHERE je.id = ale.reference_id
              AND (je.source_key IS NULL OR je.source_key NOT LIKE 'OPENING:%')
              AND EXISTS (
                SELECT 1 FROM journal_entry_accounts ji
                WHERE ji.journal_entry_id = je.id AND ji.account_id = ${equity?.accountId ?? ''} AND ji.account_id <> ${accountId}
              )
          )
        )
      )`;
  return signed(account.rootType, row?.debit ?? ZERO, row?.credit ?? ZERO);
}

/**
 * The opening balance this service recorded for the target: openingBase plus its keyed journals,
 * or null when it has no active keyed journal. The dialog, the COA template export and the import
 * preview show this, never accounts.balance; entering it again is 'unchanged'.
 */
export async function recordedOpening(db: Db, target: OpeningTarget): Promise<Decimal | null> {
  const accountId = accountIdOf(target);
  const { keyed } = await findActiveOpeningJournals(db, target);
  if (keyed.length === 0) return null;
  const account = await db.account.findUnique({ where: { id: accountId }, select: { rootType: true } });
  if (!account) return null;
  const { day } = await peekCutoverDate(db);
  const base = await openingBase(db, accountId, day, keyed.map((j) => j.id));
  return keyed
    .flatMap((j) => j.items.filter((i) => i.accountId === accountId))
    .reduce((sum, i) => sum.add(signed(account.rootType, i.debit, i.credit)), base);
}

export interface OpeningJournalRef {
  id: string;
  entryNumber: string;
  date: string;
  amount: string;
}

export interface AccountOpeningView {
  cutoverDate: string;
  cutoverStored: boolean;
  /** recordedOpening as a string (normal side); without a keyed journal, the ledger opening (openingBase) when not zero; else null. */
  amount: string | null;
  /** The service's own active journals (sourceKey OPENING:ACCOUNT:<id>). */
  journals: OpeningJournalRef[];
  /** Active unkeyed opening journals; the opening audit must decide on them before the balance can change. */
  legacyJournals: OpeningJournalRef[];
  /** Entry numbers of other-way openings on the cut-over day (against the opening equity) that openingBase already counts. */
  sameDayOpeningEquity: string[];
  editable: boolean;
  /** Error code the PATCH would refuse with (account rule code, OPENING_ACCOUNT_KIND, OPENING_LEGACY_REVIEW); null when editable. */
  reason: string | null;
}

/**
 * What the opening balance dialog shows for an account, without writing anything (the cut-over date
 * is peeked, never stored). `editable`/`reason` mirror the refusals of setOpeningBalanceInTx that
 * depend on the account and its journals; period and lock state are decided by the PATCH.
 */
export async function describeAccountOpening(db: Db, accountId: string): Promise<AccountOpeningView> {
  const target: OpeningTarget = { kind: 'ACCOUNT', accountId };
  const [cutover, found, recorded, control] = await Promise.all([
    peekCutoverDate(db),
    findActiveOpeningJournals(db, target),
    recordedOpening(db, target),
    loadControlAccountMap(db as Tx),
  ]);
  // No keyed journal: the ledger can still hold the opening (earlier rows, a same-day "Setoran modal awal").
  // The dialog must start from it, or saving the default would post a journal that wipes it.
  const base = recorded === null ? await openingBase(db, accountId, cutover.day, []) : null;
  const amount = recorded ?? (base !== null && !base.isZero() ? base : null);
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true },
  });
  const role = await db.systemAccountMapping.findFirst({
    where: { accountId, role: { in: ['OPENING_EQUITY', 'CURRENT_PROFIT'] } },
    select: { id: true },
  });
  const ruleProblem = postableAccountProblem(account, OPENING_ACCOUNT_RULE, control.get(accountId) ?? null);
  const reason = ruleProblem?.code ?? (role ? OPENING_ACCOUNT_KIND : found.legacy.length > 0 ? OPENING_LEGACY_REVIEW : null);
  const ref = (j: JournalWithItems): OpeningJournalRef => ({
    id: j.id,
    entryNumber: j.entryNumber,
    date: businessDayOf(j.date),
    amount: j.items
      .filter((i) => i.accountId === accountId)
      .reduce((sum, i) => sum.add(signed(account?.rootType ?? 'ASSET', i.debit, i.credit)), ZERO)
      .toFixed(2),
  });
  const equity = await db.systemAccountMapping.findFirst({ where: { role: 'OPENING_EQUITY' }, orderBy: { sortOrder: 'asc' }, select: { accountId: true } });
  const sameDay = equity && equity.accountId !== accountId
    ? await db.journalEntry.findMany({
        where: {
          status: { not: 'Cancelled' },
          date: { gte: openingJournalInstant(cutover.day), lt: openingJournalInstant(addDays(cutover.day, 1)) },
          AND: [{ items: { some: { accountId } } }, { items: { some: { accountId: equity.accountId } } }],
          OR: [{ sourceKey: null }, { NOT: { sourceKey: { startsWith: 'OPENING:' } } }],
        },
        select: { entryNumber: true },
        orderBy: { entryNumber: 'asc' },
      })
    : [];
  return {
    cutoverDate: cutover.day,
    cutoverStored: cutover.stored,
    amount: amount ? amount.toFixed(2) : null,
    journals: found.keyed.map(ref),
    legacyJournals: found.legacy.map(ref),
    sameDayOpeningEquity: sameDay.map((j) => j.entryNumber),
    editable: reason === null,
    reason,
  };
}

/** What an import row would do to the opening balance: keep it, post a first one, or replace the recorded one. */
export type OpeningImportAction = 'unchanged' | 'post' | 'replace';

export interface OpeningChangePreview {
  /** false when setOpeningBalanceInTx would refuse the account itself (`reason`); period and lock state are not checked here. */
  allowed: boolean;
  reason: string | null;
  /** null only when no fiscal year is open (reason FISCAL_YEAR_MISSING). */
  cutoverDate: string | null;
  /** The opening the account holds now (describeAccountOpening.amount), or null. */
  recorded: string | null;
  action: OpeningImportAction;
  /**
   * The amount equals the account's whole ledger balance, which differs from the recorded opening:
   * it looks like the running balance (old template). Posting it would count every movement after
   * the cut-over twice, so the import asks for a confirmation.
   */
  runningBalance: boolean;
}

/** The account as the import file describes it; `id` null for an account the import has not created yet. */
export interface OpeningPreviewAccount {
  id: string | null;
  accountNumber: string;
  name: string;
  rootType: AccountLite['rootType'];
  isGroup: boolean;
}

/**
 * Compares `amount` with the account's opening balance without writing anything (the import
 * preview and the import's confirmation check). The refusals come from the rules of
 * setOpeningBalanceInTx: describeAccountOpening for a stored account, OPENING_ACCOUNT_RULE for a new one,
 * and OPENING_DATE_MISMATCH for an `asOfDate` that is not the cut-over date.
 */
export async function previewAccountOpening(
  db: Db,
  account: OpeningPreviewAccount,
  amount: Prisma.Decimal.Value,
  asOfDate: string | null = null,
): Promise<OpeningChangePreview> {
  const preview = await previewAccountAmount(db, account, amount);
  if (asOfDate !== null && preview.cutoverDate !== null && asOfDate !== preview.cutoverDate) {
    return { ...preview, allowed: false, reason: OPENING_DATE_MISMATCH };
  }
  return preview;
}

async function previewAccountAmount(db: Db, account: OpeningPreviewAccount, amount: Prisma.Decimal.Value): Promise<OpeningChangePreview> {
  const wanted = new Prisma.Decimal(amount);
  const firstAction: OpeningImportAction = wanted.isZero() ? 'unchanged' : 'post';
  let view: AccountOpeningView | null = null;
  let cutoverDate: string;
  try {
    if (account.id) view = await describeAccountOpening(db, account.id);
    cutoverDate = view ? view.cutoverDate : (await peekCutoverDate(db)).day;
  } catch (e) {
    if (e instanceof BusinessError && e.code === FISCAL_YEAR_MISSING) {
      return { allowed: false, reason: FISCAL_YEAR_MISSING, cutoverDate: null, recorded: null, action: firstAction, runningBalance: false };
    }
    throw e;
  }
  if (!view || !account.id) {
    const problem = postableAccountProblem({ ...account, id: '', isActive: true }, OPENING_ACCOUNT_RULE, null);
    return { allowed: problem === null, reason: problem?.code ?? null, cutoverDate, recorded: null, action: firstAction, runningBalance: false };
  }
  const recorded = view.amount === null ? null : new Prisma.Decimal(view.amount);
  const action: OpeningImportAction = (recorded ?? ZERO).eq(wanted) ? 'unchanged' : recorded === null ? 'post' : 'replace';
  let runningBalance = false;
  if (action !== 'unchanged') {
    const [agg, stored] = await Promise.all([
      db.accountingLedgerEntry.aggregate({ where: { accountId: account.id, isCancelled: false }, _sum: { debit: true, credit: true } }),
      db.account.findUnique({ where: { id: account.id }, select: { rootType: true } }),
    ]);
    runningBalance = signed(stored?.rootType ?? account.rootType, agg._sum.debit ?? ZERO, agg._sum.credit ?? ZERO).eq(wanted);
  }
  return { allowed: view.editable, reason: view.reason, cutoverDate, recorded: view.amount, action, runningBalance };
}

/** The keyed journal already holds exactly the wanted line: one journal, on the day, target + equity. */
function isSameJournal(keyed: readonly JournalWithItems[], day: string, accountId: string, equityId: string, rootType: string, delta: Decimal): boolean {
  if (keyed.length !== 1 || delta.isZero()) return false;
  const [j] = keyed;
  if (businessDayOf(j.date) !== day || j.items.length !== 2) return false;
  const line = j.items.find((i) => i.accountId === accountId);
  const other = j.items.find((i) => i.accountId === equityId);
  return !!line && !!other && !line.partyId && signed(rootType, line.debit, line.credit).eq(delta);
}

async function assertOpeningAccount(tx: Tx, accountId: string) {
  const account = await assertPostableAccount(tx, accountId, OPENING_ACCOUNT_RULE);
  const role = await tx.systemAccountMapping.findFirst({
    where: { accountId, role: { in: ['OPENING_EQUITY', 'CURRENT_PROFIT'] } },
    select: { role: true },
  });
  if (role) {
    const kindLabel = role.role === 'OPENING_EQUITY' ? 'Ekuitas Saldo Awal' : 'Laba Tahun Berjalan';
    throw new BusinessError(
      `Akun ${account.accountNumber} ${account.name} adalah akun ${kindLabel} dan tidak diberi saldo awal.`,
      OPENING_ACCOUNT_KIND,
    );
  }
  return account;
}

/**
 * Sets the opening balance of the target to `amount` at the cut-over date, in the caller's
 * transaction (see the header for the steps). Refuses a closed fiscal year (PERIOD_CLOSED) and a
 * locked month (PERIOD_LOCKED) unless `throughLock`, which is recorded in the audit trail.
 */
export async function setOpeningBalanceInTx(tx: Tx, input: SetOpeningInput): Promise<OpeningOutcome> {
  const accountId = accountIdOf(input.target);
  const amount = new Prisma.Decimal(input.amount);
  const { day } = await peekCutoverDate(tx);
  if (input.asOfDate !== undefined && input.asOfDate !== day) {
    throw new BusinessError(
      `Saldo awal dicatat per tanggal cut-over ${day}; tanggal ${input.asOfDate} tidak bisa dipakai. Isi saldo per tanggal cut-over.`,
      OPENING_DATE_MISMATCH,
    );
  }
  const account = await assertOpeningAccount(tx, accountId);
  const equity = await mappedAccount(tx, 'OPENING_EQUITY');
  const instant = openingJournalInstant(day);

  // The JV number (and its advisory lock) before the account rows, like every other JV writer.
  const fy = await fiscalYearOn(tx, instant);
  if (!fy) {
    throw new BusinessError(
      `Tahun buku untuk tanggal cut-over ${day} tidak ditemukan. Buat tahun buku untuk tanggal ini terlebih dahulu.`,
      FISCAL_YEAR_MISSING,
    );
  }
  const entryNumber = await generateDocumentNumber(tx, 'JV', instant, fy.id);
  await lockAccounts(tx, [accountId, equity.id]);

  const { keyed, legacy } = await findActiveOpeningJournals(tx, input.target);
  if (legacy.length > 0) {
    throw new BusinessError(
      `Akun ${account.accountNumber} masih memiliki jurnal saldo awal lama tanpa kunci (${legacy.map((j) => j.entryNumber).join(', ')}). Jalankan audit saldo awal; akuntan menentukan jurnal ini sebelum saldo awal diubah.`,
      OPENING_LEGACY_REVIEW,
    );
  }

  const base = await openingBase(tx, accountId, day, keyed.map((j) => j.id));
  const delta = amount.sub(base);
  if (isSameJournal(keyed, day, accountId, equity.id, account.rootType, delta)) {
    return { action: 'unchanged', asOfDate: day, amount, journal: keyed[0], cancelled: [] };
  }
  if (keyed.length === 0 && delta.isZero()) {
    return { action: 'unchanged', asOfDate: day, amount, journal: null, cancelled: [] };
  }

  const stored = await resolveCutoverDate(tx, input.userId);
  if (stored !== day) {
    throw new BusinessError(
      `Tanggal cut-over berubah menjadi ${stored} saat saldo awal diproses. Ulangi penyimpanan.`,
      OPENING_DATE_MISMATCH,
    );
  }
  const periodOptions: PeriodGuardOptions = { ignoreLock: !!input.throughLock };
  const cancelled = await cancelJournalsInTx(tx, keyed, {
    label: 'jurnal',
    trail: input.trail ?? cancelTrail(input.userId, REPLACED_REASON),
    periodOptions,
  });

  let journal: JournalWithItems | null = null;
  if (!delta.isZero()) {
    const abs = delta.abs().toFixed(2);
    const targetDebit = debitNormal(account.rootType) === delta.isPositive();
    const description = `Saldo awal akun: ${account.accountNumber} - ${account.name}`;
    ({ journal } = await postJournal(tx, {
      date: instant,
      narration: description,
      lines: [
        { accountId, debit: targetDebit ? abs : null, credit: targetDebit ? null : abs, description },
        { accountId: equity.id, debit: targetDebit ? null : abs, credit: targetDebit ? abs : null, description },
      ],
      sourceType: 'OPENING',
      sourceKey: sourceKeys.openingAccount(accountId),
      createdBy: input.userId,
      entryNumber,
      accountRule: DOCUMENT_RULE,
      lineRules: new Map([[accountId, OPENING_ACCOUNT_RULE]]),
      partyRule: 'strict',
      partyEffect: 'none',
      expectFiscalYearId: fy.id,
      periodOptions,
    }));
  }

  if (input.throughLock) {
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: OPENING_THROUGH_LOCK_ACTION,
        entityType: 'Account',
        entityId: accountId,
        newValues: { reason: input.throughLock.reason, asOfDate: day, amount: amount.toFixed(2), journalNumber: journal?.entryNumber ?? null, cancelled },
      },
    });
  }

  const action = journal ? (cancelled.length > 0 ? 'replaced' : 'posted') : 'cancelled';
  return { action, asOfDate: day, amount, journal, cancelled };
}
