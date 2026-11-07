// Read-only comparison of each real party's stored outstanding amount (E7-R13), per side since
// E2-R13 (services/ledger/partySides.ts). The old dummy generator and delete-dummy recalculated every
// party from open invoices alone, which dropped opening outstanding balances. Shown per party and
// side: the stored amount, the amount recalcPartyOutstanding would compute (computePartySides:
// opening + outstanding of invoices not Draft or Cancelled + manual party adjustment), and the
// party's AR/AP ledger balance. The ledger column is indicative only until opening balances are
// journaled per party (E2-R11). Nothing is changed here; corrections go through the accountant.

import { Prisma, type PartyType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { systemAccounts } from './systemAccounts';
import { manualPartyAdjustments } from './ledger/partyAdjustments';
import { computePartySides, legacyUnassignedOf, NON_OUTSTANDING_INVOICE_STATUSES } from './ledger/partySides';

type Db = Prisma.TransactionClient | typeof prisma;
type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value | null | undefined): Dec => new Prisma.Decimal(v ?? 0);

export interface DriftParty {
  id: string;
  name: string;
  partyType: PartyType;
  outstandingAmount: Prisma.Decimal.Value;
  receivableOutstanding: Prisma.Decimal.Value;
  payableOutstanding: Prisma.Decimal.Value;
  openingOutstanding: Prisma.Decimal.Value;
  openingReceivable: Prisma.Decimal.Value;
  openingPayable: Prisma.Decimal.Value;
}

/** Per-party sums the comparison needs, keyed by party id. */
export interface DriftSums {
  salesOutstanding: ReadonlyMap<string, Dec>;
  purchaseOutstanding: ReadonlyMap<string, Dec>;
  /** AR debit − credit. */
  arLedger: ReadonlyMap<string, Dec>;
  /** AP credit − debit. */
  apLedger: ReadonlyMap<string, Dec>;
  /** Manual party adjustment on AR (services/ledger/partyAdjustments.ts); counts for a Customer or Both. */
  arManual?: ReadonlyMap<string, Dec>;
  /** Manual party adjustment on AP; counts for a Supplier or Both. */
  apManual?: ReadonlyMap<string, Dec>;
}

export interface DriftSide {
  stored: string;
  expected: string;
  ledger: string;
  storedMinusExpected: string;
  expectedMinusLedger: string;
}

export interface DriftRow extends DriftSide {
  partyId: string;
  name: string;
  partyType: string;
  receivable: DriftSide;
  payable: DriftSide;
  /** Opening outstanding not directed to a side (partySides legacyUnassigned). */
  legacyUnassigned: string;
}

const hasReceivable = (t: string) => t === 'Customer' || t === 'Both';
const hasPayable = (t: string) => t === 'Supplier' || t === 'Both';

function side(stored: Dec, expected: Dec, ledger: Dec): DriftSide & { clean: boolean } {
  const storedDiff = stored.minus(expected);
  const ledgerDiff = expected.minus(ledger);
  return {
    stored: stored.toFixed(2),
    expected: expected.toFixed(2),
    ledger: ledger.toFixed(2),
    storedMinusExpected: storedDiff.toFixed(2),
    expectedMinusLedger: ledgerDiff.toFixed(2),
    clean: storedDiff.isZero() && ledgerDiff.isZero(),
  };
}

const strip = ({ clean: _clean, ...rest }: DriftSide & { clean: boolean }): DriftSide => rest;

/**
 * One row per party whose stored amount differs from the expected one on a side, or whose expected
 * amount differs from its ledger balance. Expected is computePartySides, the formula of
 * recalcPartyOutstanding; the ledger is AR on the receivable side of a Customer or Both and AP on
 * the payable side of a Supplier or Both. The top-level figures are the totals (stored =
 * outstanding_amount).
 */
export function buildDriftRows(parties: readonly DriftParty[], sums: DriftSums): DriftRow[] {
  const zero = D(0);
  return parties.flatMap((p) => {
    const legacy = legacyUnassignedOf({
      openingOutstanding: D(p.openingOutstanding), openingReceivable: D(p.openingReceivable), openingPayable: D(p.openingPayable),
    });
    const expected = computePartySides({
      partyType: p.partyType,
      openingReceivable: p.openingReceivable,
      openingPayable: p.openingPayable,
      legacyUnassigned: legacy,
      siOutstanding: sums.salesOutstanding.get(p.id) ?? zero,
      piOutstanding: sums.purchaseOutstanding.get(p.id) ?? zero,
      adjAr: sums.arManual?.get(p.id) ?? zero,
      adjAp: sums.apManual?.get(p.id) ?? zero,
    });
    const arLedger = hasReceivable(p.partyType) ? (sums.arLedger.get(p.id) ?? zero) : zero;
    const apLedger = hasPayable(p.partyType) ? (sums.apLedger.get(p.id) ?? zero) : zero;
    const receivable = side(D(p.receivableOutstanding), expected.receivable, arLedger);
    const payable = side(D(p.payableOutstanding), expected.payable, apLedger);
    const total = side(D(p.outstandingAmount), expected.outstanding, arLedger.plus(apLedger));
    if (receivable.clean && payable.clean && total.clean) return [];
    return [{
      partyId: p.id,
      name: p.name,
      partyType: p.partyType,
      ...strip(total),
      receivable: strip(receivable),
      payable: strip(payable),
      legacyUnassigned: legacy.toFixed(2),
    }];
  });
}

/**
 * Loads the real (non-dummy) parties and their sums, then builds the drift rows. `partyIds` limits
 * the run to those parties (an empty list matches nothing).
 */
export async function computePartyOutstandingDrift(db: Db = prisma, opts: { partyIds?: readonly string[] } = {}): Promise<DriftRow[]> {
  if (opts.partyIds && opts.partyIds.length === 0) return [];
  const only = opts.partyIds ? { in: [...opts.partyIds] } : undefined;
  const invoiceWhere = { status: { notIn: [...NON_OUTSTANDING_INVOICE_STATUSES] }, ...(only ? { partyId: only } : {}) };
  const [arIds, apIds] = await Promise.all([systemAccounts.getAccountIds('AR'), systemAccounts.getAccountIds('AP')]);
  const [parties, si, pi, ledger, arManual, apManual] = await Promise.all([
    db.party.findMany({
      where: { isDummy: false, ...(only ? { id: only } : {}) },
      select: {
        id: true, name: true, partyType: true, outstandingAmount: true, receivableOutstanding: true, payableOutstanding: true,
        openingOutstanding: true, openingReceivable: true, openingPayable: true,
      },
      orderBy: { name: 'asc' },
    }),
    db.salesInvoice.groupBy({ by: ['partyId'], where: invoiceWhere, _sum: { outstanding: true } }),
    db.purchaseInvoice.groupBy({ by: ['partyId'], where: invoiceWhere, _sum: { outstanding: true } }),
    db.accountingLedgerEntry.groupBy({
      by: ['partyId', 'accountId'],
      where: { isCancelled: false, partyId: only ?? { not: null }, accountId: { in: [...arIds, ...apIds] } },
      _sum: { debit: true, credit: true },
    }),
    manualPartyAdjustments(db, 'AR', opts.partyIds),
    manualPartyAdjustments(db, 'AP', opts.partyIds),
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
    arManual,
    apManual,
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
