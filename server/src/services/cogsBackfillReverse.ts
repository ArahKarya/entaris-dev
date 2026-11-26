import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { recalculateAccountBalances } from '../utils/accountBalance';
import { logger } from '../lib/logger';
import { assertPeriodOpen } from '../utils/periodGuard';
import { cancelTrailData, type CancelTrail } from '../utils/cancelClaim';
import { lockInventoryRows } from './inventory/stockLocks';
import { REVERSAL_NEEDS_TRUE_UP, reverseMovement } from './inventory/inventoryLedger';
import { BusinessError } from '../utils/errors';
import { LEGACY_COGS_SETTLE } from './cogsBackfillService';

type Tx = Prisma.TransactionClient;

const NEAR_ZERO_QTY = 0.0005;

/**
 * Takes back exactly the settlement Revaluation rows (LEGACY_COGS_SETTLE) that `where` selects, under
 * one lock of their items, while the caller voids their journals: the voided journal reverses the
 * same inventory amount. Refused with REVERSAL_NEEDS_TRUE_UP when goods of the item went out since
 * (no true-up: the legacy queue is owner decision #6, PR-6.6). A settlement journal from before the
 * value ledger has no row: voiding it would move the GL alone (its differential sits in the
 * valuation baseline), so assertSettlementsBacked refuses it first.
 */
async function reverseSettleRows(tx: Tx, where: Prisma.StockMovementWhereInput, trail?: CancelTrail): Promise<void> {
  const rows = await tx.stockMovement.findMany({
    where: { ...where, referenceType: LEGACY_COGS_SETTLE, movementType: 'Revaluation', isCancelled: false },
    orderBy: [{ createdAt: 'desc' }, { movementNumber: 'desc' }],
    select: { id: true, itemId: true, createdById: true },
  });
  if (rows.length === 0) return;
  await lockInventoryRows(tx, { itemIds: rows.map((r) => r.itemId) });
  // Latest first: a later settlement was posted on the book the earlier one left.
  for (const row of rows) await reverseMovement(tx, row.id, { userId: trail?.cancelledById ?? row.createdById });
}

/**
 * Refuses (REVERSAL_NEEDS_TRUE_UP, 409) when a still-active settlement journal in `jeIds` has no
 * LegacyCogsSettle row: it was posted before the value ledger, its differential is in the valuation
 * baseline, and voiding it would leave book ≠ GL. Runs before anything is written.
 */
async function assertSettlementsBacked(tx: Tx, jeIds: readonly string[]): Promise<void> {
  for (const jeId of jeIds) {
    const je = await tx.journalEntry.findUnique({ where: { id: jeId }, select: { entryNumber: true, status: true, fiscalYearId: true, date: true } });
    if (!je || je.status === 'Cancelled') continue;
    // A closed period refuses first, whatever the journal is backed by.
    await assertPeriodOpen(tx, { fiscalYearId: je.fiscalYearId, date: je.date }, 'jurnal');
    const backed = await tx.stockMovement.count({
      where: { journalEntryId: jeId, referenceType: LEGACY_COGS_SETTLE, movementType: 'Revaluation', isCancelled: false },
    });
    if (backed > 0) continue;
    throw new BusinessError(
      `Pembatalan ditolak: jurnal penyelesaian HPP ${je.entryNumber} dibuat sebelum buku nilai persediaan, jadi nilainya tidak dapat dibalik otomatis. `
        + 'Minta akuntan membuat jurnal koreksi.',
      REVERSAL_NEEDS_TRUE_UP,
      409,
    );
  }
}

/**
 * Close the COGS backfill queue of a sales invoice being cancelled: the invoice's own COGS JV is
 * voided, so every auto-settle differential booked against its queue is void too. Cancels those
 * auto-settle JVs + ALE, deletes the settlement rows and marks the queue entries 'Cancelled' so
 * later stock-ins no longer settle them. No-op when the invoice has no queue entries. `trail` (the
 * user cancel that voids them) is stored on those JVs.
 */
