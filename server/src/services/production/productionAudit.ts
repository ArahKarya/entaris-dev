import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { replayWeightedAverage, sortMovementsForReplay, type ReplayMovement } from '../../utils/weightedAverageReplay';
import { UNIT_COST_DP } from '../inventory/inventoryValueMath';
import { legacyLiveBlend } from '../inventory/manualMovementAudit';
import { inventoryAccountFor } from '../inventory/itemMasterGuard';
import { batchUnitCosts } from '../inventory/inventoryLedger';

type Tx = Prisma.TransactionClient;

/**
 * Read-only findings of production runs behind scripts/repair/e6-*.ts. Nothing here writes;
 * corrections go through journals the accountant approves.
 *
 * Batch-costed runs (E6-R3, PR-6.9): before the value ledger a production input picked from a batch
 * was valued at the client's batch cost (else the batch's own cost), not at the average. Each
 * active run input that links a batch is listed with the cost it went out at, the batch cost, and
 * the average replayed over the item's active rows posted before it (the one replay in
 * utils/weightedAverageReplay.ts, with the blend rule of the live code at the time,
 * legacyLiveBlend). `difference` = quantity x (unit cost − replayed average): what the input
 * over- (> 0) or under-credited (< 0) the item's inventory account. Runs posted on the value ledger
 * go out at the book value, so their difference is about rounding.
 */

/** Below this per-unit gap the input counts as valued at the average (rows before PR-6.4a were stored at 2 dp). */
const COST_TOLERANCE = new Decimal('0.005');

export interface BatchCostRow extends ReplayMovement {
  movementNumber: string;
  date: Date;
  itemId: string;
  /** The production run (reference_id) and its number, set on the run's input rows. */
  runId: string | null;
  runNumber: string | null;
  /** The picked batch of a run input, null on every other row. */
  sourceMovementId: string | null;
  totalValue: string;
}

export interface BatchCostFinding {
  runId: string;
  runNumber: string;
  movementId: string;
  movementNumber: string;
  date: Date;
  itemId: string;
  sourceMovementId: string;
  quantity: string;
  unitCost: string;
  totalValue: string;
  /** The average replayed over the item's rows before the input, 6 dp. */
  replayedAverage: string;
  /** quantity x (unit cost − replayed average), 2 dp; 0.00 within the tolerance. */
  difference: string;
  note: string;
}

const isBatchInput = (r: BatchCostRow) => r.movementType === 'Out' && r.runId !== null && r.sourceMovementId !== null;

/** Batch-linked run inputs of one item's active rows (pure), compared with the replay of the rows before each. */
export function batchCostFindings(rows: readonly BatchCostRow[]): BatchCostFinding[] {
  const sorted = sortMovementsForReplay(rows);
  const out: BatchCostFinding[] = [];
  sorted.forEach((row, index) => {
    if (!isBatchInput(row)) return;
    const replay = replayWeightedAverage(sorted.slice(0, index), { fallbackAverageCost: 0, blends: legacyLiveBlend });
    const average = new Decimal(replay.averageCost);
    const unitCost = new Decimal(row.unitCost.toString());
    const gap = unitCost.minus(average);
    const difference = gap.abs().lt(COST_TOLERANCE) ? new Decimal(0) : new Decimal(row.quantity.toString()).mul(gap);
    out.push({
      runId: row.runId!,
      runNumber: row.runNumber ?? '',
      movementId: row.id,
      movementNumber: row.movementNumber,
      date: row.date,
      itemId: row.itemId,
      sourceMovementId: row.sourceMovementId!,
      quantity: row.quantity.toString(),
      unitCost: row.unitCost.toString(),
      totalValue: row.totalValue,
      replayedAverage: average.toFixed(UNIT_COST_DP),
      difference: difference.toDecimalPlaces(2).toFixed(2),
      note: !replay.hasCostedInbound
        ? 'no costed inbound before the input (stock may predate its movements)'
        : difference.isZero() ? 'at the replayed average' : 'unit cost differs from the replayed average',
    });
  });
  return out;
}

export interface BatchCostRunReport extends BatchCostFinding {
  itemCode: string;
  /** The account the item's stock posts to (inventoryAccountFor). */
  accountId: string | null;
  /** The batch cost as the picker shows it today (batchUnitCosts), 6 dp. */
  batchUnitCost: string;
}

/** Every active production input that picked a batch, oldest first. */
export async function findBatchCostRuns(db: Tx): Promise<BatchCostRunReport[]> {
  const inputs = await db.stockMovement.findMany({
    where: { referenceType: 'ProductionRun', isCancelled: false, movementType: 'Out', sourceMovementId: { not: null } },
    select: { itemId: true },
    distinct: ['itemId'],
  });
  const itemIds = inputs.map((r) => r.itemId);
  if (itemIds.length === 0) return [];

  const rows = await db.stockMovement.findMany({
    where: { isCancelled: false, itemId: { in: itemIds } },
    select: {
      id: true, movementNumber: true, date: true, itemId: true, movementType: true, quantity: true, unitCost: true,
      totalValue: true, createdAt: true, referenceType: true, referenceId: true, referenceNumber: true, sourceMovementId: true,
    },
  });
  const byItem = new Map<string, BatchCostRow[]>();
  for (const r of rows) {
    const run = r.referenceType === 'ProductionRun';
    byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), {
      ...r,
      quantity: r.quantity.toString(),
      unitCost: r.unitCost.toString(),
      totalValue: r.totalValue.toString(),
      runId: run ? r.referenceId : null,
      runNumber: run ? r.referenceNumber : null,
      sourceMovementId: run ? r.sourceMovementId : null,
    }]);
  }
  const findings = [...byItem.values()].flatMap(batchCostFindings);

  const items = await db.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, accountId: true } });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const accountByItem = new Map<string, string | null>();
  for (const i of items) accountByItem.set(i.id, await inventoryAccountFor(db, i));
  const batches = await db.stockMovement.findMany({
    where: { id: { in: [...new Set(findings.map((f) => f.sourceMovementId))] } },
    select: { id: true, quantity: true, unitCost: true, totalValue: true, valueDelta: true },
  });
  const batchCosts = await batchUnitCosts(db, batches);

  return findings
    .map((f) => ({
      ...f,
      itemCode: itemById.get(f.itemId)?.code ?? '',
      accountId: accountByItem.get(f.itemId) ?? null,
      batchUnitCost: (batchCosts.get(f.sourceMovementId) ?? new Decimal(0)).toFixed(UNIT_COST_DP),
    }))
    .sort((x, y) => x.date.getTime() - y.date.getTime() || x.movementNumber.localeCompare(y.movementNumber));
}
