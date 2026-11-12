import type { Prisma } from '@prisma/client';
import { BusinessError } from '../../utils/errors';
import { generateDocumentNumber } from '../../utils/documentNumber';
import { calcWeightedAverage } from '../../utils/weightedAverage';
import { adjustWarehouseStock } from '../../utils/warehouseStock';
import { journalFamilyWhere } from '../../utils/journalFamily';
import type { CancelTrail } from '../../utils/cancelClaim';
import type { JournalLineInput } from '../../utils/journalLineRules';
import { logger } from '../../lib/logger';
import { systemAccounts } from '../systemAccounts';
import { settleCogsBackfillForItem } from '../cogsBackfillService';
import { reverseCogsSettlementsByTrigger } from '../cogsBackfillReverse';
import { recomputeAverageCostFromReplay } from '../averageCostRecompute';
import { persistOeeInTx } from '../oee';
import { buildProductionRunLineItems } from '../productionRunLines';
import { DOCUMENT_RULE } from '../ledger/accountGuard';
import { cancelJournalsInTx, findDocumentJournals } from '../ledger/cancelJournals';
import { postJournal } from '../ledger/postJournal';
import { productionDiffAccounts } from '../ledger/systemRoleAccounts';
import type { ProductionCosting, ProductionJournalPlan } from './productionCosting';
import type { CostedInput } from './productionCostContext';

/**
 * Production posting (E6-R1): the one place a run's effects are written and undone. Submit and edit
 * post through postProductionEffectsInTx, edit and cancel undo through reverseProductionEffectsInTx,
 * and the journal goes through postJournal (owner decision #14: source SYSTEM_DOC, the document
 * account rule, balances applied per line). Stock moves through three thin primitives
 * (consumeInput / receiveOutput / reverseRunMovements) that the inventory ledger replaces (PR-6.4e).
 */

type Tx = Prisma.TransactionClient;

interface RunRef {
  id: string;
  runNumber: string;
}

interface MovementContext {
  run: RunRef;
  date: Date;
  fiscalYearId: string;
  warehouseId: string;
  notes: string | null;
  userId: string;
}

/** Journal base number of a run; edits post `<base>-R<n>` revisions under it. */
export const productionJournalBase = (runNumber: string): string => `JV-${runNumber}`;

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

// ---------------------------------------------------------------------------------------------
// Stock primitives
// ---------------------------------------------------------------------------------------------

/** Stock out of one input line at its costed value, with its batch back-link. */
export async function consumeInput(
  tx: Tx,
  ctx: MovementContext,
  line: { itemId: string; quantity: number; unitCost: number; totalValue: number; sourceMovementId: string | null },
): Promise<void> {
  await tx.inventoryItem.update({
    where: { id: line.itemId },
    data: { currentStock: { decrement: line.quantity } },
  });
  await adjustWarehouseStock(tx, line.itemId, ctx.warehouseId, -line.quantity);

  const movementNumber = await generateDocumentNumber(tx, 'SM', ctx.date, ctx.fiscalYearId);
  await tx.stockMovement.create({
    data: {
      movementNumber,
      date: ctx.date,
      itemId: line.itemId,
      warehouseId: ctx.warehouseId,
      movementType: 'Out',
      quantity: line.quantity,
      unitCost: line.unitCost,
      totalValue: line.totalValue,
      // Batch back-link so /items/:id/batches can sum consumption from every source.
      sourceMovementId: line.sourceMovementId,
      referenceType: 'ProductionRun',
      referenceId: ctx.run.id,
      referenceNumber: ctx.run.runNumber,
      notes: ctx.notes,
      fiscalYearId: ctx.fiscalYearId,
      createdById: ctx.userId,
    },
  });
}

/** Stock in of one output line; a priced line (unit cost > 0) is blended into the item's WAC. */
export async function receiveOutput(
  tx: Tx,
  ctx: MovementContext,
  line: { itemId: string; quantity: number; unitCost: number; totalValue: number; unitCostLoaded: number | null },
): Promise<void> {
  const item = await tx.inventoryItem.findUnique({ where: { id: line.itemId } });
  const newAvgCost = item && line.unitCost > 0
    ? calcWeightedAverage(item.currentStock, item.averageCost, line.quantity, line.unitCost)
    : undefined;

  await tx.inventoryItem.update({
    where: { id: line.itemId },
    data: {
      currentStock: { increment: line.quantity },
      ...(newAvgCost !== undefined ? { averageCost: newAvgCost } : {}),
    },
  });
  await adjustWarehouseStock(tx, line.itemId, ctx.warehouseId, line.quantity);

  const movementNumber = await generateDocumentNumber(tx, 'SM', ctx.date, ctx.fiscalYearId);
  await tx.stockMovement.create({
    data: {
      movementNumber,
      date: ctx.date,
      itemId: line.itemId,
      warehouseId: ctx.warehouseId,
      movementType: 'In',
      quantity: line.quantity,
      unitCost: line.unitCost,
      totalValue: line.totalValue,
      unitCostLoaded: line.unitCostLoaded,
      referenceType: 'ProductionRun',
      referenceId: ctx.run.id,
      referenceNumber: ctx.run.runNumber,
      notes: ctx.notes,
      fiscalYearId: ctx.fiscalYearId,
      createdById: ctx.userId,
    },
  });
}

