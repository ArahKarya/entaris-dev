// Party opening audit (E2-R13 migration, plan step 5 PR-5.13), the core of
// scripts/repair/e2-party-opening-audit.ts. Per party and side (receivable on the AR accounts,
// payable on the AP accounts, former role accounts included) it derives from the ledger the opening
// the party still holds:
//   ledger opening = ledger balance of the party − outstanding of its invoices (not Draft or
//                    Cancelled) − its manual party adjustment (partyAdjustments.ts)
// and compares it with the opening columns (opening_receivable / opening_payable and the undirected
// rest, legacyUnassigned, on the side computePartySides counts it), the side's active opening
// journals and its Receive/Pay payments. Classes:
//   match                          columns follow the ledger, nothing undirected
//   opening-from-single-journal    side column zero, exactly one active opening journal of the party
//                                  on the side, no Receive/Pay payment on the side, the ledger equals
//                                  that journal, and the side holds nothing or exactly that amount
//                                  undirected: the column takes the journal amount (PRD E2-R13
//                                  "fill the opening from the active opening journal with partyId")
//   consumed-opening-not-restored  the ledger holds more than the columns, at most what the side's
//                                  Cancelled payments came to (a cancel before PR-5.13 did not put
//                                  the remainder back) and at most the side's opening journals: the
//                                  column takes the ledger opening
//   undirected-matches-gl          Customer or Supplier: the columns already add up to the ledger but
//                                  part of it is undirected; the only side the type has takes it
//   both-direction-from-gl         Both: the opening total matches the ledger, the ledger shows the
//                                  split per side (report; the accountant corrects with one manual
//                                  journal, never by moving columns)
//   both-needs-accountant          any other Both difference (report)
//   negative-opening               an opening column or the side's opening below zero (report)
//   opening-off-side               an opening on a side the party type does not have (report)
//   gl-without-opening             the ledger holds an opening the party has no column or opening
//                                  journal for (report)
//   unexplained                    anything else (report)
// --apply (with --approved-by) changes only the first three apply classes: the side column moves
// through adjustPartyOpening, the explained undirected rest goes to zero, the party is recalculated
// (recalcPartyOutstanding) and must classify as match afterwards, else the batch rolls back. The
// ledger never changes. One audit row per party (via 'repair').
import { Prisma, type PartyType } from '@prisma/client';
import { recalcPartyOutstanding } from '../../utils/accountBalance';
import { partyOpeningJournalTotal } from './openingBalanceParty';
import { ADJUSTMENT_SIGN, manualPartyAdjustmentSql } from './partyAdjustments';
import { unassignedCountsOn } from './partyOpeningConsumption';
import { roleAccountIds } from './partyRules';
import { adjustPartyOpening, legacyUnassignedOf, type PartySide } from './partySides';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value | null | undefined): Dec => new Prisma.Decimal(v ?? 0);

/** Differences up to this amount are rounding. */
export const PARTY_OPENING_TOLERANCE = new Prisma.Decimal('0.01');
export const PARTY_OPENING_AUDIT_ACTION = 'E2_PARTY_OPENING_AUDIT';

export type PartyOpeningClass =
  | 'match'
  | 'opening-from-single-journal'
  | 'consumed-opening-not-restored'
  | 'undirected-matches-gl'
  | 'both-direction-from-gl'
  | 'both-needs-accountant'
  | 'negative-opening'
  | 'opening-off-side'
  | 'gl-without-opening'
  | 'unexplained';

/** The classes --apply changes. */
export const PARTY_OPENING_APPLY_CLASSES: ReadonlySet<PartyOpeningClass> = new Set([
  'opening-from-single-journal', 'consumed-opening-not-restored', 'undirected-matches-gl',
]);

