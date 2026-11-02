// The one definition of a "manual party adjustment" (E2-R4, plan §2.8): what hand-made journals
// moved on a party's subledger account outside any document. A receivable or payable built from
// documents alone loses these, so the party recalculation and the subledger checks add them from
// here and nowhere else.
//
// Source: active ledger rows (not journal items, which have drifted from the ledger, see
// utils/accountBalance.ts recalculateAccountBalances) of a Submitted journal whose source type is
// MANUAL, IMPORT or RECURRING, carrying a party, on the role's accounts including the ones the role
// held before a remap (roleAccountIds includeFormer). The cash book, documents and journals without
// a source type (legacy rows the E1 backfill has not classified) are not adjustments.

import { Prisma, type JournalSourceType } from '@prisma/client';
import { roleAccountIds, type PartyRole } from './partyRules';

type Tx = Prisma.TransactionClient;

/** Journal sources whose party lines adjust a subledger without a document. */
export const MANUAL_ADJUSTMENT_SOURCES = ['MANUAL', 'IMPORT', 'RECURRING'] as const satisfies readonly JournalSourceType[];

/** debit = debit − credit (debit-normal account); credit = credit − debit. */
export type AdjustmentSign = 'debit' | 'credit';

/** The normal side of each party role: receivable and supplier deposit are assets, the others liabilities. */
export const ADJUSTMENT_SIGN: Readonly<Record<PartyRole, AdjustmentSign>> = {
  AR: 'debit',
  VENDOR_DEPOSIT: 'debit',
  AP: 'credit',
  CUSTOMER_DEPOSIT: 'credit',
};

// Constants, never user input; inlined so they compare against the enum columns without a cast.
const SOURCES_SQL = Prisma.raw(MANUAL_ADJUSTMENT_SOURCES.map((s) => `'${s}'`).join(', '));

/**
 * `SELECT party_id, amount` per party: the manual adjustment on `accountIds`, signed by `sign`.
 * `partyIds` narrows it to those parties. With no account (role not mapped) or an empty party list
 * it yields no rows, so it can always be joined.
 */
export function manualPartyAdjustmentSql(
  accountIds: readonly string[],
  sign: AdjustmentSign,
  partyIds?: readonly string[],
): Prisma.Sql {
  if (accountIds.length === 0 || partyIds?.length === 0) {
    return Prisma.sql`SELECT NULL::text AS party_id, 0::numeric AS amount WHERE false`;
  }
  const amount = sign === 'debit' ? Prisma.sql`ale.debit - ale.credit` : Prisma.sql`ale.credit - ale.debit`;
  const parties = partyIds ? Prisma.sql`AND ale.party_id IN (${Prisma.join(partyIds)})` : Prisma.empty;
  return Prisma.sql`
    SELECT ale.party_id, SUM(${amount}) AS amount
      FROM accounting_ledger_entries ale
      JOIN journal_entries je ON je.id = ale.reference_id
     WHERE ale.is_cancelled = false
       AND ale.reference_type = 'JournalEntry'
       AND je.status = 'Submitted'
       AND je.source_type IN (${SOURCES_SQL})
       AND ale.party_id IS NOT NULL
       AND ale.account_id IN (${Prisma.join(accountIds)})
       ${parties}
     GROUP BY ale.party_id`;
}

/** Party id -> manual adjustment on the role's accounts (current and former), signed by the role's normal side. */
export async function manualPartyAdjustments(
  tx: Tx,
  role: PartyRole,
  partyIds?: readonly string[],
): Promise<Map<string, Prisma.Decimal>> {
  const accountIds = await roleAccountIds(tx, role, { includeFormer: true });
  const rows = await tx.$queryRaw<{ party_id: string; amount: string }[]>`
    SELECT a.party_id, a.amount::text AS amount FROM (${manualPartyAdjustmentSql(accountIds, ADJUSTMENT_SIGN[role], partyIds)}) a`;
  return new Map(rows.map((r) => [r.party_id, new Prisma.Decimal(r.amount)]));
}
