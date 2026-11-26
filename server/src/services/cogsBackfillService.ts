import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { generateDocumentNumber } from '../utils/documentNumber';
import { updateAccountBalance } from '../utils/accountBalance';
import { systemAccounts } from './systemAccounts';
import { cogsAccountFor } from './ledger/systemRoleAccounts';
import { logger } from '../lib/logger';
import { lockInventoryRows } from './inventory/stockLocks';
import { resolveJournalFiscalYear } from '../utils/periodGuard';
import { linkMovementJournal, postRevaluation } from './inventory/inventoryLedger';

type Tx = Prisma.TransactionClient;

interface SettleSource {
  type: 'PurchaseInvoice' | 'ProductionRun' | 'StockMovement';
  refId: string;
  refNo?: string;
}

interface SettleResult {
  settledCount: number;
  totalQty: number;
  totalDifferential: number;
  journalEntryId?: string;
}

const NEAR_ZERO_QTY = 0.0005;
const NEAR_ZERO_AMT = 0.005;

/**
 * reference_type of the Revaluation row a settlement writes (owner decision #6): reference_id is
 * the triggering stock-in document, journal_entry_id its differential journal (when one is posted).
 */
export const LEGACY_COGS_SETTLE = 'LegacyCogsSettle';

/**
 * After a stock-in event, settle pending COGS backfill entries for the item (FIFO). The batch's
 * differential moves value between inventory and COGS through the value ledger: one Revaluation of
 * −differential (postRevaluation, LEGACY_COGS_SETTLE, wholeToInventory) and a single JV of the same
 * amount (DR HPP / CR Persediaan, or reverse), linked to that row. The whole differential moves
 * stock_value, also when the stock-in leaves stock at or below 0: it re-values the oversold units
 * the stock-in covered, which a split to COGS would leave in the book at zero quantity. Safe to
 * call when no pending entries exist — returns null without DB writes.
 */