export interface PartyOpeningSide {
  /** Ledger balance of the party on the side's role accounts, normal sign. */
  gl: Dec;
  /** Outstanding of the party's invoices of the side (not Draft or Cancelled). */
  documents: Dec;
  /** Manual party adjustment on the side's role accounts. */
  adjustment: Dec;
  /** gl − documents − adjustment. */
  glOpening: Dec;
  /** Receive (receivable) or Pay (payable) payments of the party, any status. */
  payments: number;
  /** Amount of the Cancelled ones. */
  cancelledPayments: Dec;
  /** Opening allocations of the side's active payments (consumption recorded since PR-5.13). */
  consumed: Dec;
  /** Active opening journals of the side and their party-line total; null when the type has no such side. */
  journals: { entryNumbers: string[]; amount: Dec } | null;
}

export interface PartyOpeningFigures {
  partyId: string;
  name: string;
  partyType: PartyType;
  isDummy: boolean;
  openingReceivable: Dec;
  openingPayable: Dec;
  openingOutstanding: Dec;
  receivable: PartyOpeningSide;
  payable: PartyOpeningSide;
}

export interface PartyOpeningVerdict {
  cls: PartyOpeningClass;
  /** The side --apply moves (apply classes only). */
  side: PartySide | null;
  /** Opening columns after --apply (apply classes), or the split the ledger shows (both-direction-from-gl). */
  target: { receivable: Dec; payable: Dec } | null;
}

const SIDES: readonly PartySide[] = ['RECEIVABLE', 'PAYABLE'];
const ownedSides = (t: PartyType): PartySide[] => (t === 'Customer' ? ['RECEIVABLE'] : t === 'Supplier' ? ['PAYABLE'] : [...SIDES]);
const near = (a: Dec, b: Dec): boolean => a.minus(b).abs().lte(PARTY_OPENING_TOLERANCE);

/** Pure: the class of one party (see the header). */
export function classifyPartyOpening(f: PartyOpeningFigures): PartyOpeningVerdict {
  const rest = legacyUnassignedOf(f);
  const owned = ownedSides(f.partyType);
  const col = (s: PartySide) => (s === 'RECEIVABLE' ? f.openingReceivable : f.openingPayable);
  const fig = (s: PartySide) => (s === 'RECEIVABLE' ? f.receivable : f.payable);
  const effective = (s: PartySide) => (unassignedCountsOn(f.partyType, s) ? col(s).plus(rest) : col(s));
  const report = (cls: PartyOpeningClass, target: PartyOpeningVerdict['target'] = null): PartyOpeningVerdict => ({ cls, side: null, target });
  const moved = (cls: PartyOpeningClass, s: PartySide, value: Dec): PartyOpeningVerdict => ({
    cls, side: s, target: { receivable: s === 'RECEIVABLE' ? value : f.openingReceivable, payable: s === 'PAYABLE' ? value : f.openingPayable },
  });

  if (f.openingReceivable.isNegative() || f.openingPayable.isNegative() || f.openingOutstanding.isNegative()
    || owned.some((s) => effective(s).lt(PARTY_OPENING_TOLERANCE.neg()))) {
    return report('negative-opening');
  }
  if (SIDES.some((s) => !owned.includes(s) && !col(s).isZero())) return report('opening-off-side');
  const matches = owned.every((s) => near(effective(s), fig(s).glOpening));
  if (matches && rest.isZero()) return report('match');

  // Moving side s with the undirected rest set to zero: every other side must already match on its column.
  const othersMatch = (s: PartySide) => owned.filter((o) => o !== s).every((o) => near(col(o), fig(o).glOpening));
  for (const s of owned) {
    const g = fig(s);
    if (col(s).isZero() && g.journals?.entryNumbers.length === 1 && g.payments === 0
      && g.journals.amount.gt(0) && near(g.journals.amount, g.glOpening) && othersMatch(s)
      // Nothing recorded yet, or the undirected rest is that journal: an undirected rest beyond it is not explained.
      && (effective(s).isZero() || near(effective(s), g.journals.amount))) {
      return moved('opening-from-single-journal', s, g.journals.amount);
    }
  }
  for (const s of owned) {
    const g = fig(s);
    const missing = g.glOpening.minus(effective(s));
    if (missing.gt(PARTY_OPENING_TOLERANCE) && g.cancelledPayments.plus(PARTY_OPENING_TOLERANCE).gte(missing)
      && (g.journals?.entryNumbers.length ?? 0) > 0 && g.glOpening.lte(g.journals!.amount.plus(PARTY_OPENING_TOLERANCE)) && othersMatch(s)) {
      return moved('consumed-opening-not-restored', s, g.glOpening);
    }
  }
  if (f.partyType !== 'Both' && matches) return moved('undirected-matches-gl', owned[0], fig(owned[0]).glOpening);
  if (f.partyType === 'Both' && !rest.isZero()
    && near(f.openingOutstanding, f.receivable.glOpening.plus(f.payable.glOpening))
    && SIDES.every((s) => fig(s).glOpening.gte(PARTY_OPENING_TOLERANCE.neg()))) {
    return report('both-direction-from-gl', { receivable: f.receivable.glOpening, payable: f.payable.glOpening });
  }
  if (owned.some((s) => fig(s).glOpening.gt(PARTY_OPENING_TOLERANCE) && fig(s).journals?.entryNumbers.length === 0 && near(effective(s), D(0)))) {
    return report('gl-without-opening');
  }
  return report(f.partyType === 'Both' ? 'both-needs-accountant' : 'unexplained');
}

