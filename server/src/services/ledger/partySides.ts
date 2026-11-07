// Party balances per side (E2-R13, E5-R3; plan §2.5). A party carries its receivable and its payable
// separately: receivable_outstanding and payable_outstanding, built from the opening amounts
// opening_receivable / opening_payable, the outstanding of its invoices (not Draft or Cancelled,
// the definition services/ledger/arSubledgerCheck.ts uses) and its manual party adjustment
// (partyAdjustments.ts). outstanding_amount stays their sum for the old readers (CRM, party list),
// and opening_outstanding stays the opening total.
//
// Opening amounts the migration 20261110100000_party_side_balances could not direct safely (a party
// typed Both, a negative amount, an opening a payment remainder may have cut without a side, see
// services/paymentSubmit.ts) stay undirected: legacyUnassigned = opening_outstanding −
// opening_receivable − opening_payable. It counts on the receivable side of a Customer or Both and on
// the payable side of a Supplier, as the one-column formula did, so no outstanding changes before
// the accountant reviews it (e2-party-opening-audit, PR-5.13). It can be negative: a payment remainder
// still lowers opening_outstanding alone until PR-5.13.
//
// computePartySides is the one formula: recalcPartyOutstanding (utils/accountBalance.ts), the drift
// report (services/partyOutstandingDrift.ts) and e2-party-side-recalc use it. adjustPartyOpening is
// the one writer of the opening columns once its callers land (PR-5.11, PR-5.13).
import { Prisma, type PartyType } from '@prisma/client';
import { manualPartyAdjustments } from './partyAdjustments';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value | null | undefined): Dec => new Prisma.Decimal(v ?? 0);

export type PartySide = 'RECEIVABLE' | 'PAYABLE';

/** Invoice statuses that do not count towards a party's outstanding. */
export const NON_OUTSTANDING_INVOICE_STATUSES = ['Draft', 'Cancelled'] as const;

export interface PartySideInput {
  partyType: PartyType;
  openingReceivable: Prisma.Decimal.Value;
  openingPayable: Prisma.Decimal.Value;
  /** opening_outstanding − opening_receivable − opening_payable; may be negative. */
  legacyUnassigned: Prisma.Decimal.Value;
  siOutstanding: Prisma.Decimal.Value;
  piOutstanding: Prisma.Decimal.Value;
  adjAr: Prisma.Decimal.Value;
  adjAp: Prisma.Decimal.Value;
}

export interface PartySides {
  receivable: Dec;
  payable: Dec;
  /** receivable + payable */
  outstanding: Dec;
}

const hasReceivable = (t: PartyType) => t === 'Customer' || t === 'Both';
const hasPayable = (t: PartyType) => t === 'Supplier' || t === 'Both';

/**
 * Customer: receivable = opening receivable + undirected opening + sales invoices + AR adjustment.
 * Supplier: payable = opening payable + undirected opening + purchase invoices + AP adjustment.
 * Both: both sides, the undirected opening on the receivable side. An opening amount on a side the
 * party type does not have (the type was changed after it was set) stays on that side instead of
 * vanishing; e2-party-side-recalc reports it.
 */
export function computePartySides(i: PartySideInput): PartySides {
  const legacyOnPayable = i.partyType === 'Supplier';
  let receivable = D(i.openingReceivable);
  let payable = D(i.openingPayable);
  if (legacyOnPayable) payable = payable.plus(D(i.legacyUnassigned));
  else receivable = receivable.plus(D(i.legacyUnassigned));
  if (hasReceivable(i.partyType)) receivable = receivable.plus(D(i.siOutstanding)).plus(D(i.adjAr));
  if (hasPayable(i.partyType)) payable = payable.plus(D(i.piOutstanding)).plus(D(i.adjAp));
  return { receivable, payable, outstanding: receivable.plus(payable) };
}

export interface PartySideRow {
  id: string;
  name: string;
  partyType: PartyType;
  isDummy: boolean;
  outstandingAmount: Dec;
  receivableOutstanding: Dec;
  payableOutstanding: Dec;
  openingOutstanding: Dec;
  openingReceivable: Dec;
  openingPayable: Dec;
}

const PARTY_SIDE_SELECT = {
  id: true, name: true, partyType: true, isDummy: true, outstandingAmount: true, receivableOutstanding: true,
  payableOutstanding: true, openingOutstanding: true, openingReceivable: true, openingPayable: true,
} as const;

export const legacyUnassignedOf = (p: Pick<PartySideRow, 'openingOutstanding' | 'openingReceivable' | 'openingPayable'>): Dec =>
  D(p.openingOutstanding).minus(D(p.openingReceivable)).minus(D(p.openingPayable));

export interface PartySideFigures {
  party: PartySideRow;
  input: PartySideInput;
  sides: PartySides;
}

