import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { updateAccountBalance } from '../utils/accountBalance';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { calcWeightedAverage } from '../utils/weightedAverage';
import { resolveWarehouseId, adjustWarehouseStock } from '../utils/warehouseStock';
import { systemAccounts } from './systemAccounts';
import { productionDiffAccounts } from './ledger/systemRoleAccounts';
import { settleCogsBackfillForItem } from './cogsBackfillService';
import { persistOeeInTx } from './oee';
import { logger } from '../lib/logger';
import { buildProductionRunLineItems } from './productionRunLines';
import { computeProductionCosting, type ProductionJournalPlan } from './production/productionCosting';
import { loadProductionCostContext } from './production/productionCostContext';

type Tx = Prisma.TransactionClient;

export interface SubmitProductionRunInput {
  date: string;
  // Optional: when caller provides a warehouseId we use it as the production
  // location. Otherwise resolveWarehouseId falls back to the default. One of
  // the two must resolve, else the service throws.
  warehouseId?: string | null;
  // Optional batch tracking: sourceMovementId is the picked inbound batch and batchUnitCost
  // locks its cost at pick time. Without them, costing falls back to WAC.
  inputs: Array<{
    itemId: string;
    quantity: number;
    sourceMovementId?: string | null;
    batchUnitCost?: number | null;
  }>;
  outputs: Array<{ itemId: string; quantity: number; unitPrice?: number | null; isByProduct?: boolean }>;
  // Cost components + HPP loading
  costs?: Array<{
    standardId?: string | null;
    description: string;
    costSide: 'InputSide' | 'OutputSide';
    basis: 'InputQty' | 'OutputQty' | 'Fixed';
    rate: number;
    costAccountId?: string | null;
  }>;
  hppOverride?: number | null;
  // Traceability: which master processes were run (multi-select, optional).
  processIds?: string[];
  notes?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceNumber?: string | null;
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
  // OEE tracking (all optional): run-level shift window + break (planned production time).
  plannedStart?: Date | string | null;
  plannedEnd?: Date | string | null;
  breakStart?: Date | string | null;
  breakEnd?: Date | string | null;
  // Machines running in parallel; OEE computed per machine + line aggregate.
  runMachines?: Array<{ machineId: string; startAt?: Date | string | null; endAt?: Date | string | null }>;
  shift?: string | null;
  shiftLead?: string | null;
  manpowerCount?: number | null;
  // OEE output is derived from the input/output item lines (no manual good/reject).
  downtimes?: Array<{ machineId?: string | null; category: string; reason?: string | null; durationMin: number }>;
  // Single-machine fields, ignored by the multi-machine OEE compute (kept nullable).
  machineId?: string | null;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
}

export interface ProductionJournalLine {
  accountId: string;
  debit: number;
  credit: number;
  description: string;
}

/**
 * Journal lines of a run from its costing plan: CR each input and DR each output on the item's
 * account (else INVENTORY), then the difference on the mapped PRODUCTION_CONVERSION / COGS
 * accounts. Submit and edit share it; PR-6.1c moves it into the production posting module.
 */
export async function productionJournalLines(
  tx: Tx,
  args: {
    plan: ProductionJournalPlan;
    inputs: ReadonlyArray<{ itemId: string }>;
    outputs: ReadonlyArray<{ itemId: string }>;
    itemMap: ReadonlyMap<string, { name: string; accountId: string | null }>;
    defaultAccountId: string;
    runNumber: string;
  },
): Promise<ProductionJournalLine[]> {
  const { plan, itemMap, defaultAccountId, runNumber } = args;
  const lines: ProductionJournalLine[] = [];
  for (const { index, amount } of plan.inputCredits) {
    const item = itemMap.get(args.inputs[index]!.itemId);
    lines.push({
      accountId: item?.accountId || defaultAccountId,
      debit: 0,
      credit: amount,
      description: `Bahan baku keluar ${item?.name || ''}: ${runNumber}`,
    });
  }
  for (const { index, amount } of plan.outputDebits) {
    const item = itemMap.get(args.outputs[index]!.itemId);
    lines.push({
      accountId: item?.accountId || defaultAccountId,
      debit: amount,
      credit: 0,
      description: `Produksi masuk ${item?.name || ''}: ${runNumber}`,
    });
  }
  if (plan.diff === 0) return lines;
  const { cogs, conversion } = await productionDiffAccounts(tx, plan.diff);
  if (plan.toConversion > 0) {
    lines.push({ accountId: conversion!.id, debit: 0, credit: plan.toConversion, description: `Biaya konversi dibebankan: ${runNumber}` });
  }
  if (plan.toCogs > 0) {
    lines.push({ accountId: cogs.id, debit: 0, credit: plan.toCogs, description: `HPP konversi produksi: ${runNumber}` });
  }
  if (plan.loss > 0) {
    lines.push({ accountId: cogs.id, debit: plan.loss, credit: 0, description: `HPP rugi produksi: ${runNumber}` });
  }
  return lines;
}

/**
 * Submit a production run: stock out per input, stock in per output with WAC recalc, settle
 * pending COGS backfill on outputs (earlier negative-stock sales), and post the production JE:
 * CR per input account, DR per output account, balanced via HPP accounts (see below).
 */
