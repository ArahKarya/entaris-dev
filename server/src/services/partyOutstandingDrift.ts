// Read-only comparison of each real party's stored outstanding amount (E7-R13). The old dummy
// generator and delete-dummy recalculated every party from open invoices alone, which dropped
// opening outstanding balances. Shown per party: the stored amount, the amount recalcPartyOutstanding
// would compute (opening + outstanding of non-cancelled invoices), and the party's AR/AP ledger
// balance. The ledger column is indicative only until opening balances are journaled per party
// (E2-R11). Nothing is changed here; corrections go through the accountant.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { systemAccounts } from './systemAccounts';

type Db = Prisma.TransactionClient | typeof prisma;
type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value | null | undefined): Dec => new Prisma.Decimal(v ?? 0);

export interface DriftParty {
  id: string;
  name: string;
  partyType: string;
  outstandingAmount: Prisma.Decimal.Value;
  openingOutstanding: Prisma.Decimal.Value;
}

/** Per-party sums the comparison needs, keyed by party id. */
export interface DriftSums {
  salesOutstanding: ReadonlyMap<string, Dec>;
  purchaseOutstanding: ReadonlyMap<string, Dec>;
  /** AR debit − credit. */
  arLedger: ReadonlyMap<string, Dec>;
  /** AP credit − debit. */
  apLedger: ReadonlyMap<string, Dec>;
}

export interface DriftRow {
  partyId: string;
  name: string;
  partyType: string;
  stored: string;
  expected: string;
  ledger: string;
  storedMinusExpected: string;
  expectedMinusLedger: string;
}

const isCustomer = (t: string) => t === 'Customer' || t === 'Both';
const isSupplier = (t: string) => t === 'Supplier' || t === 'Both';

/**
 * One row per party whose stored amount differs from the expected one, or whose expected amount
 * differs from its ledger balance. Expected follows recalcPartyOutstanding: opening outstanding
 * plus sales invoices (Customer/Both) plus purchase invoices (Supplier/Both); the ledger adds AR
 * and AP the same way.
 */
export function buildDriftRows(parties: readonly DriftParty[], sums: DriftSums): DriftRow[] {
  const zero = D(0);
  return parties.flatMap((p) => {
    const stored = D(p.outstandingAmount);
    let expected = D(p.openingOutstanding);
    let ledger = zero;
    if (isCustomer(p.partyType)) {
      expected = expected.plus(sums.salesOutstanding.get(p.id) ?? zero);
      ledger = ledger.plus(sums.arLedger.get(p.id) ?? zero);
    }
    if (isSupplier(p.partyType)) {
      expected = expected.plus(sums.purchaseOutstanding.get(p.id) ?? zero);
      ledger = ledger.plus(sums.apLedger.get(p.id) ?? zero);
    }
    const storedDiff = stored.minus(expected);
    const ledgerDiff = expected.minus(ledger);
    if (storedDiff.isZero() && ledgerDiff.isZero()) return [];
    return [{
      partyId: p.id,
      name: p.name,
      partyType: p.partyType,
      stored: stored.toFixed(2),
      expected: expected.toFixed(2),
      ledger: ledger.toFixed(2),
      storedMinusExpected: storedDiff.toFixed(2),
      expectedMinusLedger: ledgerDiff.toFixed(2),
    }];
  });
}

/** Loads the real (non-dummy) parties and their sums, then builds the drift rows. */
export async function computePartyOutstandingDrift(db: Db = prisma): Promise<DriftRow[]> {
  const [arIds, apIds] = await Promise.all([systemAccounts.getAccountIds('AR'), systemAccounts.getAccountIds('AP')]);
  const [parties, si, pi, ledger] = await Promise.all([
    db.party.findMany({
      where: { isDummy: false },
      select: { id: true, name: true, partyType: true, outstandingAmount: true, openingOutstanding: true },
      orderBy: { name: 'asc' },
    }),
    db.salesInvoice.groupBy({ by: ['partyId'], where: { status: { not: 'Cancelled' } }, _sum: { outstanding: true } }),
    db.purchaseInvoice.groupBy({ by: ['partyId'], where: { status: { not: 'Cancelled' } }, _sum: { outstanding: true } }),
    db.accountingLedgerEntry.groupBy({
      by: ['partyId', 'accountId'],
      where: { isCancelled: false, partyId: { not: null }, accountId: { in: [...arIds, ...apIds] } },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const arLedger = new Map<string, Dec>();
  const apLedger = new Map<string, Dec>();
  for (const g of ledger) {
    if (!g.partyId) continue;
    const debit = D(g._sum.debit);
    const credit = D(g._sum.credit);
    if (arIds.includes(g.accountId)) arLedger.set(g.partyId, (arLedger.get(g.partyId) ?? D(0)).plus(debit.minus(credit)));
    if (apIds.includes(g.accountId)) apLedger.set(g.partyId, (apLedger.get(g.partyId) ?? D(0)).plus(credit.minus(debit)));
  }
  return buildDriftRows(parties, {
    salesOutstanding: new Map(si.map((g) => [g.partyId, D(g._sum.outstanding)])),
    purchaseOutstanding: new Map(pi.map((g) => [g.partyId, D(g._sum.outstanding)])),
    arLedger,
    apLedger,
  });
}

/** When the old generator and delete-dummy ran, from the audit trail (their response message). */
export async function legacyDummyRuns(db: Db = prisma): Promise<{ at: Date; action: 'generate' | 'delete' }[]> {
  const rows = await db.auditLog.findMany({
    where: {
      entityType: 'settings',
      OR: [
        { newValues: { path: ['message'], equals: 'Data dummy dibuat.' } },
        { newValues: { path: ['message'], equals: 'Data dummy dihapus.' } },
      ],
    },
    select: { createdAt: true, newValues: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    at: r.createdAt,
    action: (r.newValues as { message?: string } | null)?.message === 'Data dummy dibuat.' ? 'generate' : 'delete',
  }));
}
