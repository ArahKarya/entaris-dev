import { Prisma, type RootType } from '@prisma/client';
import Decimal from 'decimal.js';
import { logger } from '../lib/logger';
import { manualPartyAdjustments } from '../services/ledger/partyAdjustments';
import { loadPartySides, writePartySides } from '../services/ledger/partySides';
import { PARTY_ROLE_AMBIGUOUS, type PartyRole } from '../services/ledger/partyRules';
import { BusinessError } from './errors';

/**
 * Returns the correct balance impact for a given account root type.
 *
 * Normal balance sides:
 *   ASSET, EXPENSE  → debit-normal  (debit increases, credit decreases)
 *   LIABILITY, EQUITY, REVENUE → credit-normal (credit increases, debit decreases)
 */
export function computeImpact(rootType: string, debit: number | Decimal, credit: number | Decimal): number {
  const d = new Decimal(debit.toString());
  const c = new Decimal(credit.toString());
  if (rootType === 'ASSET' || rootType === 'EXPENSE') {
    return d.minus(c).toNumber();
  }
  return c.minus(d).toNumber();
}

/** computeImpact in Decimal: debit − credit for ASSET/EXPENSE, credit − debit otherwise. */
export function computeImpactDecimal(
  rootType: string,
  debit: Prisma.Decimal.Value,
  credit: Prisma.Decimal.Value,
): Prisma.Decimal {
  const d = new Prisma.Decimal(debit);
  const c = new Prisma.Decimal(credit);
  return rootType === 'ASSET' || rootType === 'EXPENSE' ? d.minus(c) : c.minus(d);
}

export interface AccountImpactLine {
  accountId: string;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
}

/**
 * Applies the balance impact of journal lines: netted per account in Decimal, one UPDATE per
 * account, in accountId order so concurrent postings take the account row locks in the same order.
 * `rootTypes` (account id -> root type) saves the lookup when the caller already read the accounts;
 * missing ones are loaded. An unknown account is skipped with a warning, like updateAccountBalance.
 */
export async function applyAccountImpacts(
  tx: Prisma.TransactionClient,
  lines: readonly AccountImpactLine[],
  rootTypes: ReadonlyMap<string, RootType | string> = new Map(),
): Promise<void> {
  const totals = new Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>();
  for (const l of lines) {
    const t = totals.get(l.accountId) ?? { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
    totals.set(l.accountId, { debit: t.debit.plus(l.debit), credit: t.credit.plus(l.credit) });
  }
  const ids = [...totals.keys()].sort();
  const missing = ids.filter((id) => !rootTypes.has(id));
  const loaded = missing.length > 0
    ? await tx.account.findMany({ where: { id: { in: missing } }, select: { id: true, rootType: true } })
    : [];
  const rootOf = new Map<string, string>([...rootTypes, ...loaded.map((a) => [a.id, a.rootType] as const)]);
  for (const id of ids) {
    const rootType = rootOf.get(id);
    if (!rootType) {
      logger.warn({ accountId: id }, 'applyAccountImpacts: account not found, balance not updated');
      continue;
    }
    const t = totals.get(id)!;
    const impact = computeImpactDecimal(rootType, t.debit, t.credit);
    if (impact.isZero()) continue;
    await tx.account.update({ where: { id }, data: { balance: { increment: impact } } });
  }
}

/**
 * Update a single account's balance with correct direction logic.
 */
export async function updateAccountBalance(
  tx: Prisma.TransactionClient,
  accountId: string,
  debit: number | Decimal,
  credit: number | Decimal
): Promise<void> {
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { rootType: true },
  });
  if (!account) return;

  const impact = computeImpact(account.rootType, debit, credit);
  await tx.account.update({
    where: { id: accountId },
    data: { balance: { increment: impact } },
  });
}

/**
 * Batch update balances for multiple journal items.
 */
export async function updateBalancesForItems(
  tx: Prisma.TransactionClient,
  items: Array<{ accountId: string; debit: number | Decimal; credit: number | Decimal }>
): Promise<void> {
  for (const item of items) {
    await updateAccountBalance(tx, item.accountId, item.debit, item.credit);
  }
}

