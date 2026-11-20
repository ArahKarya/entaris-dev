import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { replayWeightedAverage, sortMovementsForReplay, type ReplayMovement } from '../../utils/weightedAverageReplay';
import { UNIT_COST_DP } from '../../utils/costPrecision';

type Db = Pick<Prisma.TransactionClient, 'stockMovement' | 'systemAccountMapping'>;

/**
 * Read-only findings behind scripts/repair/e3-manual-movement-cost-audit.ts (E3-R4, PR-6.3a).
 * Before the server valued manual stock outs itself, the client's unit cost was posted as is, and
 * a manual row without an offset was credited to the opening balance equity. Nothing here writes;
 * re-pricing old rows is left to the value ledger baseline and the inventory vs GL reconciliation.
 *
 *  a. active manual Out / AdjustmentOut whose unit cost differs from the average replayed (the one
 *     replay in utils/weightedAverageReplay.ts) over the item's active rows posted before it.
 *     `difference` = quantity x (unit cost − replayed average), the amount the row over- (> 0) or
 *     under-valued (< 0) on the inventory account.
 *  b. active manual row whose offset account is an OPENING_EQUITY account.
 */
export type ManualAuditList = 'a' | 'b';

export interface ManualMovementAuditRow {
  list: ManualAuditList;
  id: string;
  movementNumber: string;
  date: Date;
  itemId: string;
  movementType: string;
  quantity: string;
  unitCost: string;
  totalValue: string;
  /** List a: the replayed average before the row; null in list b. */
  replayedAverage: string | null;
  /** List a: quantity x (unit cost − replayed average), 2 dp; null in list b. */
  difference: string | null;
  offsetAccountId: string | null;
  note: string;
}

/** Below this per-unit gap the stored cost counts as the average (rows before PR-6.4a were stored at 2 dp). */
const COST_TOLERANCE = new Decimal('0.005');

const OUTBOUND = new Set(['Out', 'AdjustmentOut']);

export interface AuditMovement extends ReplayMovement {
  movementNumber: string;
  date: Date;
  itemId: string;
  totalValue: string;
  offsetAccountId: string | null;
  /** A manual row has neither reference type nor id (documents and the opening balance set them). */
  manual: boolean;
}

/**
 * List a for one item's active rows (pure). Each manual outbound row is compared with the replay of
 * the rows sorted before it; a row with no costed inbound before it is compared with 0.
 */
export function outboundCostFindings(rows: readonly AuditMovement[]): ManualMovementAuditRow[] {
  const sorted = sortMovementsForReplay(rows);
  const out: ManualMovementAuditRow[] = [];
  sorted.forEach((row, index) => {
    if (!row.manual || !OUTBOUND.has(row.movementType)) return;
    const replay = replayWeightedAverage(sorted.slice(0, index), { fallbackAverageCost: 0 });
    const average = new Decimal(replay.averageCost);
    const unitCost = new Decimal(row.unitCost.toString());
    if (unitCost.minus(average).abs().lt(COST_TOLERANCE)) return;
    const quantity = new Decimal(row.quantity.toString());
    out.push({
      ...rowFields(row, 'a'),
      replayedAverage: average.toFixed(UNIT_COST_DP),
      difference: quantity.mul(unitCost.minus(average)).toDecimalPlaces(2).toFixed(2),
      note: replay.hasCostedInbound ? 'unit cost differs from the replayed average' : 'no costed inbound before the row (stock may predate its movements)',
    });
  });
  return out;
}

function rowFields(row: AuditMovement, list: ManualAuditList) {
  return {
    list,
    id: row.id,
    movementNumber: row.movementNumber,
    date: row.date,
    itemId: row.itemId,
    movementType: row.movementType,
    quantity: row.quantity.toString(),
    unitCost: row.unitCost.toString(),
    totalValue: row.totalValue,
    offsetAccountId: row.offsetAccountId,
  };
}

/** Active rows of the items that have at least one active manual outbound row, grouped per item. */
async function loadItemRows(db: Db): Promise<Map<string, AuditMovement[]>> {
  const manualOut = await db.stockMovement.findMany({
    where: { isCancelled: false, referenceType: null, referenceId: null, movementType: { in: ['Out', 'AdjustmentOut'] } },
    select: { itemId: true },
    distinct: ['itemId'],
  });
  const rows = await db.stockMovement.findMany({
    where: { isCancelled: false, itemId: { in: manualOut.map((r) => r.itemId) } },
    select: {
      id: true, movementNumber: true, date: true, itemId: true, movementType: true, quantity: true, unitCost: true,
      totalValue: true, createdAt: true, referenceType: true, referenceId: true, offsetAccountId: true,
    },
  });
  const byItem = new Map<string, AuditMovement[]>();
  for (const r of rows) {
    const list = byItem.get(r.itemId) ?? [];
    list.push({
      ...r,
      quantity: r.quantity.toString(),
      unitCost: r.unitCost.toString(),
      totalValue: r.totalValue.toString(),
      manual: r.referenceType === null && r.referenceId === null,
    });
    byItem.set(r.itemId, list);
  }
  return byItem;
}

/** List b: active manual rows posted against an OPENING_EQUITY account. */
async function openingEquityFindings(db: Db): Promise<ManualMovementAuditRow[]> {
  const mappings = await db.systemAccountMapping.findMany({ where: { role: 'OPENING_EQUITY' }, select: { accountId: true } });
  if (mappings.length === 0) return [];
  const rows = await db.stockMovement.findMany({
    where: { isCancelled: false, referenceType: null, referenceId: null, offsetAccountId: { in: mappings.map((m) => m.accountId) } },
    select: {
      id: true, movementNumber: true, date: true, itemId: true, movementType: true, quantity: true, unitCost: true,
      totalValue: true, createdAt: true, offsetAccountId: true,
    },
    orderBy: [{ date: 'asc' }, { movementNumber: 'asc' }],
  });
  return rows.map((r) => ({
    ...rowFields({ ...r, quantity: r.quantity.toString(), unitCost: r.unitCost.toString(), totalValue: r.totalValue.toString(), manual: true }, 'b'),
    replayedAverage: null,
    difference: null,
    note: 'manual row against the opening balance equity',
  }));
}

export async function findManualMovementCostIssues(db: Db): Promise<ManualMovementAuditRow[]> {
  const listA: ManualMovementAuditRow[] = [];
  for (const rows of (await loadItemRows(db)).values()) listA.push(...outboundCostFindings(rows));
  listA.sort((x, y) => x.date.getTime() - y.date.getTime() || x.movementNumber.localeCompare(y.movementNumber));
  return [...listA, ...(await openingEquityFindings(db))];
}