export interface LoadPartySidesOptions {
  /**
   * The manual adjustment of one role, or undefined to leave it out. Default: manualPartyAdjustments,
   * which throws PARTY_ROLE_AMBIGUOUS on an ambiguous mapping.
   */
  adjustments?: (role: 'AR' | 'AP', partyIds?: readonly string[]) => Promise<ReadonlyMap<string, Dec> | undefined>;
}

/** Party id -> stored row, formula input and computed sides, for `partyIds` (all parties when omitted). */
export async function loadPartySides(
  tx: Tx,
  partyIds?: readonly string[],
  opts: LoadPartySidesOptions = {},
): Promise<Map<string, PartySideFigures>> {
  if (partyIds && partyIds.length === 0) return new Map();
  const only = partyIds ? { in: [...partyIds] } : undefined;
  const invoiceWhere = { status: { notIn: [...NON_OUTSTANDING_INVOICE_STATUSES] }, ...(only ? { partyId: only } : {}) };
  const parties: PartySideRow[] = await tx.party.findMany({
    where: only ? { id: only } : {},
    select: PARTY_SIDE_SELECT,
    orderBy: { id: 'asc' },
  });
  if (parties.length === 0) return new Map();
  const ids = parties.map((p) => p.id);
  const adjustments = opts.adjustments ?? ((role, list) => manualPartyAdjustments(tx, role, list));
  const [si, pi, adjAr, adjAp] = await Promise.all([
    tx.salesInvoice.groupBy({ by: ['partyId'], where: invoiceWhere, _sum: { outstanding: true } }),
    tx.purchaseInvoice.groupBy({ by: ['partyId'], where: invoiceWhere, _sum: { outstanding: true } }),
    adjustments('AR', partyIds ? ids : undefined),
    adjustments('AP', partyIds ? ids : undefined),
  ]);
  const siBy = new Map(si.map((g) => [g.partyId, D(g._sum.outstanding)]));
  const piBy = new Map(pi.map((g) => [g.partyId, D(g._sum.outstanding)]));
  return new Map(parties.map((p) => {
    const input: PartySideInput = {
      partyType: p.partyType,
      openingReceivable: D(p.openingReceivable),
      openingPayable: D(p.openingPayable),
      legacyUnassigned: legacyUnassignedOf(p),
      siOutstanding: siBy.get(p.id) ?? D(0),
      piOutstanding: piBy.get(p.id) ?? D(0),
      adjAr: adjAr?.get(p.id) ?? D(0),
      adjAp: adjAp?.get(p.id) ?? D(0),
    };
    return [p.id, { party: p, input, sides: computePartySides(input) }];
  }));
}

/** True when the stored derived columns already equal the computed sides. */
export const sidesStored = (f: Pick<PartySideFigures, 'party' | 'sides'>): boolean =>
  D(f.party.receivableOutstanding).equals(f.sides.receivable)
  && D(f.party.payableOutstanding).equals(f.sides.payable)
  && D(f.party.outstandingAmount).equals(f.sides.outstanding);

/** Writes the three derived columns when they differ; returns whether it wrote. */
export async function writePartySides(tx: Tx, f: PartySideFigures): Promise<boolean> {
  if (sidesStored(f)) return false;
  await tx.party.update({
    where: { id: f.party.id },
    data: { receivableOutstanding: f.sides.receivable, payableOutstanding: f.sides.payable, outstandingAmount: f.sides.outstanding },
  });
  return true;
}

const OPENING_COLUMN: Readonly<Record<PartySide, Prisma.Sql>> = {
  RECEIVABLE: Prisma.raw('opening_receivable'),
  PAYABLE: Prisma.raw('opening_payable'),
};

/**
 * Moves a side's opening amount and opening_outstanding together in one statement under the party
 * row lock: a negative delta takes off at most what the side still holds (never below zero), a
 * positive one adds it back. Returns the change actually made (negative for a reduction, zero when
 * nothing was left or the party does not exist). Two callers at once queue on the row lock, so their
 * reductions never add up to more than the opening.
 */
export async function adjustPartyOpening(tx: Tx, partyId: string, side: PartySide, delta: Prisma.Decimal.Value): Promise<Dec> {
  const amount = D(delta);
  if (amount.isZero()) return amount;
  const col = OPENING_COLUMN[side];
  const change = amount.isNegative()
    ? Prisma.sql`-LEAST(GREATEST(cur.v, 0), ${amount.abs().toFixed(2)}::numeric)`
    : Prisma.sql`${amount.toFixed(2)}::numeric`;
  const rows = await tx.$queryRaw<{ change: string }[]>`
    WITH cur AS (SELECT id, ${col} AS v FROM parties WHERE id = ${partyId} FOR UPDATE),
         upd AS (
           UPDATE parties p
              SET ${col} = cur.v + ${change},
                  opening_outstanding = p.opening_outstanding + ${change},
                  updated_at = NOW()
             FROM cur
            WHERE p.id = cur.id
        RETURNING (${change})::text AS change
         )
    SELECT change FROM upd`;
  return D(rows[0]?.change);
}

