import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';
import { cancelTrail } from '../utils/cancelClaim';
import { assertPeriodOpen, assertPeriodsOpen } from '../utils/periodGuard';
import { resolveWarehouseId } from '../utils/warehouseStock';
import { logger } from '../lib/logger';
import type { SubmitProductionRunInput } from './productionRunSubmit';
import { computeProductionCosting } from './production/productionCosting';
import { loadProductionCostContext } from './production/productionCostContext';
import {
  clearProductionRunDetails,
  lockProductionStockInTx,
  persistProductionRunDetails,
  postProductionEffectsInTx,
  reverseProductionEffectsInTx,
} from './production/productionPosting';

type Tx = Prisma.TransactionClient;

/**
 * Edit a production run: undo its effects (movements and journals voided, record kept), re-cost
 * the new data and post it with a revision journal JV-{runNumber}-R{n}. Cancelled runs are
 * rejected. Balances move per journal line, through the cancel model and postJournal.
 */
export async function editProductionRunInTx(
  tx: Tx,
  runId: string,
  body: SubmitProductionRunInput,
  userId: string,
) {
  // Lock order (productionPosting.ts): the run row first, so a concurrent cancel or edit of the
  // same run waits here and then sees its outcome, then the items.
  await tx.$queryRaw`SELECT id FROM production_runs WHERE id = ${runId} FOR UPDATE`;
  const oldRun = await tx.productionRun.findUnique({ where: { id: runId } });
  if (!oldRun) throw new BusinessError('Data proses produksi tidak ditemukan.');
  if (oldRun.isCancelled) throw new BusinessError('Proses produksi yang sudah dibatalkan tidak bisa diedit.');

  // Old journals and auto-settle are voided and new ones posted on body.date: both periods must be
  // open. Checked before anything is reversed, and again here when an approved edit is executed.
  const txDate = new Date(body.date);
  if (isNaN(txDate.getTime())) throw new BusinessError('Format tanggal tidak valid.');
  await assertPeriodsOpen(tx, [{ date: oldRun.date }, { fiscalYearId: oldRun.fiscalYearId, date: oldRun.date }], 'produksi');
  const fiscalYear = await assertPeriodOpen(tx, { date: txDate }, 'produksi');

  const productionWarehouseId = await resolveWarehouseId(tx, body.warehouseId);
  if (!productionWarehouseId) {
    throw new BusinessError(
      'Gudang produksi wajib dipilih. Pilih gudang di form atau set salah satu gudang sebagai default.',
    );
  }
  // One lock for the old run's items and the new lines, before the reversal: the stock checked
  // after the reversal cannot change before commit.
  await lockProductionStockInTx(tx, { runId, warehouseId: productionWarehouseId, inputs: body.inputs, outputs: body.outputs });

  await reverseProductionEffectsInTx(tx, { id: runId, runNumber: oldRun.runNumber }, {
    mode: 'edit',
    allowNegativeStock: body.allowNegativeStock,
    negativeStockReason: body.negativeStockReason,
    userId,
    trail: cancelTrail(userId, 'Revisi produksi'),
  });
  await clearProductionRunDetails(tx, runId);

  // Loaded after the reversal, so inputs are checked against the restored stock and costed at the
  // replayed WAC.
  const { itemMap, inputs: costedInputs } = await loadProductionCostContext(tx, body, {
    warehouseId: productionWarehouseId,
    context: 'productionRun.edit',
    userId,
  });
  const costing = computeProductionCosting({
    inputs: body.inputs.map((input, i) => ({ quantity: input.quantity, unitCost: costedInputs[i]!.unitCost })),
    outputs: body.outputs,
    costs: body.costs,
    hppOverride: body.hppOverride,
  });

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

  if (costing.clampedNegativeNumerator) {
    logger.warn(
      {
        runId,
        totalMaterialCost: costing.totalMaterialCost.toString(),
        totalCostInputSide: costing.totalCostInputSide.toString(),
        totalCostOutputSide: costing.totalCostOutputSide.toString(),
        totalByproductValue: costing.totalByproductValue.toString(),
      },
      'Edit: loaded HPP numerator negative (by-product NRV > total cost) — clamped to 0',
    );
  }

  await postProductionEffectsInTx(tx, {
    run: { id: runId, runNumber: oldRun.runNumber },
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
    revision: true,
  });
  await persistProductionRunDetails(tx, runId, { body, warehouseId: productionWarehouseId, costedInputs, costing });

  return tx.productionRun.findUnique({
    where: { id: runId },
    include: {
      items: { include: { item: { select: { id: true, name: true, unit: true, code: true } } } },
    },
  });
}