export async function settleCogsBackfillForItem(
  tx: Tx,
  params: {
    itemId: string;
    qtyAvailable: number;       // qty of the stock-in available to settle deficit
    unitCostNow: number;        // cost basis per unit for this stock-in
    userId: string;
    settleDate: Date;
    source: SettleSource;
  },
): Promise<SettleResult | null> {
  const { itemId, qtyAvailable, unitCostNow, userId, settleDate, source } = params;
  if (qtyAvailable <= NEAR_ZERO_QTY) return null;

  const pendings = await tx.cogsBackfillQueue.findMany({
    where: {
      inventoryItemId: itemId,
      status: { in: ['Pending', 'PartiallySettled'] },
      // Defensive: never settle deferred COGS of a cancelled invoice (its COGS JV is void).
      salesInvoice: { status: { not: 'Cancelled' } },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (pendings.length === 0) return null;
  // The caller already holds the item lock (its stock-in locked it); taking it again is free and
  // keeps the average read below behind it if a caller ever does not.
  await lockInventoryRows(tx, { itemIds: [itemId] });

  let remaining = new Decimal(qtyAvailable);
  let totalDifferential = new Decimal(0);
  let totalQtySettled = new Decimal(0);
  const settlements: Array<{ pendingId: string; qtyToSettle: Decimal; differential: Decimal }> = [];

  for (const p of pendings) {
    if (remaining.lte(NEAR_ZERO_QTY)) break;
    const qtyPending = new Decimal(p.qtyPending.toString());
    const qtyToSettle = Decimal.min(qtyPending, remaining);
    const costAtSale = new Decimal(p.costAtSale.toString());
    const diff = qtyToSettle.mul(new Decimal(unitCostNow).minus(costAtSale)).toDecimalPlaces(2);
    settlements.push({ pendingId: p.id, qtyToSettle, differential: diff });
    totalDifferential = totalDifferential.plus(diff);
    totalQtySettled = totalQtySettled.plus(qtyToSettle);
    remaining = remaining.minus(qtyToSettle);
  }

  if (settlements.length === 0) return null;

  let journalEntryId: string | undefined;
  const diffNum = totalDifferential.toNumber();

  // Post differential JV only when material
  if (Math.abs(diffNum) >= NEAR_ZERO_AMT) {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) throw new Error(`Inventory item ${itemId} not found during COGS backfill settle.`);
    // The settlement belongs to the year of its own date, never to the triggering document's year.
    const fiscalYearId = (await resolveJournalFiscalYear(tx, settleDate)).id;
    const reval = await postRevaluation(tx, {
      itemId, date: settleDate, fiscalYearId, createdById: userId, delta: totalDifferential.negated(),
      referenceType: LEGACY_COGS_SETTLE, referenceId: source.refId, referenceNumber: source.refNo ?? null,
      notes: `Auto-settle HPP ${settlements.length} entri, pemicu ${source.type}${source.refNo ? ' ' + source.refNo : ''}`,
      wholeToInventory: true,
    });
    // > 0: inventory down, DR HPP / CR Persediaan.
    journalEntryId = await postSettleJournal(tx, {
      item, amount: reval.valueDelta.negated(), fiscalYearId, settleDate, userId,
      narration: `Auto-settle COGS ${item.name}: ${settlements.length} entry, trigger ${source.type}${source.refNo ? ' ' + source.refNo : ''}`,
    });
    await linkMovementJournal(tx, reval.movement.id, journalEntryId);
  }

  // Persist queue updates + settlement records
  for (const s of settlements) {
    const pending = pendings.find((p) => p.id === s.pendingId)!;
    const newQtyPending = new Decimal(pending.qtyPending.toString()).minus(s.qtyToSettle);
    const isFull = newQtyPending.lte(NEAR_ZERO_QTY);

    await tx.cogsBackfillQueue.update({
      where: { id: s.pendingId },
      data: {
        qtyPending: isFull ? 0 : newQtyPending.toDecimalPlaces(3).toNumber(),
        status: isFull ? 'Settled' : 'PartiallySettled',
        settledAt: isFull ? settleDate : null,
      },
    });

    await tx.cogsBackfillSettlement.create({
      data: {
        queueId: s.pendingId,
        qtySettled: s.qtyToSettle.toNumber(),
        costAtSettle: unitCostNow,
        differential: s.differential.toNumber(),
        journalEntryId: journalEntryId ?? null,
        triggerSource: source.type,
        triggerRefId: source.refId,
        triggerRefNo: source.refNo ?? null,
      },
    });
  }

  logger.info(
    {
      itemId,
      settledCount: settlements.length,
      totalQty: totalQtySettled.toNumber(),
      totalDifferential: diffNum,
      journalEntryId,
      source,
    },
    'COGS backfill settled',
  );

  return {
    settledCount: settlements.length,
    totalQty: totalQtySettled.toNumber(),
    totalDifferential: diffNum,
    journalEntryId,
  };
}

/** The differential journal of a settlement: `amount` > 0 DR HPP / CR Persediaan, < 0 the reverse. */
async function postSettleJournal(
  tx: Tx,
  i: { item: { id: string; name: string; accountId: string | null }; amount: Decimal; fiscalYearId: string; settleDate: Date; userId: string; narration: string },
): Promise<string> {
  const invAccountId = i.item.accountId ?? (await systemAccounts.getAccount('INVENTORY')).id;
  const cogsAccount = await cogsAccountFor(tx);
  const isPositive = i.amount.gt(0);
  const debitAccountId = isPositive ? cogsAccount.id : invAccountId;
  const creditAccountId = isPositive ? invAccountId : cogsAccount.id;
  const amt = i.amount.abs().toNumber();
  const { settleDate, fiscalYearId, narration } = i;
  const entryNumber = await generateDocumentNumber(tx, 'JV', settleDate, fiscalYearId);

  const je = await tx.journalEntry.create({
    data: {
      entryNumber,
      date: settleDate,
      status: 'Submitted',
      submittedAt: settleDate,
      narration,
      fiscalYearId,
      createdBy: i.userId,
      items: {
        create: [
          { accountId: debitAccountId, debit: amt, credit: 0, description: `${isPositive ? 'DR HPP' : 'DR Persediaan'} ${i.item.name}` },
          { accountId: creditAccountId, debit: 0, credit: amt, description: `${isPositive ? 'CR Persediaan' : 'CR HPP'} ${i.item.name}` },
        ],
      },
    },
  });

  await tx.accountingLedgerEntry.createMany({
    data: [
      { date: settleDate, accountId: debitAccountId, debit: amt, credit: 0, description: narration, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId },
      { date: settleDate, accountId: creditAccountId, debit: 0, credit: amt, description: narration, referenceType: 'JournalEntry', referenceId: je.id, fiscalYearId },
    ],
  });

  await updateAccountBalance(tx, debitAccountId, amt, 0);
  await updateAccountBalance(tx, creditAccountId, 0, amt);
  return je.id;
}
