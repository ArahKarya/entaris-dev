// Party targets of the one opening balance service (E2-R11/R12/R13, plan step 5 §2.4, PR-5.11).
// setOpeningBalanceInTx (openingBalance.ts) hands a PARTY target here; nothing else calls these.
//
// The amount is the party's receivable, payable or deposit outside the invoices in the app, at the
// cut-over date (owner decision #3), never below zero. Lines (sourceKey OPENING:PARTY:<id>:<kind>):
//   AR   Dr AR (party)               / Cr opening equity
//   AP   Dr opening equity           / Cr AP (party)
//   VDEP Dr vendor deposit (party)   / Cr opening equity, owned by a new VendorDeposit payment
//   CDEP Dr opening equity           / Cr customer deposit (party), owned by a new CustomerDeposit payment
// AR/AP move the side's opening column through adjustPartyOpening (the one writer, partySides.ts);
// deposits raise the party's deposit balance, like any deposit.
//
// Replacing: AR/AP void this service's keyed journals (cancelJournalsInTx). A deposit opening is a
// payment, so it is replaced only through cancelDepositPaymentInTx (services/depositCancel.ts), never
// by voiding its journal alone. That includes the unkeyed opening deposits of the deposit screen and
// of the old party import: their amount is the deposit itself (not a delta against a running
// balance, the reason unkeyed account openings are refused), so cancelling the payment and posting
// one on the cut-over date loses nothing. An opening deposit is found by its journal (linked, or
// unlinked by the deposit cancel's own rule for deposits posted before the payment-to-journal link)
// and, for the old deposit screen, by its counter account (opening equity) when it has no journal on
// the party line at all. Every other unkeyed opening journal of the party side
// refuses (OPENING_LEGACY_REVIEW), as do opening columns this service did not write (undirected or
// without a keyed journal), until the party opening audit (PR-5.13) settles them.
import { Prisma, type Payment, type PartyType, type PrismaClient } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { businessDayOf } from '../../utils/businessDate';
import { FISCAL_YEAR_MISSING, fiscalYearOn, type PeriodGuardOptions } from '../../utils/periodGuard';
import { cancelTrail } from '../../utils/cancelClaim';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import { mappedAccount } from '../systemAccounts';
import { lockAccounts } from '../coa/accountStructure';
import { cancelDepositPaymentInTx, type DepositSide } from '../depositCancel';
import { findUnlinkedDepositJournal } from '../depositCancelGuard';
import { DOCUMENT_RULE } from './accountGuard';
import { cancelJournalsInTx, type JournalWithItems } from './cancelJournals';
import { sourceKeys, type OpeningPartyKind } from './journalSource';
import { PARTY_NOT_FOUND, PARTY_TYPE_MISMATCH, roleAccountIds } from './partyRules';
import { adjustPartyOpening, legacyUnassignedOf, type PartySide } from './partySides';
import { postJournal } from './postJournal';
import {
  OPENING_DATE_MISMATCH, OPENING_IN_USE, OPENING_LEGACY_REVIEW, OPENING_NEGATIVE, OPENING_PARTY_HAS_HISTORY,
  OPENING_REPLACED_REASON, OPENING_THROUGH_LOCK_ACTION, isLegacyOpening, openingJournalInstant, peekCutoverDate, resolveCutoverDate,
  type OpeningDepositDetails, type OpeningOutcome, type SetOpeningInput,
} from './openingBalance';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;
type Decimal = Prisma.Decimal;

const ZERO = new Prisma.Decimal(0);

interface KindConfig {
  role: 'AR' | 'AP' | 'VENDOR_DEPOSIT' | 'CUSTOMER_DEPOSIT';
  partyTypes: readonly PartyType[];
  /** The party line is the debit (AR, vendor deposit) or the credit (AP, customer deposit). */
  partyDebit: boolean;
  /** Narration label after "Saldo awal ". */
  label: string;
  /** Side of the opening column (AR/AP), or the deposit kind. */
  side?: PartySide;
  deposit?: { side: DepositSide; paymentType: 'VendorDeposit' | 'CustomerDeposit' };
}