export async function closeCogsBackfillForSalesInvoice(
  tx: Tx,
  salesInvoiceId: string,
  trail?: CancelTrail,
): Promise<{ queuesClosed: number; journalsCancelled: number }> {
  const queues = await tx.cogsBackfillQueue.findMany({
    where: { salesInvoiceId, status: { not: 'Cancelled' } },
    include: { settlements: true },
  });
  if (queues.length === 0) return { queuesClosed: 0, journalsCancelled: 0 };

  const settlements = queues.flatMap((q) => q.settlements);
  const jeIds = [...new Set(settlements.map((s) => s.journalEntryId).filter((x): x is string => !!x))];
  // A batch JV may also cover settlements of other (still valid) invoices: cancelling it whole would
  // drop their differential too, so only reverse JVs whose settlements all belong to this invoice.
  const ownJeIds: string[] = [];
  for (const jeId of jeIds) {
    const foreign = await tx.cogsBackfillSettlement.count({
      where: { journalEntryId: jeId, queue: { salesInvoiceId: { not: salesInvoiceId } } },
    });
    if (foreign > 0) logger.warn({ salesInvoiceId, jeId }, 'COGS backfill JV shared with another invoice; left active');
    else ownJeIds.push(jeId);
  }
  await assertSettlementsBacked(tx, ownJeIds);
  await reverseSettleRows(tx, { journalEntryId: { in: ownJeIds } }, trail);
  const affectedAccountIds = new Set<string>();
  let journalsCancelled = 0;
  for (const jeId of ownJeIds) {
    const je = await tx.journalEntry.findUnique({ where: { id: jeId }, include: { items: true } });
    if (!je || je.status === 'Cancelled') continue;
    // The auto-settle JV is dated at settle time and may sit in another (closed) fiscal year.
    await assertPeriodOpen(tx, { fiscalYearId: je.fiscalYearId, date: je.date }, 'jurnal');
    await tx.journalEntry.update({ where: { id: jeId }, data: { status: 'Cancelled', cancelledAt: new Date(), ...cancelTrailData(trail) } });
    await tx.accountingLedgerEntry.updateMany({ where: { referenceId: jeId }, data: { isCancelled: true } });
    for (const ji of je.items) affectedAccountIds.add(ji.accountId);
    journalsCancelled++;
  }

  if (settlements.length > 0) {
    await tx.cogsBackfillSettlement.deleteMany({ where: { id: { in: settlements.map((s) => s.id) } } });
  }
  await tx.cogsBackfillQueue.updateMany({
    where: { id: { in: queues.map((q) => q.id) } },
    data: { status: 'Cancelled', settledAt: null },
  });

  if (affectedAccountIds.size > 0) await recalculateAccountBalances(tx, [...affectedAccountIds]);

  logger.info(
    { salesInvoiceId, queuesClosed: queues.length, settlements: settlements.length, journalsCancelled },
    'COGS backfill queue closed for cancelled sales invoice',
  );
  return { queuesClosed: queues.length, journalsCancelled };
}

/**
 * Reverse every COGS backfill auto-settle triggered by one stock-in document (on cancel or before
 * re-create on edit): cancels the auto-settle JVs + ALE, restores queue qtyPending/status, deletes
 * the settlement rows. No-op without settlements. `trail` is stored on the voided JVs when a user
 * cancel triggers the reversal.
 */
export async function reverseCogsSettlementsByTrigger(
  tx: Tx,
  triggerSource: 'ProductionRun' | 'PurchaseInvoice' | 'StockMovement',
  triggerRefId: string,
  trail?: CancelTrail,
): Promise<{ reversed: number; journalsCancelled: number }> {
  const settlements = await tx.cogsBackfillSettlement.findMany({
    where: { triggerSource, triggerRefId },
    include: { queue: true },
    orderBy: { createdAt: 'desc' },
  });
  if (settlements.length === 0) return { reversed: 0, journalsCancelled: 0 };

  // One auto-settle JV can cover many settlements in a batch.
  const jeIds = [...new Set(settlements.map((s) => s.journalEntryId).filter((x): x is string => !!x))];
  await assertSettlementsBacked(tx, jeIds);
  // The settlement rows of the trigger (one per settled item, those of an invoice cancelled since
  // already reversed), before their journals are voided.
  await reverseSettleRows(tx, { referenceId: triggerRefId }, trail);

  const affectedAccountIds = new Set<string>();
  let journalsCancelled = 0;
  for (const jeId of jeIds) {
    const je = await tx.journalEntry.findUnique({ where: { id: jeId }, include: { items: true } });
    if (!je || je.status === 'Cancelled') continue;
    // The auto-settle JV is dated at settle time and may sit in another (closed) fiscal year.
    await assertPeriodOpen(tx, { fiscalYearId: je.fiscalYearId, date: je.date }, 'jurnal');
    await tx.journalEntry.update({ where: { id: jeId }, data: { status: 'Cancelled', cancelledAt: new Date(), ...cancelTrailData(trail) } });
    await tx.accountingLedgerEntry.updateMany({ where: { referenceId: jeId }, data: { isCancelled: true } });
    for (const ji of je.items) affectedAccountIds.add(ji.accountId);
    journalsCancelled++;
  }

  for (const s of settlements) {
    const q = s.queue;
    // A queue closed because its sales invoice was cancelled must stay closed (never re-open it).
    if (q.status === 'Cancelled') continue;
    const restoredPending = new Decimal(q.qtyPending.toString()).plus(s.qtySettled.toString());
    const original = new Decimal(q.qtyOriginal.toString());
    const capped = Decimal.min(restoredPending, original);
    const isUntouched = capped.minus(original).abs().lte(NEAR_ZERO_QTY);
    await tx.cogsBackfillQueue.update({
      where: { id: q.id },
      data: {
        qtyPending: capped.toDecimalPlaces(3).toNumber(),
        status: isUntouched ? 'Pending' : 'PartiallySettled',
        settledAt: null,
      },
    });
  }

  // Delete settlements only after the queue is restored.
  await tx.cogsBackfillSettlement.deleteMany({ where: { id: { in: settlements.map((s) => s.id) } } });

  // averageCost is not reversed arithmetically (inventory value moved since settle and could clip to 0);
  // callers that change stock recompute it from active inbound movements.

  if (affectedAccountIds.size > 0) await recalculateAccountBalances(tx, [...affectedAccountIds]);

  logger.info(
    { triggerSource, triggerRefId, reversed: settlements.length, journalsCancelled },
    'COGS backfill settlements reversed',
  );
  return { reversed: settlements.length, journalsCancelled };
}
