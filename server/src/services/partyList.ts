/**
 * Query building for the "Pelanggan & Vendor" list (GET /api/parties list mode and /summary).
 * Party pickers (client usePartyPicker) send sort=name and a search term, so they use this
 * paged mode too. Read-only: outstandingAmount and deposit caches are never written.
 */
import { PartyType, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { firstString, parseSort, type SortSpec } from '../utils/listQuery';

/** Params that switch GET /api/parties into the paged list mode. */
export const PARTY_LIST_ONLY_PARAMS = ['search', 'sort', 'isActive', 'hasOutstanding'] as const;

export function isPartyListQuery(query: Record<string, unknown>): boolean {
  return PARTY_LIST_ONLY_PARAMS.some((key) => firstString(query[key]) !== undefined);
}

export const PARTY_SORT_FIELDS = ['name', 'outstanding', 'deposit'] as const;
export type PartySortField = (typeof PARTY_SORT_FIELDS)[number];
export const DEFAULT_PARTY_SORT: SortSpec<PartySortField> = { field: 'name', dir: 'asc' };

const PARTY_TYPES = new Set<string>(Object.values(PartyType));

export type PartyWhereResult =
  | { ok: true; where: Prisma.PartyWhereInput; type: PartyType | null }
  | { ok: false; error: string };

/**
 * Filters shared by the list and the summary:
 *   type            Customer | Supplier (both include partyType Both, as the
 *                   pickers do) or Both (only "Pelanggan & Vendor")
 *   isActive        true | false
 *   hasOutstanding  true → outstandingAmount > 0
 *   search          name, email, phone or NPWP (taxId), case-insensitive
 */
export function buildPartyWhere(query: Record<string, unknown>): PartyWhereResult {
  const and: Prisma.PartyWhereInput[] = [];

  const rawType = firstString(query.type);
  let type: PartyType | null = null;
  if (rawType) {
    if (!PARTY_TYPES.has(rawType)) return { ok: false, error: 'Jenis mitra tidak dikenal.' };
    type = rawType as PartyType;
    and.push(
      type === PartyType.Both
        ? { partyType: PartyType.Both }
        : { partyType: { in: [type, PartyType.Both] } },
    );
  }

  const isActive = firstString(query.isActive);
  if (isActive) {
    if (isActive !== 'true' && isActive !== 'false') {
      return { ok: false, error: 'Filter status mitra tidak valid.' };
    }
    and.push({ isActive: isActive === 'true' });
  }

  const hasOutstanding = firstString(query.hasOutstanding);
  if (hasOutstanding === 'true') and.push({ outstandingAmount: { gt: 0 } });
  else if (hasOutstanding === 'false') and.push({ outstandingAmount: { lte: 0 } });
  else if (hasOutstanding) return { ok: false, error: 'Filter saldo terutang tidak valid.' };

  const search = firstString(query.search);
  if (search) {
    and.push({
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { taxId: { contains: search, mode: 'insensitive' } },
      ],
    });
  }

  return { ok: true, where: and.length > 0 ? { AND: and } : {}, type };
}

export function parsePartySort(value: unknown): SortSpec<PartySortField> {
  return parseSort(value, PARTY_SORT_FIELDS, DEFAULT_PARTY_SORT);
}

/**
 * Prisma orderBy for a sort spec. "deposit" uses the balance that matches the
 * tab (vendor deposit on the Vendor tab, customer deposit otherwise), then the
 * other one. Ties fall back to name, then id, so pages never shift.
 */
export function partyOrderBy(
  sort: SortSpec<PartySortField>,
  type: PartyType | null,
): Prisma.PartyOrderByWithRelationInput[] {
  const dir = sort.dir;
  const tail: Prisma.PartyOrderByWithRelationInput[] = [{ name: 'asc' }, { id: 'asc' }];
  switch (sort.field) {
    case 'outstanding':
      return [{ outstandingAmount: dir }, ...tail];
    case 'deposit':
      return type === PartyType.Supplier
        ? [{ depositBalance: dir }, { customerDepositBalance: dir }, ...tail]
        : [{ customerDepositBalance: dir }, { depositBalance: dir }, ...tail];
    default:
      return [{ name: dir }, { id: dir }];
  }
}

type DecimalLike = Prisma.Decimal | Decimal | number | string | null | undefined;
const toDecimal = (v: DecimalLike) => new Decimal(v === null || v === undefined ? 0 : v.toString());
const money = (d: Decimal) => d.toDecimalPlaces(2).toNumber();

export interface PartySummarySource {
  partyType: PartyType | string;
  isActive: boolean;
  outstandingAmount: DecimalLike;
  /** Receivable side (services/ledger/partySides.ts). */
  receivableOutstanding: DecimalLike;
  /** Payable side (services/ledger/partySides.ts). */
  payableOutstanding: DecimalLike;
  depositBalance: DecimalLike;
  customerDepositBalance: DecimalLike;
}

