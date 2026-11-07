// Current-fiscal-year profit and loss balances for the chart of accounts page (E2-R15a). The COA
// "Saldo" column of a revenue or expense account shows what the ledger holds for the fiscal year of
// today, not accounts.balance (all-time, and it still carries closed years). Read only; it never
// touches a stored balance, so it is safe before the stored-balance rule changes.
import { Prisma, type FiscalYear, type RootType } from '@prisma/client';
import { computeImpactDecimal } from '../../utils/accountBalance';
import { startOfBusinessDay } from '../../utils/businessDate';
import { fiscalYearOn } from '../../utils/periodGuard';

type Tx = Prisma.TransactionClient;

const PNL_ROOTS: RootType[] = ['REVENUE', 'EXPENSE'];

export interface PnlBalance {
  accountId: string;
  rootType: RootType;
  /** In the account's normal direction: revenue credit - debit, expense debit - credit. */
  amount: Prisma.Decimal;
}

/** Fiscal year (open or closed) holding business day `day` (YYYY-MM-DD), or null when none does. */
export function currentPnlYear(db: Tx, day: string): Promise<FiscalYear | null> {
  return fiscalYearOn(db, startOfBusinessDay(day));
}

/**
 * Profit and loss balances of one fiscal year from active ledger rows, one entry per account that
 * has any. Close journals post only to equity accounts (CURRENT_PROFIT, RETAINED_EARNINGS), so a
 * closed year needs no exclusion.
 */
export async function pnlPeriodBalances(db: Tx, fiscalYearId: string): Promise<PnlBalance[]> {
  const rows = await db.accountingLedgerEntry.groupBy({
    by: ['accountId'],
    where: { fiscalYearId, isCancelled: false, account: { rootType: { in: PNL_ROOTS } } },
    _sum: { debit: true, credit: true },
  });
  if (rows.length === 0) return [];
  const accounts = await db.account.findMany({
    where: { id: { in: rows.map((r) => r.accountId) } },
    select: { id: true, rootType: true },
  });
  const rootOf = new Map(accounts.map((a) => [a.id, a.rootType]));
  const out: PnlBalance[] = [];
  for (const r of rows) {
    const rootType = rootOf.get(r.accountId);
    if (!rootType) continue;
    out.push({ accountId: r.accountId, rootType, amount: computeImpactDecimal(rootType, r._sum.debit ?? 0, r._sum.credit ?? 0) });
  }
  return out;
}

/** Profit of the year: revenue minus expense (the CURRENT_PROFIT composite of the balance sheet). */
export function currentProfit(balances: readonly PnlBalance[]): Prisma.Decimal {
  return balances.reduce(
    (sum, b) => (b.rootType === 'REVENUE' ? sum.add(b.amount) : sum.sub(b.amount)),
    new Prisma.Decimal(0),
  );
}
