import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { loadPartyRoleMap, type PartyRole } from '../services/ledger/partyRules';

type PartyImpactItem = {
  partyId: string | null;
  accountId: string;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
};

type DepositRole = Extract<PartyRole, 'CUSTOMER_DEPOSIT' | 'VENDOR_DEPOSIT'>;

/** Denormalized party field and normal side of each deposit role. */
const DEPOSIT_FIELD: Readonly<Record<DepositRole, { field: 'customerDepositBalance' | 'depositBalance'; debitNormal: boolean }>> = {
  CUSTOMER_DEPOSIT: { field: 'customerDepositBalance', debitNormal: false },
  VENDOR_DEPOSIT: { field: 'depositBalance', debitNormal: true },
};

const isDepositRole = (role: PartyRole | undefined): role is DepositRole => role === 'CUSTOMER_DEPOSIT' || role === 'VENDOR_DEPOSIT';

/**
 * Undo, on cancel from the Journal menu, what the deposit lines of an old manual or imported
 * journal did to the party's deposit balance when it was posted (before E2-R4 refused deposit
 * accounts in hand-made journals), by the line account's party role (loadPartyRoleMap, accounts
 * that held a role before a remap included):
 *
 *   CUSTOMER_DEPOSIT → customerDepositBalance   −(credit − debit)
 *   VENDOR_DEPOSIT   → depositBalance           −(debit − credit)
 *
 * Receivable and payable lines are left to recalcPartyOutstanding. A party on any other account
 * (an expense line from the old expense forms) moves nothing and is logged.
 */
export async function reverseManualDepositLines(
  tx: Prisma.TransactionClient,
  items: readonly PartyImpactItem[],
): Promise<void> {
  const tagged = items.filter((it) => it.partyId);
  if (tagged.length === 0) return;
  const roles = await loadPartyRoleMap(tx, tagged.map((it) => it.accountId));
  for (const it of tagged) {
    const role = roles.get(it.accountId);
    if (!role) {
      logger.warn({ partyId: it.partyId, accountId: it.accountId }, 'reverseManualDepositLines: party on a non-party account, skipped');
      continue;
    }
    if (!isDepositRole(role)) continue;

    const debit = new Prisma.Decimal(it.debit);
    const credit = new Prisma.Decimal(it.credit);
    const { field, debitNormal } = DEPOSIT_FIELD[role];
    const posted = debitNormal ? debit.minus(credit) : credit.minus(debit);
    if (posted.isZero()) continue;

    await tx.party.update({
      where: { id: it.partyId! },
      data: { [field]: { increment: posted.negated() } },
    });
  }
}