/**
 * Recalculate account balances from the active ledger rows of every year (the one stored-balance
 * rule, services/ledger/storedBalances.ts): locks the accounts, writes only those that differ.
 * No ids, or an empty list, recalculates ALL accounts.
 */
export { recalculateAccountBalances } from '../services/ledger/storedBalances';

/**
 * Recalculate the balance of revenue/expense accounts from the ledger rows of OPEN fiscal years
 * only. Closing a year subtracts that year's contribution from accounts.balance (the ledger rows
 * stay), so recalculateAccountBalances, which sums every year, would put closed years back.
 * Balance-sheet accounts among `accountIds` get the whole-history sum as usual.
 */
export async function recalculatePnlAccountBalances(
  tx: Prisma.TransactionClient,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const accounts = await tx.account.findMany({
    where: { id: { in: [...accountIds] } },
    select: { id: true, rootType: true },
  });
  const sums = await tx.accountingLedgerEntry.groupBy({
    by: ['accountId', 'fiscalYearId'],
    where: { accountId: { in: [...accountIds] }, isCancelled: false },
    _sum: { debit: true, credit: true },
  });
  const years = await tx.fiscalYear.findMany({
    where: { id: { in: [...new Set(sums.map((r) => r.fiscalYearId))] } },
    select: { id: true, isClosed: true },
  });
  const closed = new Set(years.filter((y) => y.isClosed).map((y) => y.id));

  for (const account of accounts) {
    const pnl = account.rootType === 'REVENUE' || account.rootType === 'EXPENSE';
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const row of sums) {
      if (row.accountId !== account.id || (pnl && closed.has(row.fiscalYearId))) continue;
      debit = debit.plus((row._sum.debit ?? 0).toString());
      credit = credit.plus((row._sum.credit ?? 0).toString());
    }
    const balance = account.rootType === 'ASSET' || account.rootType === 'EXPENSE' ? debit.minus(credit) : credit.minus(debit);
    await tx.account.update({ where: { id: account.id }, data: { balance: balance.toFixed(2) } });
  }
}

/**
 * The party's manual adjustment on the role's accounts. When an account of the role also holds
 * another party role (PARTY_ROLE_AMBIGUOUS) the adjustment cannot be told apart, so it is left out
 * and logged: the documents still post, as they did before the adjustment existed, and the mapping
 * is refused where a journal line actually touches that account (postJournal).
 */
async function partyAdjustmentOrNone(
  tx: Prisma.TransactionClient,
  role: PartyRole,
  partyIds?: readonly string[],
): Promise<Map<string, Prisma.Decimal> | undefined> {
  try {
    return await manualPartyAdjustments(tx, role, partyIds);
  } catch (err) {
    if (!(err instanceof BusinessError) || err.code !== PARTY_ROLE_AMBIGUOUS) throw err;
    logger.error({ partyIds, role, err: err.message }, 'recalcPartyOutstanding: party role mapping is ambiguous, manual adjustment left out');
    return undefined;
  }
}

/**
 * Recalculate a party's receivable_outstanding, payable_outstanding and outstanding_amount (their
 * sum) from its opening amounts, the outstanding of its invoices (not Draft or Cancelled) and its
 * manual party adjustment (services/ledger/partyAdjustments.ts: hand-made journal lines with this
 * party on the receivable or payable accounts), per side as services/ledger/partySides.ts
 * computePartySides defines it. Written as Decimal, only when a column changes.
 * This is the source-of-truth approach that prevents drift from increment/decrement logic.
 */
export async function recalcPartyOutstanding(
  tx: Prisma.TransactionClient,
  partyId: string
): Promise<void> {
  const figures = (await loadPartySides(tx, [partyId], {
    adjustments: (role, ids) => partyAdjustmentOrNone(tx, role, ids),
  })).get(partyId);
  if (!figures) return;

  const old = new Decimal(figures.party.outstandingAmount.toString());
  if (!old.eq(figures.sides.outstanding.toString())) {
    logger.info(
      { partyId, old: old.toNumber(), new: figures.sides.outstanding.toNumber() },
      'recalcPartyOutstanding: correcting drift'
    );
  }
  await writePartySides(tx, figures);
}