const KINDS: Readonly<Record<OpeningPartyKind, KindConfig>> = {
  AR: { role: 'AR', partyTypes: ['Customer', 'Both'], partyDebit: true, label: 'piutang', side: 'RECEIVABLE' },
  AP: { role: 'AP', partyTypes: ['Supplier', 'Both'], partyDebit: false, label: 'hutang', side: 'PAYABLE' },
  VDEP: { role: 'VENDOR_DEPOSIT', partyTypes: ['Supplier', 'Both'], partyDebit: true, label: 'uang muka Supplier', deposit: { side: 'VENDOR', paymentType: 'VendorDeposit' } },
  CDEP: { role: 'CUSTOMER_DEPOSIT', partyTypes: ['Customer', 'Both'], partyDebit: false, label: 'uang muka Customer', deposit: { side: 'CUSTOMER', paymentType: 'CustomerDeposit' } },
};

/** The party line's amount on its normal side (debit for AR and vendor deposit, credit otherwise). */
const partyAmount = (cfg: KindConfig, debit: Prisma.Decimal.Value, credit: Prisma.Decimal.Value): Decimal =>
  cfg.partyDebit ? new Prisma.Decimal(debit).sub(credit) : new Prisma.Decimal(credit).sub(debit);

/** An opening deposit: the payment and the journal it owns; `keyed` when the journal carries this service's key. */
export interface OpeningDepositPayment {
  payment: Payment;
  /** Null for a legacy deposit of the old deposit screen that never had a journal. */
  journal: JournalWithItems | null;
  keyed: boolean;
}

export interface PartyOpeningJournals {
  keyed: JournalWithItems[];
  legacy: JournalWithItems[];
  /** Deposit kinds only: the active opening deposit payments, replaced only by cancelling the payment. */
  deposits: OpeningDepositPayment[];
}

/**
 * Active opening journals on the party's lines of the side's role accounts (former role accounts
 * included). A journal owned by an active deposit payment of the kind is an opening deposit
 * (`deposits`), keyed or not; the rest is `keyed` (this service's key) or `legacy`. Deposit kinds
 * also list the party's active deposits of the old deposit screen (counter account opening equity)
 * whose journal is not among these, journal-less ones included.
 */
