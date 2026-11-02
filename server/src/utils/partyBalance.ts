import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { loadPartyRoleMap, type PartyRole } from '../services/ledger/partyRules';

type PartyImpactItem = {
  partyId: string | null;
  accountId: string;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
};

type PartyField = 'customerDepositBalance' | 'depositBalance' | 'outstandingAmount';

/** Denormalized party field and normal side of each party role. */
const ROLE_FIELD: Readonly<Record<PartyRole, { field: PartyField; debitNormal: boolean }>> = {
  AR: { field: 'outstandingAmount', debitNormal: true },
  AP: { field: 'outstandingAmount', debitNormal: false },
  CUSTOMER_DEPOSIT: { field: 'customerDepositBalance', debitNormal: false },
  VENDOR_DEPOSIT: { field: 'depositBalance', debitNormal: true },
};

/**
 * Update the denormalized party field of party-tagged lines of a hand-made journal, by the line
 * account's party role (loadPartyRoleMap, accounts that held a role before a remap included):
 *
 *   AR               → outstandingAmount        (debit − credit)
 *   AP               → outstandingAmount        (credit − debit)
 *   CUSTOMER_DEPOSIT → customerDepositBalance   (credit − debit)
 *   VENDOR_DEPOSIT   → depositBalance           (debit − credit)
 *
 * A party on any other account (an expense line from the old expense forms) moves nothing and is
 * logged. Post (apply) and cancel (reverse) must both use this helper.
 * Transitional (E2-R4): once the manual journal posts through postJournal with a recalculation, only
 * the reverse of old manual deposit lines stays here.
 */
export async function applyPartyImpact(
  tx: Prisma.TransactionClient,
  items: readonly PartyImpactItem[],
  direction: 'apply' | 'reverse',
): Promise<void> {
  if (!items.some((it) => it.partyId)) return;
  const roles = await loadPartyRoleMap(tx, items.filter((it) => it.partyId).map((it) => it.accountId));
  for (const it of items) {
    if (!it.partyId) continue;

    const role = roles.get(it.accountId);
    if (!role) {
      logger.warn({ partyId: it.partyId, accountId: it.accountId, direction }, 'applyPartyImpact: party on a non-party account, skipped');
      continue;
    }

    const debit = new Prisma.Decimal(direction === 'apply' ? it.debit : it.credit);
    const credit = new Prisma.Decimal(direction === 'apply' ? it.credit : it.debit);
    const { field, debitNormal } = ROLE_FIELD[role];
    const impact = debitNormal ? debit.minus(credit) : credit.minus(debit);
    if (impact.isZero()) continue;

    await tx.party.update({
      where: { id: it.partyId },
      data: { [field]: { increment: impact } },
    });
  }
}
