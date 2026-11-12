import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { resolveWarehouseId } from '../utils/warehouseStock';
import { logger } from '../lib/logger';
import { computeProductionCosting } from './production/productionCosting';
import { loadProductionCostContext } from './production/productionCostContext';
import { persistProductionRunDetails, postProductionEffectsInTx } from './production/productionPosting';

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

/**
 * Submit a production run: load and cost it (productionCostContext, productionCosting), create the
 * run, then post its stock, COGS auto-settle and journal JV-<runNumber> (productionPosting).
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

  if (costing.clampedNegativeNumerator) {
    logger.warn(
      {
        runNumber,
        totalMaterialCost: costing.totalMaterialCost.toString(),
        totalCostInputSide: costing.totalCostInputSide.toString(),
        totalCostOutputSide: costing.totalCostOutputSide.toString(),
        totalByproductValue: costing.totalByproductValue.toString(),
      },
      'Loaded HPP numerator negative (by-product NRV > total cost) — clamped to 0',
    );
  }

  await postProductionEffectsInTx(tx, {
    run: { id: run.id, runNumber },
    date: txDate,
    fiscalYearId: fiscalYear.id,
    warehouseId: productionWarehouseId,
    notes: body.notes || null,
    userId,
    inputs: body.inputs,
    outputs: body.outputs,
    costedInputs,
    costing,
    itemMap,
    revision: false,
  });
  await persistProductionRunDetails(tx, run.id, { body, warehouseId: productionWarehouseId, costedInputs, costing });

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