/**
 * SET clause for parties with no documents and no manual journals (delete demo data): each side is
 * its opening, the undirected rest on the side computePartySides puts it.
 */
export const OPENING_ONLY_SIDES_SET_SQL = `
  "receivable_outstanding" = CASE WHEN "partyType" = 'Supplier' THEN "opening_receivable"
                                  ELSE "opening_outstanding" - "opening_payable" END,
  "payable_outstanding"    = CASE WHEN "partyType" = 'Supplier' THEN "opening_outstanding" - "opening_receivable"
                                  ELSE "opening_payable" END,
  "outstanding_amount"     = "opening_outstanding"`;

// e2-party-side-recalc (PR-5.9a): the migration fills the side columns without the manual party
// adjustment; the script compares every party with computePartySides and, with --apply, rewrites
// the derived columns (the ledger does not change), one audit row per party it changed.

export const PARTY_SIDE_RECALC_AUDIT_ACTION = 'E2_PARTY_SIDE_RECALC';

/**
 * negative-opening-side: opening_receivable or opening_payable below zero (adjustPartyOpening never
 * writes that). opening-off-side: an opening amount on a side the party type does not have.
 * legacy-unassigned: opening not directed to a side yet, left to e2-party-opening-audit (PR-5.13).
 */
export type PartySideIssue = 'negative-opening-side' | 'opening-off-side' | 'legacy-unassigned';

export interface PartySideRecalcRow {
  partyId: string;
  name: string;
  partyType: PartyType;
  isDummy: boolean;
  stored: PartySides;
  computed: PartySides;
  openingOutstanding: Dec;
  openingReceivable: Dec;
  openingPayable: Dec;
  legacyUnassigned: Dec;
  /** The derived columns differ from computePartySides; --apply rewrites them. */
  changes: boolean;
  issues: PartySideIssue[];
}

function sideIssues(p: PartySideRow, legacy: Dec): PartySideIssue[] {
  const issues: PartySideIssue[] = [];
  if (D(p.openingReceivable).isNegative() || D(p.openingPayable).isNegative()) issues.push('negative-opening-side');
  if ((!hasReceivable(p.partyType) && !D(p.openingReceivable).isZero()) || (!hasPayable(p.partyType) && !D(p.openingPayable).isZero())) {
    issues.push('opening-off-side');
  }
  if (!legacy.isZero()) issues.push('legacy-unassigned');
  return issues;
}

/** Every party whose derived columns would change or that has an issue, by name. */
export async function planPartySideRecalc(tx: Tx, partyIds?: readonly string[]): Promise<PartySideRecalcRow[]> {
  const figures = await loadPartySides(tx, partyIds);
  const rows = [...figures.values()].flatMap(({ party: p, input, sides }) => {
    const legacy = D(input.legacyUnassigned);
    const changes = !sidesStored({ party: p, sides });
    const issues = sideIssues(p, legacy);
    if (!changes && issues.length === 0) return [];
    return [{
      partyId: p.id, name: p.name, partyType: p.partyType, isDummy: p.isDummy,
      stored: { receivable: D(p.receivableOutstanding), payable: D(p.payableOutstanding), outstanding: D(p.outstandingAmount) },
      computed: sides,
      openingOutstanding: D(p.openingOutstanding), openingReceivable: D(p.openingReceivable), openingPayable: D(p.openingPayable),
      legacyUnassigned: legacy, changes, issues,
    }];
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.partyId.localeCompare(b.partyId));
}

/**
 * Rewrites the derived columns of `partyIds` from their current figures (recalcPartyOutstanding's
 * formula), one audit row per party that changed (via 'repair'). Returns the ids it changed.
 */
export async function applyPartySideRecalc(
  tx: Tx,
  partyIds: readonly string[],
  opts: { approvedBy: string | null },
): Promise<string[]> {
  if (partyIds.length === 0) return [];
  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');
  const changed: string[] = [];
  for (const f of (await loadPartySides(tx, partyIds)).values()) {
    const before = { receivable: D(f.party.receivableOutstanding), payable: D(f.party.payableOutstanding), outstanding: D(f.party.outstandingAmount) };
    if (!(await writePartySides(tx, f))) continue;
    const fixed = (s: PartySides) => ({
      receivableOutstanding: s.receivable.toFixed(2), payableOutstanding: s.payable.toFixed(2), outstandingAmount: s.outstanding.toFixed(2),
    });
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: PARTY_SIDE_RECALC_AUDIT_ACTION,
        entityType: 'Party',
        entityId: f.party.id,
        oldValues: fixed(before),
        newValues: { ...fixed(f.sides), legacyUnassigned: D(f.input.legacyUnassigned).toFixed(2), approvedBy: opts.approvedBy },
        via: 'repair',
        viaMeta: { script: PARTY_SIDE_RECALC_AUDIT_ACTION, approvedBy: opts.approvedBy },
      },
    });
    changed.push(f.party.id);
  }
  return changed;
}