export async function submitProductionRunInTx(
  tx: Tx,
  body: SubmitProductionRunInput,
  userId: string,
) {
  const txDate = new Date(body.date);
  const fiscalYear = await getOpenFiscalYear(tx, txDate, { label: 'produksi' });

  const { itemMap, inputs: costedInputs } = await loadProductionCostContext(tx, body, {
    bypassLog: 'Production input submitted with negative stock bypass',
  });
  const costing = computeProductionCosting({
    inputs: body.inputs.map((input, i) => ({ quantity: input.quantity, unitCost: costedInputs[i]!.unitCost })),
    outputs: body.outputs,
    costs: body.costs,
    hppOverride: body.hppOverride,
  });
  const { computedHpp, resolvedCosts, totalMaterialCost, totalCostInputSide, totalCostOutputSide, totalByproductValue } = costing;

  const runNumber = await generateDocumentNumber(tx, 'PR', txDate, fiscalYear.id);

  const run = await tx.productionRun.create({
    data: {
      runNumber,
      date: txDate,
      notes: body.notes || null,
      referenceType: body.referenceType || null,
      referenceId: body.referenceId || null,
      referenceNumber: body.referenceNumber || null,
      yieldPct: costing.yieldPct,
      // OEE capture fields (optional). Single machineId/startAt/endAt are persisted for
      // backward compat but not used in the OEE compute below.
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
      createdById: userId,
    },
  });

  // A warehouse is required so inventory_stocks stays in sync with inventory_items.currentStock
  // (a null warehouse causes drift). Use body.warehouseId, else the default, else reject.
  const productionWarehouseId = await resolveWarehouseId(tx, body.warehouseId);
  if (!productionWarehouseId) {
    throw new BusinessError(
      'Gudang produksi wajib dipilih. Pilih gudang di form atau set salah satu gudang sebagai default.',
    );
  }

  // Inputs: stock-out + StockMovement Out
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
        // Batch back-link so /items/:id/batches can sum consumption from every source.
        sourceMovementId: costedInputs[i]!.sourceMovementId,
        referenceType: 'ProductionRun',
        referenceId: run.id,
        referenceNumber: runNumber,
        notes: body.notes || null,
        fiscalYearId: fiscalYear.id,
        createdById: userId,
      },
    });
  }

  if (costing.clampedNegativeNumerator) {
    logger.warn(
      {
        runNumber,
        totalMaterialCost: totalMaterialCost.toString(),
        totalCostInputSide: totalCostInputSide.toString(),
        totalCostOutputSide: totalCostOutputSide.toString(),
        totalByproductValue: totalByproductValue.toString(),
      },
      'Loaded HPP numerator negative (by-product NRV > total cost) — clamped to 0',
    );
  }

  // Outputs: stock-in + StockMovement In + WAC recalc + COGS backfill settlement
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
        referenceId: run.id,
        referenceNumber: runNumber,
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
      source: { type: 'ProductionRun', refId: run.id, refNo: runNumber },
    });
  }

  // GL posting: DR output accounts / CR input accounts / balance via HPP Beras.
  const defaultInvAccount = await systemAccounts.getAccount('INVENTORY');
  const inputNames = body.inputs.map((i) => itemMap.get(i.itemId)?.name || '').join(', ');
  const outputNames = body.outputs.map((o) => itemMap.get(o.itemId)?.name || '').join(', ');

  const jvNumber = `JV-${runNumber}`;
  const journalItems = await productionJournalLines(tx, {
    plan: costing.journalPlan,
    inputs: body.inputs,
    outputs: body.outputs,
    itemMap,
    defaultAccountId: defaultInvAccount.id,
    runNumber,
  });

  if (journalItems.length > 0) {
    const journalEntry = await tx.journalEntry.create({
      data: {
        entryNumber: jvNumber,
        date: txDate,
        narration: `Produksi: ${runNumber} (${inputNames} → ${outputNames})`,
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

    // Aggregate debit/credit per account to batch the balance updates.
    const balanceMap = new Map<string, { debit: number; credit: number }>();
    for (const ji of journalItems) {
      const entry = balanceMap.get(ji.accountId) || { debit: 0, credit: 0 };
      entry.debit += ji.debit;
      entry.credit += ji.credit;
      balanceMap.set(ji.accountId, entry);
    }
    for (const [acctId, bal] of balanceMap) {
      await updateAccountBalance(tx, acctId, bal.debit, bal.credit);
    }
  }

  // Persist line items for audit/record-keeping.
  await tx.productionRunItem.createMany({
    data: buildProductionRunLineItems({
      runId: run.id,
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
        productionRunId: run.id,
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

  // OEE: persist downtime + machine rows. Quality/output comes from item lines: inputQty = sum
  // of inputs, produkQty = main outputs only, sampingQty = by-products. No machines/time = null.
  await persistOeeInTx(tx, run.id, {
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
    where: { id: run.id },
    data: {
      totalMaterialCost: totalMaterialCost.toDecimalPlaces(4).toNumber(),
      totalCostInputSide: totalCostInputSide.toDecimalPlaces(4).toNumber(),
      totalCostOutputSide: totalCostOutputSide.toDecimalPlaces(4).toNumber(),
      totalByproductValue: totalByproductValue.toDecimalPlaces(4).toNumber(),
      computedHpp: computedHpp ? computedHpp.toNumber() : null,
      hppManualOverride: costing.hppOverridden,
    },
  });

  // Traceability: persist process selections (junction). Dedupe defensively.
  if (body.processIds && body.processIds.length > 0) {
    const uniqueIds = Array.from(new Set(body.processIds));
    await tx.productionRunProcess.createMany({
      data: uniqueIds.map(processId => ({ productionRunId: run.id, processId })),
      skipDuplicates: true,
    });
  }

  return tx.productionRun.findUnique({
    where: { id: run.id },
    include: {
      items: {
        include: {
          item: { select: { id: true, name: true, unit: true, code: true } },
        },
      },
    },
  });
}
