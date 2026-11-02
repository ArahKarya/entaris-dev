// Cancelling a cash refund of a customer or supplier deposit (uang muka).
//
// A refund today is a journal, not a document: POST /customer-deposits/:id/refund and
// /vendor-deposits/:id/refund post one JV (sourceType DEPOSIT_REFUND), add the amount to the
// deposit payment's refundedAmount and take it off the party's deposit balance. Cancelling it voids
// that journal and gives both back. The Journal menu no longer does this; it rejects refund journals
// with JOURNAL_USE_DEPOSIT_REFUND_CANCEL. E5 turns refunds into Payment documents and reuses
// cancelDepositRefundInTx for their cancel.

import Decimal from 'decimal.js';
import { JournalSourceType, type Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { voidJournalInTx } from '../utils/journalCancel';
import { cancelTrail, STALE_STATUS } from '../utils/cancelClaim';
import { STALE_STATUS_ERROR } from './paymentRequestRules';
import { systemAccounts } from './systemAccounts';
import { depositRefundSourceKey } from './ledger/journalSource';

type Tx = Prisma.TransactionClient;

export type DepositSide = 'customer' | 'vendor';

/** Error code: the Journal menu does not cancel deposit refunds; the deposit page does. */
export const JOURNAL_USE_DEPOSIT_REFUND_CANCEL = 'JOURNAL_USE_DEPOSIT_REFUND_CANCEL';
/** Error code: the journal is not a refund of this deposit (or a legacy one that cannot be matched safely). */
export const DEPOSIT_REFUND_MISMATCH = 'DEPOSIT_REFUND_MISMATCH';
/** Error code: the refund is larger than the deposit's recorded refundedAmount. */
export const DEPOSIT_REFUND_OVER_CANCEL = 'DEPOSIT_REFUND_OVER_CANCEL';

export const DEPOSIT_REFUND_MENU_MESSAGE =
  'Jurnal ini adalah refund uang muka. Batalkan dari tombol "Batalkan refund" di menu Uang Muka Customer/Supplier.';

interface SideConfig {
  paymentType: 'CustomerDeposit' | 'VendorDeposit';
  /** System account role of the deposit line the refund writer posts. */
  depositRole: 'CUSTOMER_DEPOSIT' | 'VENDOR_DEPOSIT';
  /** Narration prefix the refund writer uses: `<prefix>: <paymentNumber> - <party name>`. */
  narrationPrefix: string;
  /** Side of the deposit-account line: a customer refund debits the liability, a supplier refund credits the asset. */
  depositLine: 'debit' | 'credit';
  notThisType: string;
}

const SIDES: Record<DepositSide, SideConfig> = {
  customer: {
    paymentType: 'CustomerDeposit',
    depositRole: 'CUSTOMER_DEPOSIT',
    narrationPrefix: 'Refund UM Pelanggan',
    depositLine: 'debit',
    notThisType: 'Bukan tipe uang muka customer.',
  },
  vendor: {
    paymentType: 'VendorDeposit',
    depositRole: 'VENDOR_DEPOSIT',
    narrationPrefix: 'Refund UM Vendor',
    depositLine: 'credit',
    notThisType: 'Bukan tipe uang muka supplier.',
  },
};

const REFUND_NARRATION = /^Refund UM (Vendor|Pelanggan):/;

// sourceKey of a refund journal (the deposit payment it refunds) lives with the other keys in
// ledger/journalSource; re-exported here for the existing callers.
export { depositRefundSourceKey };

/**
 * True for a deposit refund journal: tagged DEPOSIT_REFUND, or legacy and unclassified (no source
 * type) with a refund narration. A journal tagged anything else (e.g. MANUAL) is not a refund, even
 * with that narration, and follows the normal Journal-menu rules.
 */
export function isDepositRefundJournal(entry: { sourceType: JournalSourceType | null; narration: string | null }): boolean {
  if (entry.sourceType === JournalSourceType.DEPOSIT_REFUND) return true;
  return entry.sourceType === null && REFUND_NARRATION.test(entry.narration ?? '');
}

interface DepositRef {
  id: string;
  paymentNumber: string;
  partyId: string;
}

/** Narration start of a legacy refund of this deposit; the " - " stops PAY-1 matching PAY-10. */
function legacyNarrationStart(cfg: SideConfig, deposit: DepositRef): string {
  return `${cfg.narrationPrefix}: ${deposit.paymentNumber} - `;
}

/**
 * Refund journals of one deposit: tagged with its sourceKey, or legacy rows written before the
 * key existed (no key, DEPOSIT_REFUND or unclassified) whose narration names this deposit number.
 */
function refundJournalWhere(cfg: SideConfig, deposit: DepositRef): Prisma.JournalEntryWhereInput {
  return {
    OR: [
      { sourceType: JournalSourceType.DEPOSIT_REFUND, sourceKey: depositRefundSourceKey(deposit.id) },
      {
        sourceKey: null,
        OR: [{ sourceType: JournalSourceType.DEPOSIT_REFUND }, { sourceType: null }],
        narration: { startsWith: legacyNarrationStart(cfg, deposit) },
      },
    ],
  };
}

function isRefundOf(
  cfg: SideConfig,
  deposit: DepositRef,
  journal: { sourceType: JournalSourceType | null; sourceKey: string | null; narration: string | null },
): boolean {
  if (journal.sourceKey !== null) {
    return journal.sourceType === JournalSourceType.DEPOSIT_REFUND && journal.sourceKey === depositRefundSourceKey(deposit.id);
  }
  const legacyType = journal.sourceType === null || journal.sourceType === JournalSourceType.DEPOSIT_REFUND;
  return legacyType && (journal.narration ?? '').startsWith(legacyNarrationStart(cfg, deposit));
}

type JournalItemLike = { partyId: string | null; debit: Prisma.Decimal; credit: Prisma.Decimal };
type RefundJournalItem = JournalItemLike & { accountId: string; description: string | null; account: { accountNumber: string } };

interface LegacyCandidate {
  id: string;
  sourceKey: string | null;
  items: readonly RefundJournalItem[];
}

/**
 * Ids of the untagged candidates that are exactly what the refund writer posts: two lines with the
 * short description `<prefix>: <paymentNumber>` (POST /journals defaults it to the whole narration),
 * the party's line on the system deposit account on the refund side, the other line on a cash
 * account without party for the same amount, and no audit row of POST /journals. Anything else is a
 * hand-made journal that only shares the narration; it never moved refundedAmount, so cancelling it
 * here would lower refundedAmount below what was really refunded.
 */
async function legacyWriterShapeIds(db: Tx, cfg: SideConfig, deposit: DepositRef, journals: readonly LegacyCandidate[]): Promise<Set<string>> {
  const legacy = journals.filter((j) => j.sourceKey === null);
  if (legacy.length === 0) return new Set();
  const depositAccountIds = new Set(await systemAccounts.getAccountIds(cfg.depositRole));
  const description = `${cfg.narrationPrefix}: ${deposit.paymentNumber}`;
  const manual = await db.auditLog.findMany({
    where: { entityType: 'journals', action: 'CREATE', entityId: { in: legacy.map((j) => j.id) } },
    select: { entityId: true },
  });
  const manualIds = new Set(manual.map((a) => a.entityId));

  const ids = new Set<string>();
  for (const j of legacy) {
    if (manualIds.has(j.id) || j.items.length !== 2) continue;
    if (!j.items.every((i) => i.description === description)) continue;
    const depositLine = j.items.find((i) => i.partyId === deposit.partyId && depositAccountIds.has(i.accountId));
    const cashLine = j.items.find((i) => i !== depositLine);
    if (!depositLine || !cashLine || cashLine.partyId !== null) continue;
    const amount = refundLineAmount(cfg, deposit.partyId, [depositLine]);
    const cashSide = cfg.depositLine === 'debit' ? cashLine.credit : cashLine.debit;
    const cashOther = cfg.depositLine === 'debit' ? cashLine.debit : cashLine.credit;
    if (!amount || !amount.eq(cashSide.toString()) || !new Decimal(cashOther.toString()).isZero()) continue;
    if (!(await systemAccounts.isCashAccount(cashLine.account.accountNumber))) continue;
    ids.add(j.id);
  }
  return ids;
}

/**
 * The refunded amount: the one deposit-account line, which carries the deposit's party on the
 * refund side (the cash line has no party). Null when there is not exactly one such line.
 */
function refundLineAmount(cfg: SideConfig, partyId: string, items: readonly JournalItemLike[]): Decimal | null {
  const lines = items.filter((i) => {
    const amount = new Decimal((cfg.depositLine === 'debit' ? i.debit : i.credit).toString());
    const other = new Decimal((cfg.depositLine === 'debit' ? i.credit : i.debit).toString());
    return i.partyId === partyId && amount.gt(0) && other.isZero();
  });
  if (lines.length !== 1) return null;
  return new Decimal((cfg.depositLine === 'debit' ? lines[0].debit : lines[0].credit).toString());
}

export interface DepositRefundRow {
  journalEntryId: string;
  entryNumber: string;
  date: Date;
  amount: number;
  status: string;
  narration: string | null;
  cashAccount: { id: string; accountNumber: string; name: string } | null;
  cancelledAt: Date | null;
  cancelledById: string | null;
  cancelReason: string | null;
}

/**
 * Refund journals of a deposit, newest first, cancelled ones included. Untagged legacy rows are
 * listed only when they have the refund writer's exact shape. Null when the deposit is not found.
 */
export async function listDepositRefunds(
  db: Tx,
  side: DepositSide,
  depositId: string,
): Promise<DepositRefundRow[] | null> {
  const cfg = SIDES[side];
  const deposit = await db.payment.findUnique({
    where: { id: depositId },
    select: { id: true, paymentNumber: true, paymentType: true, partyId: true },
  });
  if (!deposit || deposit.paymentType !== cfg.paymentType) return null;

  const found = await db.journalEntry.findMany({
    where: refundJournalWhere(cfg, deposit),
    include: { items: { include: { account: { select: { id: true, accountNumber: true, name: true } } } } },
    orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
  });
  const legacyOk = await legacyWriterShapeIds(db, cfg, deposit, found);
  const journals = found.filter((j) => j.sourceKey !== null || legacyOk.has(j.id));
  return journals.map((j) => {
    const cash = j.items.find((i) => i.partyId !== deposit.partyId) ?? null;
    return {
      journalEntryId: j.id,
      entryNumber: j.entryNumber,
      date: j.date,
      amount: refundLineAmount(cfg, deposit.partyId, j.items)?.toNumber() ?? 0,
      status: j.status,
      narration: j.narration,
      cashAccount: cash?.account ?? null,
      cancelledAt: j.cancelledAt,
      cancelledById: j.cancelledById,
      cancelReason: j.cancelReason,
    };
  });
}

export interface CancelDepositRefundInput {
  side: DepositSide;
  depositId: string;
  journalEntryId: string;
  userId: string;
  reason?: string | null;
}

export interface CancelDepositRefundResult {
  journalEntryId: string;
  entryNumber: string;
  amount: number;
  refundedAmount: number;
}

/**
 * Cancel one refund of a deposit inside the caller's transaction: void its journal (ledger rows,
 * account balances, cancelledById/cancelReason), lower the deposit's refundedAmount by the refund
 * and give the amount back to the party's deposit balance.
 *
 * Rejects (BusinessError): a journal that is not a refund of this deposit or cannot be matched
 * safely, including an untagged journal without the refund writer's shape (DEPOSIT_REFUND_MISMATCH), an already cancelled refund (STALE_STATUS), a closed fiscal
 * year of the refund journal (PERIOD_CLOSED), and a refund larger than refundedAmount
 * (DEPOSIT_REFUND_OVER_CANCEL). The deposit row is locked first, so two cancels of refunds of one
 * deposit run one after the other.
 */
export async function cancelDepositRefundInTx(tx: Tx, input: CancelDepositRefundInput): Promise<CancelDepositRefundResult> {
  const cfg = SIDES[input.side];
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${input.depositId} FOR UPDATE`;
  const deposit = await tx.payment.findUnique({
    where: { id: input.depositId },
    select: { id: true, paymentNumber: true, paymentType: true, partyId: true, refundedAmount: true },
  });
  if (!deposit) throw new BusinessError('Uang muka tidak ditemukan.');
  if (deposit.paymentType !== cfg.paymentType) throw new BusinessError(cfg.notThisType);
  // A Cancelled deposit is allowed on purpose. Before assertDepositNotRefunded, a partly refunded
  // deposit could be cancelled: that reversed the whole deposit (account and party balance) while
  // its refund stayed posted, so both are off by the refund. Voiding the refund with the same
  // effects below (balances back, party balance +refund, refundedAmount -refund) is the correction.

  const journal = await tx.journalEntry.findUnique({
    where: { id: input.journalEntryId },
    include: { items: { include: { account: { select: { accountNumber: true } } } } },
  });
  if (!journal || !isRefundOf(cfg, deposit, journal)) {
    throw new BusinessError('Jurnal ini bukan refund dari uang muka tersebut.', DEPOSIT_REFUND_MISMATCH);
  }
  if (journal.status === 'Cancelled') throw new BusinessError(STALE_STATUS_ERROR, STALE_STATUS);
  if (journal.sourceKey === null && !(await legacyWriterShapeIds(tx, cfg, deposit, [journal])).has(journal.id)) {
    throw new BusinessError(
      'Jurnal lama ini memakai narasi refund uang muka tetapi bentuknya bukan jurnal refund dari modul Uang Muka (mungkin jurnal manual). Koreksi dengan jurnal manual.',
      DEPOSIT_REFUND_MISMATCH,
    );
  }

  const amount = refundLineAmount(cfg, deposit.partyId, journal.items);
  if (!amount) {
    throw new BusinessError(
      'Jurnal refund lama ini tidak bisa dicocokkan dengan aman ke uang muka (baris uang mukanya tidak jelas). Koreksi dengan jurnal manual.',
      DEPOSIT_REFUND_MISMATCH,
    );
  }
  const refunded = new Decimal(deposit.refundedAmount.toString());
  if (amount.gt(refunded)) {
    throw new BusinessError(
      `Refund ini Rp ${amount.toFixed(2)}, lebih besar dari total refund tercatat Rp ${refunded.toFixed(2)} pada uang muka ini. Koreksi dengan jurnal manual.`,
      DEPOSIT_REFUND_OVER_CANCEL,
    );
  }

  // Period check, then the conditional claim on the journal: the first write of the cancel.
  const voided = await voidJournalInTx(tx, journal, 'uang muka', cancelTrail(input.userId, input.reason));
  if (!voided) throw new BusinessError(STALE_STATUS_ERROR, STALE_STATUS);

  const amountNum = amount.toNumber();
  const updated = await tx.payment.update({
    where: { id: deposit.id },
    data: { refundedAmount: { decrement: amountNum } },
    select: { refundedAmount: true },
  });
  await tx.party.update({
    where: { id: deposit.partyId },
    data: input.side === 'customer'
      ? { customerDepositBalance: { increment: amountNum } }
      : { depositBalance: { increment: amountNum } },
  });

  return {
    journalEntryId: journal.id,
    entryNumber: journal.entryNumber,
    amount: amountNum,
    refundedAmount: Number(updated.refundedAmount),
  };
}