export type ProductionReversalMode = 'edit' | 'cancel';

export interface ReverseRunOptions {
  /** Edit and cancel word the insufficient-stock error differently. */
  mode: ProductionReversalMode;
  /** Skip the guard that an output's stock still covers its reversal; logged instead. */
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
}

function outputUsedMessage(mode: ProductionReversalMode, name: string, available: number, needed: number): string {
  const head = mode === 'edit' ? 'Tidak dapat mengedit' : 'Tidak dapat membatalkan';
  const tail = mode === 'edit' ? '' : ' Batalkan transaksi tersebut dulu.';
  return `${head}: stok '${name}' tidak mencukupi untuk pembalikan output (tersedia ${available}, perlu ${needed}). Output sudah dipakai produksi/penjualan berikutnya.${tail}`;
}

/**
 * Reverses the run's active stock movements (restores stock, marks them cancelled). Reversing an
 * output must not drive its stock negative unless bypassed. Returns the items touched.
 */
export async function reverseRunMovements(tx: Tx, runId: string, opts: ReverseRunOptions): Promise<Set<string>> {
  const movements = await tx.stockMovement.findMany({
    where: { referenceType: 'ProductionRun', referenceId: runId, isCancelled: false },
    include: { item: true },
  });

  const affectedItemIds = new Set<string>();
  for (const mov of movements) {
    const isIn = mov.movementType === 'In' || mov.movementType === 'AdjustmentIn';
    const isOut = mov.movementType === 'Out' || mov.movementType === 'AdjustmentOut';
    const qty = Number(mov.quantity);
    const available = Number(mov.item.currentStock);

    if (isIn && available < qty) {
      if (!opts.allowNegativeStock) {
        throw new BusinessError(outputUsedMessage(opts.mode, mov.item.name, available, qty));
      }
      logger.warn(
        { itemId: mov.itemId, itemName: mov.item.name, currentStock: available, reverseQty: qty, reason: opts.negativeStockReason },
        `Production ${opts.mode} reverse with negative stock bypass`,
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
  return affectedItemIds;
}

// ---------------------------------------------------------------------------------------------
// Accounts and journal
// ---------------------------------------------------------------------------------------------

export interface ProductionAccounts {
  /** Account per input line (same order): the item's own, else the INVENTORY mapping. */
  inputs: string[];
  /** Account per output line (same order). */
  outputs: string[];
  /** COGS, needed whenever the plan has a difference. */
  cogsId: string | null;
  /** PRODUCTION_CONVERSION, needed only for a gain. */
  conversionId: string | null;
}

/** Accounts the run's journal posts to. The account rule itself is postJournal's (DOCUMENT_RULE). */
export async function resolveProductionAccounts(
  tx: Tx,
  args: {
    plan: ProductionJournalPlan;
    inputs: ReadonlyArray<{ itemId: string }>;
    outputs: ReadonlyArray<{ itemId: string }>;
    itemMap: ReadonlyMap<string, { accountId: string | null }>;
  },
): Promise<ProductionAccounts> {
  const defaultInventoryId = (await systemAccounts.getAccount('INVENTORY')).id;
  const accountOf = (line: { itemId: string }) => args.itemMap.get(line.itemId)?.accountId || defaultInventoryId;
  const diff = args.plan.diff === 0 ? null : await productionDiffAccounts(tx, args.plan.diff);
  return {
    inputs: args.inputs.map(accountOf),
    outputs: args.outputs.map(accountOf),
    cogsId: diff?.cogs.id ?? null,
    conversionId: diff?.conversion?.id ?? null,
  };
}

/**
 * Journal lines of a run from its costing plan: CR each input and DR each output on its account,
 * then the difference to PRODUCTION_CONVERSION / COGS. Pure; an empty plan gives no lines.
 */
export function productionJournalLines(args: {
  plan: ProductionJournalPlan;
  accounts: ProductionAccounts;
  inputNames: ReadonlyArray<string>;
  outputNames: ReadonlyArray<string>;
  runNumber: string;
}): JournalLineInput[] {
  const { plan, accounts, runNumber } = args;
  const lines: JournalLineInput[] = [
    ...plan.inputCredits.map(({ index, amount }) => ({
      accountId: accounts.inputs[index]!,
      debit: 0,
      credit: amount,
      description: `Bahan baku keluar ${args.inputNames[index] ?? ''}: ${runNumber}`,
    })),
    ...plan.outputDebits.map(({ index, amount }) => ({
      accountId: accounts.outputs[index]!,
      debit: amount,
      credit: 0,
      description: `Produksi masuk ${args.outputNames[index] ?? ''}: ${runNumber}`,
    })),
  ];
  if (plan.diff === 0) return lines;
  if (plan.toConversion > 0) {
    lines.push({ accountId: accounts.conversionId!, debit: 0, credit: plan.toConversion, description: `Biaya konversi dibebankan: ${runNumber}` });
  }
  if (plan.toCogs > 0) {
    lines.push({ accountId: accounts.cogsId!, debit: 0, credit: plan.toCogs, description: `HPP konversi produksi: ${runNumber}` });
  }
  if (plan.loss > 0) {
    lines.push({ accountId: accounts.cogsId!, debit: plan.loss, credit: 0, description: `HPP rugi produksi: ${runNumber}` });
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Post and reverse
// ---------------------------------------------------------------------------------------------

export interface ProductionEffectsInput {
  run: RunRef;
  date: Date;
  /** The year the caller checked for `date`; postJournal verifies the journal lands in it. */
  fiscalYearId: string;
  warehouseId: string;
  notes: string | null;
  userId: string;
  inputs: ReadonlyArray<{ itemId: string; quantity: number }>;
  outputs: ReadonlyArray<{ itemId: string; quantity: number }>;
  costedInputs: ReadonlyArray<CostedInput>;
  costing: ProductionCosting;
  itemMap: ReadonlyMap<string, { name: string; accountId: string | null }>;
  /** true for an edit: the journal is the next `-R<n>` revision. */
  revision: boolean;
}

/**
 * Posts a run's effects: inputs out, outputs in (settling earlier negative-stock sales of the
 * output), then one journal through postJournal. A plan with no value posts no journal.
 */
export async function postProductionEffectsInTx(tx: Tx, input: ProductionEffectsInput): Promise<void> {
  const { run, costing } = input;
  const ctx: MovementContext = {
    run,
    date: input.date,
    fiscalYearId: input.fiscalYearId,
    warehouseId: input.warehouseId,
    notes: input.notes,
    userId: input.userId,
  };

  for (let i = 0; i < input.inputs.length; i++) {
    const line = costing.inputLines[i]!;
    await consumeInput(tx, ctx, {
      itemId: input.inputs[i]!.itemId,
      quantity: input.inputs[i]!.quantity,
      unitCost: line.unitCost,
      totalValue: line.totalValue,
      sourceMovementId: input.costedInputs[i]!.sourceMovementId,
    });
  }

  for (let i = 0; i < input.outputs.length; i++) {
    const output = input.outputs[i]!;
    const { unitCost, totalValue, unitCostLoaded } = costing.outputLines[i]!;
    await receiveOutput(tx, ctx, { itemId: output.itemId, quantity: output.quantity, unitCost, totalValue, unitCostLoaded });
    await settleCogsBackfillForItem(tx, {
      itemId: output.itemId,
      qtyAvailable: output.quantity,
      unitCostNow: unitCost,
      userId: input.userId,
      settleDate: input.date,
      source: { type: 'ProductionRun', refId: run.id, refNo: run.runNumber },
    });
  }

  const nameOf = (line: { itemId: string }) => input.itemMap.get(line.itemId)?.name || '';
  const inputNames = input.inputs.map(nameOf);
  const outputNames = input.outputs.map(nameOf);
  const accounts = await resolveProductionAccounts(tx, {
    plan: costing.journalPlan,
    inputs: input.inputs,
    outputs: input.outputs,
    itemMap: input.itemMap,
  });
  const lines = productionJournalLines({ plan: costing.journalPlan, accounts, inputNames, outputNames, runNumber: run.runNumber });
  if (lines.length === 0) return;

  const base = productionJournalBase(run.runNumber);
  await postJournal(tx, {
    date: input.date,
    narration: `Produksi${input.revision ? ' (revisi)' : ''}: ${run.runNumber} (${inputNames.join(', ')} → ${outputNames.join(', ')})`,
    lines,
    sourceType: 'SYSTEM_DOC',
    entryNumber: input.revision ? await nextRevisionNumber(tx, base) : base,
    createdBy: input.userId,
    accountRule: DOCUMENT_RULE,
    partyRule: 'off',
    expectFiscalYearId: input.fiscalYearId,
  });
}

export interface ReverseProductionOptions extends ReverseRunOptions {
  /** Stored on each voided journal. */
  trail?: CancelTrail;
}

/**
 * Undoes a run's effects for an edit or a cancel: reverse its movements, replay the WAC of every
 * touched item (inputs too: restored stock changes the base later inbound moves were blended
 * against; historical COGS stays), void its journals (JV-<run> and its revisions, balances
 * reversed per line) and reverse the COGS auto-settlements it triggered.
 */
export async function reverseProductionEffectsInTx(tx: Tx, run: RunRef, opts: ReverseProductionOptions): Promise<void> {
  const affectedItemIds = await reverseRunMovements(tx, run.id, opts);
  for (const itemId of affectedItemIds) {
    await recomputeAverageCostFromReplay(tx, itemId);
  }
  await cancelJournalsInTx(tx, await findDocumentJournals(tx, productionJournalBase(run.runNumber)), {
    label: 'produksi',
    trail: opts.trail,
  });
  await reverseCogsSettlementsByTrigger(tx, 'ProductionRun', run.id);
}

// ---------------------------------------------------------------------------------------------
// Run details
// ---------------------------------------------------------------------------------------------

export interface ProductionRunDetailsBody {
  inputs: ReadonlyArray<{ itemId: string; quantity: number }>;
  outputs: ReadonlyArray<{ itemId: string; quantity: number; isByProduct?: boolean }>;
  processIds?: string[];
  plannedStart?: Date | string | null;
  plannedEnd?: Date | string | null;
  breakStart?: Date | string | null;
  breakEnd?: Date | string | null;
  runMachines?: Array<{ machineId: string; startAt?: Date | string | null; endAt?: Date | string | null }>;
  downtimes?: Array<{ machineId?: string | null; category: string; reason?: string | null; durationMin: number }>;
}

/** Deletes the detail rows persistProductionRunDetails writes, before an edit re-persists them. */
export async function clearProductionRunDetails(tx: Tx, runId: string): Promise<void> {
  await tx.productionRunItem.deleteMany({ where: { productionRunId: runId } });
  await tx.productionRunCost.deleteMany({ where: { productionRunId: runId } });
  await tx.productionRunProcess.deleteMany({ where: { productionRunId: runId } });
  await tx.productionDowntime.deleteMany({ where: { productionRunId: runId } });
  await tx.productionRunMachine.deleteMany({ where: { productionRunId: runId } });
}

/**
 * Persists what the run records besides its stock and journal: line items, cost component
 * snapshots, OEE rows (quality/output derived from the item lines), the HPP breakdown on the run,
 * and the selected processes.
 */
export async function persistProductionRunDetails(
  tx: Tx,
  runId: string,
  args: {
    body: ProductionRunDetailsBody;
    warehouseId: string;
    costedInputs: ReadonlyArray<CostedInput>;
    costing: ProductionCosting;
  },
): Promise<void> {
  const { body, costing } = args;
  await tx.productionRunItem.createMany({
    data: buildProductionRunLineItems({
      runId,
      warehouseId: args.warehouseId,
      inputs: body.inputs,
      outputs: body.outputs,
      batchSnapshots: args.costedInputs,
      outputCosting: costing.outputLines,
    }),
  });

  if (costing.resolvedCosts.length > 0) {
    await tx.productionRunCost.createMany({
      data: costing.resolvedCosts.map((c) => ({
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
      totalMaterialCost: costing.totalMaterialCost.toDecimalPlaces(4).toNumber(),
      totalCostInputSide: costing.totalCostInputSide.toDecimalPlaces(4).toNumber(),
      totalCostOutputSide: costing.totalCostOutputSide.toDecimalPlaces(4).toNumber(),
      totalByproductValue: costing.totalByproductValue.toDecimalPlaces(4).toNumber(),
      computedHpp: costing.computedHpp ? costing.computedHpp.toNumber() : null,
      hppManualOverride: costing.hppOverridden,
    },
  });

  // Traceability: the master processes run (junction). Dedupe defensively.
  if (body.processIds && body.processIds.length > 0) {
    await tx.productionRunProcess.createMany({
      data: [...new Set(body.processIds)].map((processId) => ({ productionRunId: runId, processId })),
      skipDuplicates: true,
    });
  }
}