/** The columns summarizeParties and summarizePartyDashboard read. */
export const PARTY_SUMMARY_SELECT = {
  partyType: true, isActive: true, outstandingAmount: true, receivableOutstanding: true, payableOutstanding: true,
  depositBalance: true, customerDepositBalance: true,
} as const;

const isCustomerSide = (t: PartyType | string) => t === PartyType.Customer || t === PartyType.Both;
const isSupplierSide = (t: PartyType | string) => t === PartyType.Supplier || t === PartyType.Both;

export interface PartySummary {
  total: number;
  activeCount: number;
  inactiveCount: number;
  byType: { Customer: number; Supplier: number; Both: number };
  /** Positive receivable side of Customer + Both parties (same rule as /dashboard). */
  totalReceivable: number;
  /** Positive payable side of Supplier + Both parties (same rule as /dashboard). */
  totalPayable: number;
  /** Uang muka pelanggan (customerDepositBalance) of Customer + Both. */
  totalCustomerDeposit: number;
  /** Uang muka vendor (depositBalance) of Supplier + Both. */
  totalVendorDeposit: number;
  /** Parties with outstandingAmount > 0. */
  withOutstandingCount: number;
}

export function summarizeParties(rows: readonly PartySummarySource[]): PartySummary {
  const byType = { Customer: 0, Supplier: 0, Both: 0 };
  let receivable = new Decimal(0);
  let payable = new Decimal(0);
  let customerDeposit = new Decimal(0);
  let vendorDeposit = new Decimal(0);
  let activeCount = 0;
  let withOutstandingCount = 0;

  for (const r of rows) {
    if (r.partyType in byType) byType[r.partyType as keyof typeof byType] += 1;
    if (r.isActive) activeCount += 1;
    if (toDecimal(r.outstandingAmount).gt(0)) withOutstandingCount += 1;
    if (isCustomerSide(r.partyType)) {
      receivable = receivable.plus(Decimal.max(toDecimal(r.receivableOutstanding), 0));
      customerDeposit = customerDeposit.plus(toDecimal(r.customerDepositBalance));
    }
    if (isSupplierSide(r.partyType)) {
      payable = payable.plus(Decimal.max(toDecimal(r.payableOutstanding), 0));
      vendorDeposit = vendorDeposit.plus(toDecimal(r.depositBalance));
    }
  }

  return {
    total: rows.length,
    activeCount,
    inactiveCount: rows.length - activeCount,
    byType,
    totalReceivable: money(receivable),
    totalPayable: money(payable),
    totalCustomerDeposit: money(customerDeposit),
    totalVendorDeposit: money(vendorDeposit),
    withOutstandingCount,
  };
}

export interface PartyDashboardSource extends PartySummarySource {
  id: string;
  name: string;
}

export interface PartyDashboardTop {
  id: string;
  name: string;
  outstanding: number;
}

export interface PartyDashboardSummary {
  totalCustomers: number;
  totalSuppliers: number;
  /** Positive receivable side of Customer + Both (a Both party counts once per side, E5-R3). */
  totalPiutang: number;
  /** Positive payable side of Supplier + Both. */
  totalHutang: number;
  totalCustomerDeposit: number;
  totalVendorDeposit: number;
}

const TOP_LIMIT = 10;

/** Largest positive amounts of one side, at most ten, ties by name. */
function topBySide(rows: readonly PartyDashboardSource[], amount: (r: PartyDashboardSource) => Decimal): PartyDashboardTop[] {
  return rows
    .map((r) => ({ r, value: amount(r) }))
    .filter((x) => x.value.gt(0))
    .sort((a, b) => b.value.comparedTo(a.value) || a.r.name.localeCompare(b.r.name))
    .slice(0, TOP_LIMIT)
    .map(({ r, value }) => ({ id: r.id, name: r.name, outstanding: money(value) }));
}

/**
 * GET /parties/dashboard figures (active, non-dummy parties): totals and top lists per side, from
 * receivableOutstanding / payableOutstanding, so a Both party with a 30 jt payable and a 20 jt
 * receivable adds 30 jt to totalHutang and 20 jt to totalPiutang instead of 50 jt to each.
 */
export function summarizePartyDashboard(rows: readonly PartyDashboardSource[]): {
  summary: PartyDashboardSummary;
  topCustomers: PartyDashboardTop[];
  topVendors: PartyDashboardTop[];
} {
  const s = summarizeParties(rows);
  const customers = rows.filter((r) => isCustomerSide(r.partyType));
  const suppliers = rows.filter((r) => isSupplierSide(r.partyType));
  return {
    summary: {
      totalCustomers: customers.length,
      totalSuppliers: suppliers.length,
      totalPiutang: s.totalReceivable,
      totalHutang: s.totalPayable,
      totalCustomerDeposit: s.totalCustomerDeposit,
      totalVendorDeposit: s.totalVendorDeposit,
    },
    topCustomers: topBySide(customers, (r) => toDecimal(r.receivableOutstanding)),
    topVendors: topBySide(suppliers, (r) => toDecimal(r.payableOutstanding)),
  };
}
