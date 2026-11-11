import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { recalculateAccountBalances } from '../utils/accountBalance';
import { cancelTrail } from '../utils/cancelClaim';
import { journalFamilyWhere } from '../utils/journalFamily';
import { reverseCogsSettlementsByTrigger } from './cogsBackfillReverse';
import { cancelJournalsInTx, findDocumentJournals } from './ledger/cancelJournals';
import { generateDocumentNumber } from '../utils/documentNumber';
import { assertPeriodOpen, assertPeriodsOpen } from '../utils/periodGuard';
import { calcWeightedAverage } from '../utils/weightedAverage';
import { recomputeAverageCostFromReplay } from './averageCostRecompute';
import { resolveWarehouseId, adjustWarehouseStock } from '../utils/warehouseStock';
import { systemAccounts } from './systemAccounts';
import { settleCogsBackfillForItem } from './cogsBackfillService';
import { productionJournalLines, type SubmitProductionRunInput } from './productionRunSubmit';
import { persistOeeInTx } from './oee';
import { logger } from '../lib/logger';
import { buildProductionRunLineItems } from './productionRunLines';
import { computeProductionCosting } from './production/productionCosting';
import { loadProductionCostContext } from './production/productionCostContext';

type Tx = Prisma.TransactionClient;

/**
 * Number of the next revision journal of `base`: `<base>-R<n>` with n one above the highest
 * existing `-R<n>` in its family (cancelled ones included), starting at 1. Counting cancelled
 * journals instead repeated -R1 for a run posted without an original journal (P2002).
 */
export async function nextRevisionNumber(tx: Tx, base: string): Promise<string> {
  const family = await tx.journalEntry.findMany({
    where: journalFamilyWhere(base),
    select: { entryNumber: true },
  });
  const prefix = `${base}-R`;
  const highest = family.reduce((max, { entryNumber }) => {
    const rest = entryNumber.startsWith(prefix) ? entryNumber.slice(prefix.length) : '';
    return /^\d+$/.test(rest) ? Math.max(max, Number(rest)) : max;
  }, 0);
  return `${prefix}${highest + 1}`;
}

/**
 * Edit a production run: reverse its movements and JEs (record kept), re-apply the
 * new data and post a revision JE JV-{runNumber}-R{n}. Cancelled runs are rejected;
 * affected balances are recalculated from JE sums afterwards to prevent drift.
 */