export async function findActivePartyOpeningJournals(db: Db, partyId: string, kind: OpeningPartyKind): Promise<PartyOpeningJournals> {
  const cfg = KINDS[kind];
  const key = sourceKeys.openingParty(partyId, kind);
  const accountIds = await roleAccountIds(db as Tx, cfg.role, { includeFormer: true });
  const rows = await db.journalEntry.findMany({
    where: {
      status: { not: 'Cancelled' },
      items: { some: { partyId, accountId: { in: accountIds } } },
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
  const openings = rows.filter((j) => j.sourceKey === key || isLegacyOpening(j));
  if (!cfg.deposit) {
    return { keyed: openings.filter((j) => j.sourceKey === key), legacy: openings.filter((j) => j.sourceKey !== key), deposits: [] };
  }
  const ownerOf = await openingDepositOwners(db, partyId, cfg.deposit.paymentType, openings);
  const free = openings.filter((j) => !ownerOf.has(j.id));
  const deposits: OpeningDepositPayment[] = openings.flatMap((j) => {
    const payment = ownerOf.get(j.id);
    return payment ? [{ payment, journal: j, keyed: j.sourceKey === key }] : [];
  });
  deposits.push(...(await screenOpeningDeposits(db, partyId, cfg.deposit.paymentType, [...ownerOf.values()])));
  return { keyed: free.filter((j) => j.sourceKey === key), legacy: free.filter((j) => j.sourceKey !== key), deposits };
}

type DepositPaymentType = NonNullable<KindConfig['deposit']>['paymentType'];

/**
 * Journal id -> the active deposit payment of the type that owns it: linked by journalEntryId, or,
 * for deposits posted before that link, the payment whose own journal the deposit cancel finds
 * (findUnlinkedDepositJournal: `JV-<paymentNumber>` or the ledger description), so replacing goes
 * through the payment like any other opening deposit.
 */
async function openingDepositOwners(db: Db, partyId: string, paymentType: DepositPaymentType, openings: readonly JournalWithItems[]): Promise<Map<string, Payment>> {
  const ownerOf = new Map<string, Payment>();
  if (openings.length === 0) return ownerOf;
  const active = { paymentType, status: { not: 'Cancelled' as const } };
  const linked = await db.payment.findMany({ where: { ...active, journalEntryId: { in: openings.map((j) => j.id) } } });
  for (const p of linked) ownerOf.set(p.journalEntryId!, p);
  const unowned = openings.filter((j) => !ownerOf.has(j.id));
  const numberOf = (text: string | null | undefined) => text?.match(/: (\S+)$/)?.[1];
  const candidates = [...new Set(unowned.flatMap((j) => [
    j.entryNumber.startsWith('JV-') ? j.entryNumber.slice(3) : undefined,
    ...j.items.map((i) => numberOf(i.description)),
  ]).filter((n): n is string => !!n))];
  if (candidates.length === 0) return ownerOf;
  const unlinked = await db.payment.findMany({ where: { ...active, partyId, journalEntryId: null, paymentNumber: { in: candidates } } });
  for (const p of unlinked) {
    const own = await findUnlinkedDepositJournal(db as Tx, { id: p.id, paymentNumber: p.paymentNumber, partyId, paymentType });
    if (own && unowned.some((j) => j.id === own.id) && !ownerOf.has(own.id)) ownerOf.set(own.id, p);
  }
  return ownerOf;
}

/**
 * Active deposits of the old deposit screen's opening branch (counter account opening equity, the
 * mark it left on the payment) not among `owned`: without a journal, or with one that has no opening
 * line on the party. They are the party's opening deposit as well (owner decision #3: replaced, never
 * added to). A cash deposit never has opening equity as its account.
 */
async function screenOpeningDeposits(db: Db, partyId: string, paymentType: DepositPaymentType, owned: readonly Payment[]): Promise<OpeningDepositPayment[]> {
  const equity = await mappedAccount(db as Tx, 'OPENING_EQUITY');
  const rows = await db.payment.findMany({
    where: { partyId, paymentType, status: { not: 'Cancelled' }, accountId: equity.id, id: { notIn: owned.map((p) => p.id) } },
    include: { journalEntry: { include: { items: true } } },
    orderBy: { paymentNumber: 'asc' },
  });
  const out: OpeningDepositPayment[] = [];
  for (const { journalEntry, ...payment } of rows) {
    const journal = journalEntry ?? (await findUnlinkedDepositJournal(db as Tx, { id: payment.id, paymentNumber: payment.paymentNumber, partyId, paymentType }));
    out.push({ payment, journal: journal && journal.status !== 'Cancelled' ? journal : null, keyed: false });
  }
  return out;
}

/** Sum of the party lines of `journals` on the side's role accounts, normal side. */
function journalSum(cfg: KindConfig, journals: readonly JournalWithItems[], partyId: string, accountIds: ReadonlySet<string>): Decimal {
  return journals
    .flatMap((j) => j.items.filter((i) => i.partyId === partyId && accountIds.has(i.accountId)))
    .reduce((sum, i) => sum.add(partyAmount(cfg, i.debit, i.credit)), ZERO);
}

/** The opening this service recorded for a party side (keyed journals or keyed opening deposits), or null. */
export async function recordedPartyOpening(db: Db, partyId: string, kind: OpeningPartyKind): Promise<Decimal | null> {
  const cfg = KINDS[kind];
  const found = await findActivePartyOpeningJournals(db, partyId, kind);
  const keyedJournals = found.deposits.flatMap((d) => (d.keyed && d.journal ? [d.journal] : []));
  if (found.keyed.length === 0 && keyedJournals.length === 0) return null;
  const accountIds = new Set(await roleAccountIds(db as Tx, cfg.role, { includeFormer: true }));
  return journalSum(cfg, [...found.keyed, ...keyedJournals], partyId, accountIds);
}

/**
 * Every active opening journal of a party side, keyed or not (deposit openings included), and the
 * party lines' total on the side's role accounts: what the party opening audit (PR-5.13) compares.
 */
export async function partyOpeningJournalTotal(db: Db, partyId: string, kind: OpeningPartyKind): Promise<{ entryNumbers: string[]; amount: Decimal }> {
  const cfg = KINDS[kind];
  const found = await findActivePartyOpeningJournals(db, partyId, kind);
  const journals = [...found.keyed, ...found.legacy, ...found.deposits.flatMap((d) => (d.journal ? [d.journal] : []))];
  const accountIds = new Set(await roleAccountIds(db as Tx, cfg.role, { includeFormer: true }));
  return { entryNumbers: journals.map((j) => j.entryNumber), amount: journalSum(cfg, journals, partyId, accountIds) };
}

/** The one keyed journal already holds exactly the wanted lines: on the day, party line + opening equity. */
function isSameJournal(j: JournalWithItems, day: string, cfg: KindConfig, partyId: string, accountId: string, equityId: string, amount: Decimal): boolean {
  if (businessDayOf(j.date) !== day || j.items.length !== 2) return false;
  const line = j.items.find((i) => i.accountId === accountId && i.partyId === partyId);
  const other = j.items.find((i) => i.accountId === equityId && !i.partyId);
  return !!line && !!other && partyAmount(cfg, line.debit, line.credit).eq(amount);
}

const kindLabel = (kind: OpeningPartyKind): string => KINDS[kind].label;

async function assertNoHistory(tx: Tx, partyId: string, partyName: string, accountIds: readonly string[], instant: Date, kind: OpeningPartyKind, day: string) {
  const before = await tx.accountingLedgerEntry.findFirst({
    where: { partyId, accountId: { in: [...accountIds] }, isCancelled: false, date: { lt: instant } },
    select: { id: true },
  });
  if (before) {
    throw new BusinessError(
      `Mitra ${partyName} sudah punya mutasi ${kindLabel(kind)} sebelum tanggal cut-over ${day}. Saldo awal pihak hanya untuk ${kindLabel(kind)} di luar Invoice aplikasi per tanggal cut-over; koreksi lewat jurnal manual.`,
      OPENING_PARTY_HAS_HISTORY,
    );
  }
}

function legacyReview(partyName: string, kind: OpeningPartyKind, detail: string): BusinessError {
  return new BusinessError(
    `Saldo awal ${kindLabel(kind)} mitra ${partyName} masih memiliki ${detail}. Jalankan audit saldo awal; akuntan menentukannya sebelum saldo awal diubah.`,
    OPENING_LEGACY_REVIEW,
  );
}

const undirectedReview = (partyName: string, kind: OpeningPartyKind, undirected: Decimal): BusinessError =>
  legacyReview(partyName, kind, `saldo awal ${undirected.toFixed(2)} yang belum diarahkan ke piutang atau hutang`);

function inUse(partyName: string, kind: OpeningPartyKind): BusinessError {
  return new BusinessError(
    `Saldo awal ${kindLabel(kind)} mitra ${partyName} sudah terpakai pembayaran atau penggunaan uang muka, jadi tidak bisa diganti. Koreksi lewat jurnal manual.`,
    OPENING_IN_USE,
  );
}

/** The payment fields of an opening deposit: what the user typed, the generated description as default notes. */
function depositFields(details: OpeningDepositDetails | undefined, description: string) {
  return {
    referenceNo: details?.referenceNo || null,
    notes: details?.notes || description,
    salesOrderId: details?.salesOrderId ?? null,
    proformaInvoiceId: details?.proformaInvoiceId ?? null,
  };
}

const sameDetails = (p: Payment, want: ReturnType<typeof depositFields>): boolean =>
  (p.referenceNo ?? null) === want.referenceNo && (p.notes ?? null) === want.notes
  && (p.salesOrderId ?? null) === want.salesOrderId && (p.proformaInvoiceId ?? null) === want.proformaInvoiceId;

/** Party opening balance, in the caller's transaction (see the header). */
export async function setPartyOpeningInTx(tx: Tx, input: SetOpeningInput, partyId: string, kind: OpeningPartyKind): Promise<OpeningOutcome> {
  const cfg = KINDS[kind];
  const amount = new Prisma.Decimal(input.amount);
  if (amount.isNegative()) {
    throw new BusinessError('Saldo awal pihak tidak boleh negatif.', OPENING_NEGATIVE);
  }
  const { day } = await peekCutoverDate(tx);
  if (input.asOfDate !== undefined && input.asOfDate !== day) {
    throw new BusinessError(
      `Saldo awal dicatat per tanggal cut-over ${day}; tanggal ${input.asOfDate} tidak bisa dipakai. Isi saldo per tanggal cut-over.`,
      OPENING_DATE_MISMATCH,
    );
  }
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { id: true, name: true, partyType: true } });
  if (!party) throw new BusinessError('Data mitra tidak ditemukan.', PARTY_NOT_FOUND);
  if (!cfg.partyTypes.includes(party.partyType)) {
    throw new BusinessError(
      `Saldo awal ${kindLabel(kind)} tidak berlaku untuk mitra bertipe ${party.partyType}.`,
      PARTY_TYPE_MISMATCH,
    );
  }
  // One query at a time on the transaction connection.
  const target = await mappedAccount(tx, cfg.role);
  const equity = await mappedAccount(tx, 'OPENING_EQUITY');
  const roleIds = await roleAccountIds(tx, cfg.role, { includeFormer: true });
  const instant = openingJournalInstant(day);
  if (cfg.side) await assertNoHistory(tx, partyId, party.name, roleIds, instant, kind, day);

  const fy = await fiscalYearOn(tx, instant);
  if (!fy) {
    throw new BusinessError(
      `Tahun buku untuk tanggal cut-over ${day} tidak ditemukan. Buat tahun buku untuk tanggal ini terlebih dahulu.`,
      FISCAL_YEAR_MISSING,
    );
  }
  // The opening deposit payments first, then the numbers (advisory locks), the account rows and the
  // party row: the order of the deposit apply/refund routes (payment row, then the JV number) and
  // of every JV writer (number, then accounts).
  if (cfg.deposit) {
    const before = await findActivePartyOpeningJournals(tx, partyId, kind);
    const ids = before.deposits.map((d) => d.payment.id);
    if (ids.length > 0) await tx.$queryRaw`SELECT id FROM payments WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  }
  const paymentNumber = cfg.deposit ? await generateDocumentNumber(tx, 'PAY', instant, fy.id) : null;
  const entryNumber = await generateDocumentNumber(tx, 'JV', instant, fy.id);
  await lockAccounts(tx, [target.id, equity.id]);
  await tx.$queryRaw`SELECT id FROM parties WHERE id = ${partyId} FOR UPDATE`;

  const found = await findActivePartyOpeningJournals(tx, partyId, kind);
  if (found.legacy.length > 0) {
    throw legacyReview(party.name, kind, `jurnal saldo awal lama tanpa kunci (${found.legacy.map((j) => j.entryNumber).join(', ')})`);
  }
  const accountSet = new Set(roleIds);
  const periodOptions: PeriodGuardOptions = { ignoreLock: !!input.throughLock };
  const trail = input.trail ?? cancelTrail(input.userId, OPENING_REPLACED_REASON);

  let unchanged: JournalWithItems | null = null;
  let current = ZERO;
  if (cfg.side) {
    const columns = await tx.party.findUniqueOrThrow({
      where: { id: partyId },
      select: { openingOutstanding: true, openingReceivable: true, openingPayable: true },
    });
    current = new Prisma.Decimal(cfg.side === 'RECEIVABLE' ? columns.openingReceivable : columns.openingPayable);
    const keyedSum = journalSum(cfg, found.keyed, partyId, accountSet);
    const undirected = legacyUnassignedOf(columns);
    // An undirected opening comes first: a keyed journal over it (keyed by the 5.6 audit) is not a
    // payment taking the opening, the party opening audit (PR-5.13) directs it.
    if (undirected.gt(0)) throw undirectedReview(party.name, kind, undirected);
    // A payment remainder took part of the opening (the side column, or opening_outstanding alone before PR-5.13).
    if (found.keyed.length > 0 && (current.lt(keyedSum) || undirected.isNegative())) throw inUse(party.name, kind);
    if (!current.eq(keyedSum)) throw legacyReview(party.name, kind, `saldo awal tercatat ${current.toFixed(2)} tanpa jurnal saldo awal berkunci yang sama`);
    if (!undirected.isZero()) throw undirectedReview(party.name, kind, undirected);
    if (found.keyed.length === 1 && isSameJournal(found.keyed[0], day, cfg, partyId, target.id, equity.id, amount)) unchanged = found.keyed[0];
    if (found.keyed.length === 0 && amount.isZero()) return { action: 'unchanged', asOfDate: day, amount, journal: null, cancelled: [], payment: null };
  } else {
    for (const d of found.deposits) {
      const used = await tx.payment.findUnique({
        where: { id: d.payment.id },
        select: {
          refundedAmount: true,
          customerDepositApplications: { where: { isCancelled: false }, select: { id: true } },
          depositApplications: { where: { isCancelled: false }, select: { id: true } },
        },
      });
      const fromReturn = await tx.salesReturn.findFirst({ where: { customerDepositId: d.payment.id }, select: { id: true } });
      if (fromReturn || (used && (used.refundedAmount.gt(0) || used.customerDepositApplications.length > 0 || used.depositApplications.length > 0))) {
        throw inUse(party.name, kind);
      }
    }
    const only = found.deposits.length === 1 && found.keyed.length === 0 ? found.deposits[0] : null;
    if (
      only?.keyed && only.journal && new Prisma.Decimal(only.payment.amount).eq(amount)
      && isSameJournal(only.journal, day, cfg, partyId, target.id, equity.id, amount)
      && sameDetails(only.payment, depositFields(input.deposit, `Saldo awal ${cfg.label}: ${party.name}`))
    ) {
      return { action: 'unchanged', asOfDate: day, amount, journal: only.journal, cancelled: [], payment: only.payment };
    }
    if (found.deposits.length === 0 && found.keyed.length === 0 && amount.isZero()) {
      return { action: 'unchanged', asOfDate: day, amount, journal: null, cancelled: [], payment: null };
    }
  }
  if (unchanged) return { action: 'unchanged', asOfDate: day, amount, journal: unchanged, cancelled: [], payment: null };

  const stored = await resolveCutoverDate(tx, input.userId);
  if (stored !== day) {
    throw new BusinessError(`Tanggal cut-over berubah menjadi ${stored} saat saldo awal diproses. Ulangi penyimpanan.`, OPENING_DATE_MISMATCH);
  }
  const cancelled: string[] = [];
  for (const d of found.deposits) {
    const done = await cancelDepositPaymentInTx(tx, d.payment.id, cfg.deposit!.side, trail, { periodOptions });
    if (done.journalNumber) cancelled.push(done.journalNumber);
  }
  cancelled.push(...(await cancelJournalsInTx(tx, found.keyed, { label: 'jurnal', trail, periodOptions })));

  let journal: JournalWithItems | null = null;
  let payment: Payment | null = null;
  if (!amount.isZero()) {
    const abs = amount.toFixed(2);
    const description = `Saldo awal ${cfg.label}: ${party.name}`;
    const partyLine = { accountId: target.id, partyId, debit: cfg.partyDebit ? abs : null, credit: cfg.partyDebit ? null : abs, description };
    const equityLine = { accountId: equity.id, debit: cfg.partyDebit ? null : abs, credit: cfg.partyDebit ? abs : null, description };
    if (cfg.deposit && paymentNumber) {
      payment = await tx.payment.create({
        data: {
          paymentNumber,
          date: instant,
          partyId,
          paymentType: cfg.deposit.paymentType,
          accountId: equity.id,
          amount: abs,
          status: 'Submitted',
          ...depositFields(input.deposit, description),
          fiscalYearId: fy.id,
          createdBy: input.userId,
          submittedAt: new Date(),
        },
      });
    }
    ({ journal } = await postJournal(tx, {
      date: instant,
      narration: description,
      lines: cfg.partyDebit ? [partyLine, equityLine] : [equityLine, partyLine],
      sourceType: 'OPENING',
      sourceKey: sourceKeys.openingParty(partyId, kind),
      createdBy: input.userId,
      entryNumber,
      accountRule: DOCUMENT_RULE,
      partyRule: 'strict',
      partyEffect: 'none',
      expectFiscalYearId: fy.id,
      periodOptions,
    }));
    if (payment) {
      payment = await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: journal.id } });
      await tx.party.update({
        where: { id: partyId },
        data: cfg.deposit!.side === 'CUSTOMER' ? { customerDepositBalance: { increment: abs } } : { depositBalance: { increment: abs } },
      });
    }
  }
  if (cfg.side) await adjustPartyOpening(tx, partyId, cfg.side, amount.sub(current));
  await recalcPartyOutstanding(tx, partyId);

  if (input.throughLock) {
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: OPENING_THROUGH_LOCK_ACTION,
        entityType: 'Party',
        entityId: partyId,
        newValues: { reason: input.throughLock.reason, subledger: kind, asOfDate: day, amount: amount.toFixed(2), journalNumber: journal?.entryNumber ?? null, cancelled },
      },
    });
  }
  const action = journal ? (cancelled.length > 0 ? 'replaced' : 'posted') : 'cancelled';
  return { action, asOfDate: day, amount, journal, cancelled, payment };
}