interface FigureRow {
  id: string;
  name: string;
  party_type: PartyType;
  is_dummy: boolean;
  opening_receivable: string;
  opening_payable: string;
  opening_outstanding: string;
  gl_ar: string; gl_ap: string;
  si: string; pi: string;
  adj_ar: string; adj_ap: string;
  receive_count: number; pay_count: number;
  receive_cancelled: string; pay_cancelled: string;
  consumed_receivable: string; consumed_payable: string;
}

const inAccounts = (ids: readonly string[]): Prisma.Sql =>
  (ids.length > 0 ? Prisma.sql`ale.account_id IN (${Prisma.join(ids)})` : Prisma.sql`false`);

/**
 * Figures of every party with an opening column, or a ledger opening on either side (or of
 * `partyIds` only, with the same filter), by name. Loads the side's opening journals for the sides
 * the party type has.
 */
export async function loadPartyOpeningFigures(tx: Tx, partyIds?: readonly string[]): Promise<PartyOpeningFigures[]> {
  if (partyIds && partyIds.length === 0) return [];
  // One query at a time on the transaction connection.
  const arIds = await roleAccountIds(tx, 'AR', { includeFormer: true });
  const apIds = await roleAccountIds(tx, 'AP', { includeFormer: true });
  const only = partyIds ? Prisma.sql`AND p.id IN (${Prisma.join(partyIds)})` : Prisma.empty;
  const rows = await tx.$queryRaw<FigureRow[]>`
    WITH gl AS (
      SELECT ale.party_id,
             SUM(CASE WHEN ${inAccounts(arIds)} THEN ale.debit - ale.credit ELSE 0 END) AS gl_ar,
             SUM(CASE WHEN ${inAccounts(apIds)} THEN ale.credit - ale.debit ELSE 0 END) AS gl_ap
        FROM accounting_ledger_entries ale
       WHERE ale.is_cancelled = false AND ale.party_id IS NOT NULL AND (${inAccounts(arIds)} OR ${inAccounts(apIds)})
       GROUP BY ale.party_id
    ),
    si AS (SELECT party_id, SUM(outstanding) AS amount FROM sales_invoices WHERE status NOT IN ('Draft', 'Cancelled') GROUP BY party_id),
    pi AS (SELECT party_id, SUM(outstanding) AS amount FROM purchase_invoices WHERE status NOT IN ('Draft', 'Cancelled') GROUP BY party_id),
    adj_ar AS (${manualPartyAdjustmentSql(arIds, ADJUSTMENT_SIGN.AR)}),
    adj_ap AS (${manualPartyAdjustmentSql(apIds, ADJUSTMENT_SIGN.AP)}),
    pay AS (
      SELECT party_id,
             COUNT(*) FILTER (WHERE payment_type::text = 'Receive')::int AS receive_count,
             COUNT(*) FILTER (WHERE payment_type::text = 'Pay')::int AS pay_count,
             COALESCE(SUM(amount) FILTER (WHERE payment_type::text = 'Receive' AND status::text = 'Cancelled'), 0) AS receive_cancelled,
             COALESCE(SUM(amount) FILTER (WHERE payment_type::text = 'Pay' AND status::text = 'Cancelled'), 0) AS pay_cancelled
        FROM payments
       WHERE payment_type::text IN ('Receive', 'Pay')
       GROUP BY party_id
    ),
    consumed AS (
      SELECT pay.party_id,
             COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pay.payment_type::text = 'Receive'), 0) AS receivable,
             COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pay.payment_type::text = 'Pay'), 0) AS payable
        FROM payment_allocations pa
        JOIN payments pay ON pay.id = pa.payment_id
       WHERE pay.status::text <> 'Cancelled'
         AND pa.invoice_type IN ('OpeningReceivable', 'OpeningPayable', 'OpeningUnassigned')
       GROUP BY pay.party_id
    ),
    figures AS (
      SELECT p.id, p.name, p."partyType" AS party_type, p.is_dummy,
             p.opening_receivable, p.opening_payable, p.opening_outstanding,
             COALESCE(gl.gl_ar, 0) AS gl_ar, COALESCE(gl.gl_ap, 0) AS gl_ap,
             COALESCE(si.amount, 0) AS si, COALESCE(pi.amount, 0) AS pi,
             COALESCE(adj_ar.amount, 0) AS adj_ar, COALESCE(adj_ap.amount, 0) AS adj_ap,
             COALESCE(pay.receive_count, 0) AS receive_count, COALESCE(pay.pay_count, 0) AS pay_count,
             COALESCE(pay.receive_cancelled, 0) AS receive_cancelled, COALESCE(pay.pay_cancelled, 0) AS pay_cancelled,
             COALESCE(consumed.receivable, 0) AS consumed_receivable, COALESCE(consumed.payable, 0) AS consumed_payable
        FROM parties p
        LEFT JOIN gl ON gl.party_id = p.id
        LEFT JOIN si ON si.party_id = p.id
        LEFT JOIN pi ON pi.party_id = p.id
        LEFT JOIN adj_ar ON adj_ar.party_id = p.id
        LEFT JOIN adj_ap ON adj_ap.party_id = p.id
        LEFT JOIN pay ON pay.party_id = p.id
        LEFT JOIN consumed ON consumed.party_id = p.id
       WHERE true ${only}
    )
    SELECT id, name, party_type, is_dummy,
           opening_receivable::text, opening_payable::text, opening_outstanding::text,
           gl_ar::text, gl_ap::text, si::text, pi::text, adj_ar::text, adj_ap::text,
           receive_count, pay_count, receive_cancelled::text, pay_cancelled::text,
           consumed_receivable::text, consumed_payable::text
      FROM figures
     WHERE opening_outstanding <> 0 OR opening_receivable <> 0 OR opening_payable <> 0
        OR ABS(gl_ar - si - adj_ar) > ${PARTY_OPENING_TOLERANCE.toFixed(2)}::numeric
        OR ABS(gl_ap - pi - adj_ap) > ${PARTY_OPENING_TOLERANCE.toFixed(2)}::numeric
     ORDER BY name, id`;

  const out: PartyOpeningFigures[] = [];
  for (const r of rows) {
    const owned = ownedSides(r.party_type);
    const side = async (s: PartySide, gl: string, docs: string, adj: string, payments: number, cancelled: string, consumed: string): Promise<PartyOpeningSide> => ({
      gl: D(gl), documents: D(docs), adjustment: D(adj), glOpening: D(gl).minus(D(docs)).minus(D(adj)),
      payments, cancelledPayments: D(cancelled), consumed: D(consumed),
      journals: owned.includes(s) ? await partyOpeningJournalTotal(tx, r.id, s === 'RECEIVABLE' ? 'AR' : 'AP') : null,
    });
    const receivable = await side('RECEIVABLE', r.gl_ar, r.si, r.adj_ar, r.receive_count, r.receive_cancelled, r.consumed_receivable);
    const payable = await side('PAYABLE', r.gl_ap, r.pi, r.adj_ap, r.pay_count, r.pay_cancelled, r.consumed_payable);
    out.push({
      partyId: r.id, name: r.name, partyType: r.party_type, isDummy: r.is_dummy,
      openingReceivable: D(r.opening_receivable), openingPayable: D(r.opening_payable), openingOutstanding: D(r.opening_outstanding),
      receivable, payable,
    });
  }
  return out;
}