export async function editProductionRunInTx(
  tx: Tx,
  runId: string,
  body: SubmitProductionRunInput,
  userId: string,
) {
  const oldRun = await tx.productionRun.findUnique({
    where: { id: runId },
    include: { items: { include: { item: true } } },
  });
  if (!oldRun) throw new BusinessError('Data proses produksi tidak ditemukan.');
  if (oldRun.isCancelled) throw new BusinessError('Proses produksi yang sudah dibatalkan tidak bisa diedit.');

  // Old journals and auto-settle are voided and new ones posted on body.date: both periods must be
  // open. Checked before anything is reversed, and again here when an approved edit is executed.
  const txDate = new Date(body.date);
  if (isNaN(txDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  await assertPeriodsOpen(tx, [{ date: oldRun.date }, { fiscalYearId: oldRun.fiscalYearId, date: oldRun.date }], 'produksi');
  const fiscalYear = await assertPeriodOpen(tx, { date: txDate }, 'produksi');

  const oldMovements = await tx.stockMovement.findMany({
    where: { referenceType: 'ProductionRun', referenceId: runId, isCancelled: false },
    include: { item: true },
  });

  const affectedItemIds = new Set<string>();
  for (const mov of oldMovements) {
    const isIn = mov.movementType === 'In' || mov.movementType === 'AdjustmentIn';
    const isOut = mov.movementType === 'Out' || mov.movementType === 'AdjustmentOut';
    const qty = Number(mov.quantity);

    if (isIn && Number(mov.item.currentStock) < qty) {
      if (!body.allowNegativeStock) {
        throw new BusinessError(
          `Tidak dapat mengedit: stok '${mov.item.name}' tidak mencukupi untuk pembalikan output (tersedia ${Number(mov.item.currentStock)}, perlu ${qty}). Output sudah dipakai produksi/penjualan berikutnya.`,
        );
      }
      logger.warn(
        {
          itemId: mov.itemId,
          itemName: mov.item.name,
          currentStock: Number(mov.item.currentStock),
          reverseQty: qty,
          reason: body.negativeStockReason,
        },
        'Production edit reverse with negative stock bypass',
      );
    }
    affectedItemIds.add(mov.itemId);

    const reverseDelta = isOut ? qty : -qty;
    await tx.inventoryItem.update({
      where: { id: mov.itemId },
      data: { currentStock: { increment: reverseDelta } },
    });
    await adjustWarehouseStock(tx, mov.itemId, mov.warehouseId, reverseDelta);
    await tx.stockMovement.update({ where: { id: mov.id }, data: { isCancelled: true } });
  }

  // Recompute WAC by replaying the remaining active movements, input items too: restored
  // stock changes the base later inbound moves were blended against. Historical COGS stays.
  for (const itemId of affectedItemIds) {
    await recomputeAverageCostFromReplay(tx, itemId);
  }

  // Cancel all active journals for this run, including earlier revisions.
  const oldJvNumber = `JV-${oldRun.runNumber}`;
  await cancelJournalsInTx(tx, await findDocumentJournals(tx, oldJvNumber), {
    label: 'produksi',
    trail: cancelTrail(userId, 'Revisi produksi'),
  });
  // Balik auto-settle COGS lama sebelum settle ulang dari data baru (hindari numpuk ganda)
  await reverseCogsSettlementsByTrigger(tx, 'ProductionRun', runId);

  await tx.productionRunItem.deleteMany({ where: { productionRunId: runId } });
  await tx.productionRunCost.deleteMany({ where: { productionRunId: runId } });
  await tx.productionRunProcess.deleteMany({ where: { productionRunId: runId } });
  // OEE: clear old downtime + per-machine rows; recreated from the new payload below.
  await tx.productionDowntime.deleteMany({ where: { productionRunId: runId } });
  await tx.productionRunMachine.deleteMany({ where: { productionRunId: runId } });

  // Loaded after the reversal, so inputs are costed at the replayed WAC.
  const { itemMap, inputs: costedInputs } = await loadProductionCostContext(tx, body, {
    bypassLog: 'Production edit input with negative stock bypass',
  });
  const costing = computeProductionCosting({
    inputs: body.inputs.map((input, i) => ({ quantity: input.quantity, unitCost: costedInputs[i]!.unitCost })),
    outputs: body.outputs,
    costs: body.costs,
    hppOverride: body.hppOverride,
  });
  const { computedHpp, resolvedCosts, totalMaterialCost, totalCostInputSide, totalCostOutputSide, totalByproductValue } = costing;

  await tx.productionRun.update({
    where: { id: runId },
    data: {
      date: txDate,
      notes: body.notes || null,
      referenceType: body.referenceType || null,
      referenceId: body.referenceId || null,
      referenceNumber: body.referenceNumber || null,
      yieldPct: costing.yieldPct,
      // OEE capture fields, cleared when omitted. Single machineId/startAt/endAt are
      // kept for backward compat only.
      machineId: body.machineId ?? null,
      shift: body.shift ?? null,
      shiftLead: body.shiftLead ?? null,
      manpowerCount: body.manpowerCount ?? null,
      startAt: body.startAt ? new Date(body.startAt) : null,
      endAt: body.endAt ? new Date(body.endAt) : null,
      plannedStart: body.plannedStart ? new Date(body.plannedStart) : null,
      plannedEnd: body.plannedEnd ? new Date(body.plannedEnd) : null,
      breakStart: body.breakStart ? new Date(body.breakStart) : null,
      breakEnd: body.breakEnd ? new Date(body.breakEnd) : null,
      // good_qty/reject_qty columns are unused; OEE quality/output is derived from
      // the run's item lines (persistOeeInTx).
      fiscalYearId: fiscalYear.id,
    },
  });

  const productionWarehouseId = await resolveWarehouseId(tx, body.warehouseId);
  if (!productionWarehouseId) {
    throw new BusinessError(
      'Gudang produksi wajib dipilih. Pilih gudang di form atau set salah satu gudang sebagai default.',
    );
  }

  // Inputs
  for (let i = 0; i < body.inputs.length; i++) {
    const input = body.inputs[i]!;
    const line = costing.inputLines[i]!;
    await tx.inventoryItem.update({
      where: { id: input.itemId },
      data: { currentStock: { decrement: input.quantity } },
    });
    await adjustWarehouseStock(tx, input.itemId, productionWarehouseId, -input.quantity);

    const movNumber = await generateDocumentNumber(tx, 'SM', txDate, fiscalYear.id);
    await tx.stockMovement.create({
      data: {
        movementNumber: movNumber,
        date: txDate,
        itemId: input.itemId,
        warehouseId: productionWarehouseId,
        movementType: 'Out',
        quantity: input.quantity,
        unitCost: line.unitCost,
        totalValue: line.totalValue,
        sourceMovementId: costedInputs[i]!.sourceMovementId,
        referenceType: 'ProductionRun',
        referenceId: runId,
        referenceNumber: oldRun.runNumber,
        notes: body.notes || null,
        fiscalYearId: fiscalYear.id,
        createdById: userId,
      },
    });
  }

  if (costing.clampedNegativeNumerator) {
    logger.warn(
      {
        runId,
        totalMaterialCost: totalMaterialCost.toString(),
        totalCostInputSide: totalCostInputSide.toString(),
        totalCostOutputSide: totalCostOutputSide.toString(),
        totalByproductValue: totalByproductValue.toString(),
      },
      'Edit: loaded HPP numerator negative (by-product NRV > total cost) — clamped to 0',
    );
  }

  // Outputs
  for (let i = 0; i < body.outputs.length; i++) {
    const output = body.outputs[i]!;
    const { unitCost, totalValue, unitCostLoaded } = costing.outputLines[i]!;
    const outputItem = await tx.inventoryItem.findUnique({ where: { id: output.itemId } });
    const newAvgCost = outputItem && unitCost > 0
      ? calcWeightedAverage(outputItem.currentStock, outputItem.averageCost, output.quantity, unitCost)
      : undefined;

    await tx.inventoryItem.update({
      where: { id: output.itemId },
      data: {
        currentStock: { increment: output.quantity },
        ...(newAvgCost !== undefined ? { averageCost: newAvgCost } : {}),
      },
    });
    await adjustWarehouseStock(tx, output.itemId, productionWarehouseId, output.quantity);

    const movNumber = await generateDocumentNumber(tx, 'SM', txDate, fiscalYear.id);
    await tx.stockMovement.create({
      data: {
        movementNumber: movNumber,
        date: txDate,
        itemId: output.itemId,
        warehouseId: productionWarehouseId,
        movementType: 'In',
        quantity: output.quantity,
        unitCost,
        totalValue,
        unitCostLoaded,
        referenceType: 'ProductionRun',
        referenceId: runId,
        referenceNumber: oldRun.runNumber,
        notes: body.notes || null,
        fiscalYearId: fiscalYear.id,
        createdById: userId,
      },
    });

    await settleCogsBackfillForItem(tx, {
      itemId: output.itemId,
      qtyAvailable: output.quantity,
      unitCostNow: unitCost,
      userId,
      settleDate: txDate,
      source: { type: 'ProductionRun', refId: runId, refNo: oldRun.runNumber },
    });
  }

  const defaultInvAccount = await systemAccounts.getAccount('INVENTORY');
  const inputNames = body.inputs.map((i) => itemMap.get(i.itemId)?.name || '').join(', ');
  const outputNames = body.outputs.map((o) => itemMap.get(o.itemId)?.name || '').join(', ');

  const journalItems = await productionJournalLines(tx, {
    plan: costing.journalPlan,
    inputs: body.inputs,
    outputs: body.outputs,
    itemMap,
    defaultAccountId: defaultInvAccount.id,
    runNumber: oldRun.runNumber,
  });

  if (journalItems.length > 0) {
    const journalEntry = await tx.journalEntry.create({
      data: {
        entryNumber: await nextRevisionNumber(tx, oldJvNumber),
        date: txDate,
        narration: `Produksi (revisi): ${oldRun.runNumber} (${inputNames} → ${outputNames})`,
        status: 'Submitted',
        fiscalYearId: fiscalYear.id,
        createdBy: userId,
        submittedAt: new Date(),
        items: { create: journalItems },
      },
    });

    await tx.accountingLedgerEntry.createMany({
      data: journalItems.map((ji) => ({
        date: txDate,
        accountId: ji.accountId,
        debit: ji.debit,
        credit: ji.credit,
        referenceType: 'JournalEntry',
        referenceId: journalEntry.id,
        description: ji.description,
        fiscalYearId: fiscalYear.id,
      })),
    });
  }

  // Recompute balances from authoritative JE sums.
  const allRelatedJEItems = await tx.journalItem.findMany({
    where: { journalEntry: journalFamilyWhere(oldJvNumber) },
    select: { accountId: true },
  });
  const affectedAccountIds = [...new Set(allRelatedJEItems.map((ji) => ji.accountId))];
  if (affectedAccountIds.length > 0) {
    await recalculateAccountBalances(tx, affectedAccountIds);
  }

  await tx.productionRunItem.createMany({
    data: buildProductionRunLineItems({
      runId,
      warehouseId: productionWarehouseId,
      inputs: body.inputs,
      outputs: body.outputs,
      batchSnapshots: costedInputs,
      outputCosting: costing.outputLines,
    }),
  });

  // Persist cost component snapshots + HPP breakdown on the run.
  if (resolvedCosts.length > 0) {
    await tx.productionRunCost.createMany({
      data: resolvedCosts.map((c) => ({
        productionRunId: runId,
        standardId: c.standardId ?? null,
        description: c.description,
        costSide: c.costSide,
        basis: c.basis,
        rate: c.rate,
        qtyBasis: c.qtyBasis.toDecimalPlaces(3).toNumber(),
        totalAmount: c.totalAmount.toNumber(),
        costAccountId: c.costAccountId ?? null,
      })),
    });
  }

  // OEE: recreate downtime + machine rows (old ones cleared above); quality/output is
  // derived from the run's item lines, no manual good/reject.
  await persistOeeInTx(tx, runId, {
    plannedStart: body.plannedStart,
    plannedEnd: body.plannedEnd,
    breakStart: body.breakStart,
    breakEnd: body.breakEnd,
    runMachines: body.runMachines,
    downtimes: body.downtimes,
    inputQty: costing.totalInputQty,
    produkQty: costing.totalMainOutputQty,
    sampingQty: costing.byProductQty,
  });

  await tx.productionRun.update({
    where: { id: runId },
    data: {
      totalMaterialCost: totalMaterialCost.toDecimalPlaces(4).toNumber(),
      totalCostInputSide: totalCostInputSide.toDecimalPlaces(4).toNumber(),
      totalCostOutputSide: totalCostOutputSide.toDecimalPlaces(4).toNumber(),
      totalByproductValue: totalByproductValue.toDecimalPlaces(4).toNumber(),
      computedHpp: computedHpp ? computedHpp.toNumber() : null,
      hppManualOverride: costing.hppOverridden,
    },
  });

  // Re-persist process selections (already cleared above).
  if (body.processIds && body.processIds.length > 0) {
    const uniqueIds = Array.from(new Set(body.processIds));
    await tx.productionRunProcess.createMany({
      data: uniqueIds.map(processId => ({ productionRunId: runId, processId })),
      skipDuplicates: true,
    });
  }

  return tx.productionRun.findUnique({
    where: { id: runId },
    include: {
      items: { include: { item: { select: { id: true, name: true, unit: true, code: true } } } },
    },
  });
}