export interface PartyOpeningAuditRow {
  figures: PartyOpeningFigures;
  verdict: PartyOpeningVerdict;
}

/** Every listed party with its class, by name (read only). */
export async function planPartyOpeningAudit(tx: Tx, partyIds?: readonly string[]): Promise<PartyOpeningAuditRow[]> {
  return (await loadPartyOpeningFigures(tx, partyIds)).map((figures) => ({ figures, verdict: classifyPartyOpening(figures) }));
}

export interface AppliedPartyOpening {
  partyId: string;
  name: string;
  cls: PartyOpeningClass;
}

const fixedColumns = (f: Pick<PartyOpeningFigures, 'openingReceivable' | 'openingPayable' | 'openingOutstanding'>) => ({
  openingReceivable: f.openingReceivable.toFixed(2), openingPayable: f.openingPayable.toFixed(2), openingOutstanding: f.openingOutstanding.toFixed(2),
});

/**
 * Applies the apply classes to `partyIds` (see the header): each party is locked and classified
 * again first, so a party that changed since the dry run is skipped. Returns what it changed.
 */
export async function applyPartyOpeningAudit(
  tx: Tx,
  partyIds: readonly string[],
  opts: { approvedBy: string | null },
): Promise<AppliedPartyOpening[]> {
  const approvedBy = opts.approvedBy?.trim();
  if (!approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (partyIds.length === 0) return [];
  const admin = await tx.user.findFirst({ where: { role: 'Admin', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('No active Admin user to record the audit rows under.');
  const applied: AppliedPartyOpening[] = [];
  for (const id of [...partyIds].sort()) {
    await tx.$queryRaw`SELECT id FROM parties WHERE id = ${id} FOR UPDATE`;
    const [before] = await loadPartyOpeningFigures(tx, [id]);
    if (!before) continue;
    const verdict = classifyPartyOpening(before);
    if (!PARTY_OPENING_APPLY_CLASSES.has(verdict.cls) || !verdict.target) continue;
    const rest = legacyUnassignedOf(before);
    await adjustPartyOpening(tx, id, 'RECEIVABLE', verdict.target.receivable.minus(before.openingReceivable));
    await adjustPartyOpening(tx, id, 'PAYABLE', verdict.target.payable.minus(before.openingPayable));
    await adjustPartyOpening(tx, id, 'UNASSIGNED', rest.neg());
    await recalcPartyOutstanding(tx, id);
    const [after] = await loadPartyOpeningFigures(tx, [id]);
    const now = after ? classifyPartyOpening(after).cls : 'match';
    if (now !== 'match') throw new Error(`Party ${before.name} is ${now} after the ${verdict.cls} repair; nothing was applied.`);
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: PARTY_OPENING_AUDIT_ACTION,
        entityType: 'Party',
        entityId: id,
        oldValues: fixedColumns(before),
        newValues: {
          ...(after ? fixedColumns(after) : { openingReceivable: '0.00', openingPayable: '0.00', openingOutstanding: '0.00' }),
          class: verdict.cls, side: verdict.side, approvedBy,
        },
        via: 'repair',
        viaMeta: { script: PARTY_OPENING_AUDIT_ACTION, approvedBy },
      },
    });
    applied.push({ partyId: id, name: before.name, cls: verdict.cls });
  }
  return applied;
}
