import { Router } from 'express';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { CreateStockOpnameSchema } from '../utils/schemas';
import { BusinessError, handleRouteError } from '../utils/errors';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { assertPeriodsOpen } from '../utils/periodGuard';
import { recalculateAccountBalances } from '../utils/accountBalance';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { cancelJournalsInTx, findDocumentJournals } from '../services/ledger/cancelJournals';
import { systemAccounts } from '../services/systemAccounts';
import { logger } from '../lib/logger';
import type { Prisma } from '@prisma/client';
import { resolveWarehouseId } from '../utils/warehouseStock';
import { assertStockAvailable, lockInventoryRows, stockKey, type LockedItem } from '../services/inventory/stockLocks';
import { postInbound, postOutbound, postRevaluation, reverseDocumentMovements } from '../services/inventory/inventoryLedger';
import { inventoryAccountFor } from '../services/inventory/itemAccount';
import { cogsAccountFor } from '../services/ledger/systemRoleAccounts';
import { firstString, parseListPaging, parseSort } from '../utils/listQuery';
import { INBOUND_TYPES } from '../services/stockMovementList';
import { UNIT_COST_DP, VALUE_DP } from '../services/inventory/inventoryValueMath';
import {
  buildStockOpnameWhere,
  DEFAULT_STOCK_OPNAME_SORT,
  OPNAME_REFERENCE_TYPE,
  mergeOpnameWarehouses,
  opnameWarehouses,
  STOCK_OPNAME_SORT_FIELDS,
  stockOpnameOrderBy,
  summarizeOpnameLines,
} from '../services/stockOpnameList';

type Tx = Prisma.TransactionClient;

/**
 * Error code (409): the stock count journaled a revaluation before the value ledger (no Revaluation
 * row records it), so cancelling it cannot take that value back; the accountant corrects it by a
 * journal.
 */
export const OPNAME_LEGACY_REVALUATION = 'OPNAME_LEGACY_REVALUATION';

/** Description prefix of a revaluation line in the count's journal (written here before and since the value ledger). */
const REVALUATION_LINE = 'Revaluasi nilai ';

interface JournalLine { accountId: string; debit: number; credit: number; description: string }

interface OpnameEffectsInput {
  opnameId: string;
  opnameNumber: string;
  date: Date;
  fiscalYearId: string;
  userId: string;
  warehouseId: string;
  items: Map<string, LockedItem>;
  lines: { itemId: string; difference: number; unitCost: number; totalValue: number }[];
  revaluations: { itemId: string; newCost: number }[];
}

/** DR `debitId` / CR `creditId` of a positive amount, or the other way round of a negative one. */
function pair(debitId: string, creditId: string, amount: Decimal, description: string): JournalLine[] {
  if (amount.isZero()) return [];
  const [dr, cr] = amount.gt(0) ? [debitId, creditId] : [creditId, debitId];
  const value = amount.abs().toNumber();
  return [
    { accountId: dr, debit: value, credit: 0, description },
    { accountId: cr, debit: 0, credit: value, description },
  ];
}

async function itemInventoryAccount(tx: Tx, item: LockedItem): Promise<string> {
  const accountId = await inventoryAccountFor(tx, item);
  if (!accountId) throw new BusinessError('Akun Persediaan belum dipetakan di Akun Sistem.');
  return accountId;
}

/**
 * The count's stock and value through the value ledger (E3-R6), then its journal JV-<opname> of
 * the same amounts against Selisih Persediaan:
 * - a surplus line: AdjustmentIn at the line cost (|difference| x unit cost);
 * - a deficit line: AdjustmentOut valued by the ledger from the book, not by the line cost;
 * - a typed unit cost (revaluation), after the quantity lines: the counted stock is revalued to
 *   that cost, delta = round(stock x cost, 2) − stock_value, through postRevaluation; a part stock
 *   cannot absorb goes to COGS in the same journal. With no stock on hand after the count there
 *   is nothing to revalue.
 * Returns the posted movement of each quantity line.
 */
async function postOpnameEffects(tx: Tx, i: OpnameEffectsInput) {
  const varianceAccount = await systemAccounts.getAccount('INVENTORY_VARIANCE');
  const journalLines: JournalLine[] = [];
  const posted: { itemId: string; movementId: string; unitCost: Decimal; value: Decimal }[] = [];
  const base = {
    date: i.date, fiscalYearId: i.fiscalYearId, createdById: i.userId, warehouseId: i.warehouseId,
    referenceType: OPNAME_REFERENCE_TYPE, referenceId: i.opnameId, referenceNumber: i.opnameNumber,
    offsetAccountId: varianceAccount.id,
  };

  for (const line of i.lines) {
    const item = i.items.get(line.itemId)!;
    const quantity = new Decimal(line.difference).abs();
    const notes = `Stok opname ${i.opnameNumber}: ${item.name}`;
    const movement = line.difference > 0
      ? await postInbound(tx, { ...base, itemId: item.id, movementType: 'AdjustmentIn', quantity, value: line.totalValue, notes })
      : await postOutbound(tx, { ...base, itemId: item.id, movementType: 'AdjustmentOut', quantity, notes });
    posted.push({ itemId: item.id, movementId: movement.movement.id, unitCost: movement.unitCost, value: movement.valueDelta.abs() });
    const label = line.difference > 0 ? 'Surplus' : 'Defisit';
    journalLines.push(...pair(await itemInventoryAccount(tx, item), varianceAccount.id, movement.valueDelta, `${label} stok ${item.name}: ${i.opnameNumber}`));
  }

  for (const rev of i.revaluations) {
    // The book after this count's quantity lines (lockInventoryRows reads the locked rows again).
    const item = (await lockInventoryRows(tx, { itemIds: [rev.itemId] })).items.get(rev.itemId)!;
    if (item.currentStock.lte(0)) continue;
    const delta = item.currentStock.times(rev.newCost).toDecimalPlaces(VALUE_DP).minus(item.stockValue);
    if (delta.isZero()) continue;
    const desc = `${REVALUATION_LINE}${item.name} (${item.averageCost.toString()} -> ${rev.newCost}): ${i.opnameNumber}`;
    const result = await postRevaluation(tx, {
      itemId: item.id, delta, date: i.date, fiscalYearId: i.fiscalYearId, createdById: i.userId,
      referenceType: OPNAME_REFERENCE_TYPE, referenceId: i.opnameId, referenceNumber: i.opnameNumber,
      notes: `Revaluasi stok opname ${i.opnameNumber}: ${item.name}`,
    });
    journalLines.push(...pair(await itemInventoryAccount(tx, item), varianceAccount.id, result.valueDelta, desc));
    if (!result.toCogs.isZero()) journalLines.push(...pair((await cogsAccountFor(tx)).id, varianceAccount.id, result.toCogs, desc));
  }

  if (journalLines.length > 0) {
    const journal = await tx.journalEntry.create({
      data: {
        entryNumber: `JV-${i.opnameNumber}`,
        date: i.date,
        narration: `Penyesuaian stok opname: ${i.opnameNumber}`,
        status: 'Submitted',
        fiscalYearId: i.fiscalYearId,
        createdBy: i.userId,
        submittedAt: new Date(),
        items: { create: journalLines },
      },
    });
    await tx.accountingLedgerEntry.createMany({
      data: journalLines.map((ji) => ({
        date: i.date, accountId: ji.accountId, debit: ji.debit, credit: ji.credit,
        referenceType: 'JournalEntry', referenceId: journal.id, description: ji.description, fiscalYearId: i.fiscalYearId,
      })),
    });
    // Recalculate balances from JE sums for affected accounts (prevents drift)
    await recalculateAccountBalances(tx, [...new Set(journalLines.map((ji) => ji.accountId))]);
  }
  return { lines: posted };
}

/**
 * Refuses the cancel of a count whose journal has a revaluation line but which owns no Revaluation
 * row: the value went into the average directly before the value ledger, so there is no row to
 * take back and voiding the journal alone would leave book ≠ GL.
 */
async function assertNoLegacyRevaluation(tx: Tx, opname: { id: string; opnameNumber: string }): Promise<void> {
  const journals = await findDocumentJournals(tx, `JV-${opname.opnameNumber}`);
  if (!journals.some((j) => j.items.some((line) => line.description?.startsWith(REVALUATION_LINE)))) return;
  const rows = await tx.stockMovement.count({
    where: { referenceType: OPNAME_REFERENCE_TYPE, referenceId: opname.id, movementType: 'Revaluation' },
  });
  if (rows > 0) return;
  throw new BusinessError(
    `Stok opname ${opname.opnameNumber} berisi revaluasi nilai dari sebelum buku nilai persediaan, jadi tidak dapat dibatalkan otomatis. `
      + 'Minta akuntan membuat jurnal koreksi.',
    OPNAME_LEGACY_REVALUATION,
    409,
  );
}

const router = Router();

// GET /api/stock-opname — List sessions
// Query: page, limit (default 20, ≤100), status, warehouseId, startDate,
// endDate (YYYY-MM-DD), search (number / notes / creator), sort (e.g. "-date").
// → { data, total, page, limit }; each row carries totalVariance + itemsWithDiff.
// Rows also carry `warehouses` when `page` is sent (list kit); without `page`
// and `sort` the response is byte-identical to the legacy endpoint.
router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const { page, limit: take, skip } = parseListPaging(query, { defaultLimit: 20, maxLimit: 100 });

    const warehouseId = firstString(query.warehouseId);
    const warehouseOpnameIds = warehouseId
      ? (
          await prisma.stockMovement.findMany({
            where: { referenceType: OPNAME_REFERENCE_TYPE, warehouseId, referenceId: { not: null } },
            select: { referenceId: true },
            distinct: ['referenceId'],
          })
        ).map((m) => m.referenceId as string)
      : undefined;

    const filter = buildStockOpnameWhere(query, { warehouseOpnameIds });
    if (!filter.ok) return res.status(400).json({ error: filter.error });
    const { where } = filter;
    // No `sort` → legacy order (date desc) so old callers see the same rows.
    const orderBy = firstString(query.sort)
      ? stockOpnameOrderBy(parseSort(query.sort, STOCK_OPNAME_SORT_FIELDS, DEFAULT_STOCK_OPNAME_SORT))
      : { date: 'desc' as const };

    const [data, total] = await Promise.all([
      prisma.stockOpname.findMany({
        where,
        include: {
          createdBy: { select: { fullName: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy,
        skip,
        take,
      }),
      prisma.stockOpname.count({ where }),
    ]);

    const ids = data.map((so) => so.id);
    const withWarehouses = query.page !== undefined;
    const [lines, movements] = await Promise.all([
      ids.length > 0
        ? prisma.stockOpnameItem.findMany({
            where: { stockOpnameId: { in: ids } },
            select: { stockOpnameId: true, difference: true, totalValue: true },
          })
        : [],
      withWarehouses && ids.length > 0
        ? prisma.stockMovement.findMany({
            where: { referenceType: OPNAME_REFERENCE_TYPE, referenceId: { in: ids } },
            select: { referenceId: true, warehouse: { select: { id: true, code: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          })
        : [],
    ]);
    const variance = summarizeOpnameLines(lines);
    const warehousesById = opnameWarehouses(movements);

    const result = data.map((so) => {
      const v = variance.get(so.id) ?? { totalVariance: 0, itemsWithDiff: 0 };
      const row = { ...so, totalVariance: v.totalVariance, itemsWithDiff: v.itemsWithDiff };
      return withWarehouses
        ? { ...row, warehouses: mergeOpnameWarehouses(so.warehouse, warehousesById.get(so.id) ?? []) }
        : row;
    });

    return res.json({ data: result, total, page, limit: take });
  } catch (error) {
    logger.error({ error }, 'GET /stock-opname error');
    return res.status(500).json({ error: 'Gagal mengambil data stok opname.' });
  }
});

// GET /api/stock-opname/:id — Get detail
router.get('/:id', async (req, res) => {
  try {
    const so = await prisma.stockOpname.findUnique({
      where: { id: req.params.id as string },
      include: {
        createdBy: { select: { fullName: true } },
        warehouse: { select: { id: true, code: true, name: true } },
        items: {
          include: {
            item: { select: { id: true, name: true, code: true, unit: true, currentStock: true, averageCost: true } },
          },
          orderBy: { item: { code: 'asc' } },
        },
      },
    });
    if (!so) return res.status(404).json({ error: 'Stok opname tidak ditemukan.' });
    return res.json(so);
  } catch (error) {
    logger.error({ error }, 'GET /stock-opname/:id error');
    return res.status(500).json({ error: 'Gagal mengambil detail stok opname.' });
  }
});

// POST /api/stock-opname — Create and submit in one step
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateStockOpnameSchema, req.body, res);
  if (!body) return;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const txDate = new Date(body.date);
      const fiscalYear = await getOpenFiscalYear(tx, txDate);

      // Check no other Draft exists
      const existingDraft = await tx.stockOpname.findFirst({ where: { status: 'Draft' as any } });
      if (existingDraft) throw new BusinessError('Masih ada stok opname Draft yang belum selesai.');

      // Stock opname applies to one warehouse per session. Prefer the
      // explicit pick from the UI; fall back to the default warehouse. The
      // header and every line keep it so the list shows Gudang even when
      // the count had no difference.
      const opnameWarehouseId = await resolveWarehouseId(tx, body.warehouseId);

      // Lock every counted item (and its row at the opname warehouse) before reading the system
      // stock, so a movement committing meanwhile cannot make the difference stale. systemStock is
      // the per-warehouse balance when the user picked a warehouse, else the item total. The form
      // sends every item: only existing rows are locked, so a count without a difference adds no
      // empty row to the warehouse (the ledger creates one for a difference).
      const allItemIds: string[] = body.items.map((i: any) => i.itemId);
      const locked = await lockInventoryRows(tx, {
        itemIds: allItemIds,
        pairs: opnameWarehouseId ? allItemIds.map((itemId) => ({ itemId, warehouseId: opnameWarehouseId })) : [],
        createMissing: false,
      });
      const itemMap = locked.items;
      // Numbers after the item locks (LOCK ORDER in services/inventory/stockLocks.ts).
      const opnameNumber = await generateDocumentNumber(tx, 'SO', txDate, fiscalYear.id);

      for (const input of body.items) {
        if (!itemMap.has(input.itemId)) {
          throw new BusinessError(`Item dengan ID ${input.itemId} tidak ditemukan.`);
        }
      }
      const warehouseStockOf = (itemId: string) =>
        Number(locked.stocks.get(stockKey(itemId, body.warehouseId!))?.currentStock ?? 0);

      // Revaluasi: item yang nilai satuannya diubah manual lewat form opname.
      const revaluations: { itemId: string; newCost: number }[] = [];

      // Build opname items with difference calculation
      const opnameItems = body.items.map((input: any) => {
        const item = itemMap.get(input.itemId)!;
        const systemStock = body.warehouseId ? warehouseStockOf(input.itemId) : item.currentStock.toNumber();
        const actualStock = input.actualStock;
        // Reject negatives only when the user changed this count: the form sends every item,
        // so untouched items that are already negative historically must not block submit.
        const diffFromSystem = new Decimal(actualStock).minus(new Decimal(systemStock)).toDecimalPlaces(3).toNumber();
        if (actualStock < 0 && diffFromSystem !== 0) {
          throw new BusinessError(`Stok aktual "${item.name}" tidak boleh negatif.`);
        }
        const diff = diffFromSystem;
        const oldCost = item.averageCost.toNumber();
        const hasManualCost = input.unitCost !== undefined && input.unitCost !== null;
        const unitCost = hasManualCost
          ? new Decimal(input.unitCost).toDecimalPlaces(UNIT_COST_DP).toNumber()
          : oldCost;
        if (hasManualCost && unitCost !== oldCost) {
          revaluations.push({ itemId: input.itemId, newCost: unitCost });
        }
        const totalValue = new Decimal(Math.abs(diff)).mul(new Decimal(unitCost)).toDecimalPlaces(2).toNumber();

        return {
          itemId: input.itemId,
          systemStock,
          actualStock,
          difference: diff,
          unitCost,
          totalValue,
          notes: input.notes || null,
        };
      });

      // Filter items with actual difference
      const itemsWithDiff = opnameItems.filter((i: any) => i.difference !== 0);
      // Opname perlu diproses kalau ada selisih qty ATAU ada revaluasi nilai.
      const needsProcessing = itemsWithDiff.length > 0 || revaluations.length > 0;

      // Create the StockOpname record
      const so = await tx.stockOpname.create({
        data: {
          opnameNumber,
          date: txDate,
          status: 'Submitted' as any,
          notes: body.notes || null,
          warehouseId: opnameWarehouseId,
          fiscalYearId: fiscalYear.id,
          createdById: req.user!.userId,
          submittedAt: new Date(),
          items: {
            create: opnameItems.map((line) => ({ ...line, warehouseId: opnameWarehouseId })),
          },
        },
      });

      // Process adjustments for items with difference / revaluation
      if (needsProcessing) {
        // Adjustments need a warehouse: force the user to pick one when no
        // default exists. (Multi-warehouse opname → one session per warehouse.)
        if (!opnameWarehouseId) {
          throw new BusinessError(
            'Gudang opname wajib dipilih. Pilih gudang di form atau set salah satu gudang sebagai default.',
          );
        }
        const posted = await postOpnameEffects(tx, {
          opnameId: so.id, opnameNumber, date: txDate, fiscalYearId: fiscalYear.id, userId: req.user!.userId,
          warehouseId: opnameWarehouseId, items: itemMap, lines: itemsWithDiff, revaluations,
        });

        // Link the movements and store each line's posted cost and value (a deficit is valued from the book).
        for (const line of posted.lines) {
          await tx.stockOpnameItem.updateMany({
            where: { stockOpnameId: so.id, itemId: line.itemId },
            data: { movementId: line.movementId, unitCost: line.unitCost.toString(), totalValue: line.value.toString() },
          });
        }
      }

      return tx.stockOpname.findUnique({
        where: { id: so.id },
        include: {
          createdBy: { select: { fullName: true } },
          items: {
            include: { item: { select: { id: true, name: true, code: true, unit: true } } },
            orderBy: { item: { code: 'asc' } },
          },
        },
      });
    }, { timeout: 30000 });

    return res.status(201).json(result);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /stock-opname', 'Gagal membuat stok opname.');
  }
});

// PUT /api/stock-opname/:id/cancel — Cancel and reverse all adjustments
router.put('/:id/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const id = req.params.id as string;

  try {
    await prisma.$transaction(async (tx) => {
      const so = await tx.stockOpname.findUnique({ where: { id } });
      if (!so) throw new BusinessError('Stok opname tidak ditemukan.');
      if (so.status === 'Cancelled') throw new BusinessError('Stok opname sudah dibatalkan.');
      if (so.status === 'Draft') throw new BusinessError('Stok opname Draft tidak perlu dibatalkan.');
      // First write: a second concurrent cancel gets STALE_STATUS here instead of reversing the
      // stock a second time. Any later rejection rolls the claim back.
      await claimCancel(tx.stockOpname, id, { status: 'Cancelled', cancelledAt: new Date() });
      await assertPeriodsOpen(tx, [{ date: so.date }, { fiscalYearId: so.fiscalYearId, date: so.date }], 'stok opname');

      await assertNoLegacyRevaluation(tx, so);

      // Every active row the count owns (its quantity lines and Revaluation rows) comes back at its
      // own value_delta, the amounts of the journal voided below, so book = GL. A row already
      // cancelled per row (possible before E3-R2) moved its stock back already and is skipped.
      const movements = await tx.stockMovement.findMany({
        where: { referenceType: OPNAME_REFERENCE_TYPE, referenceId: so.id, isCancelled: false },
        select: { id: true, itemId: true, warehouseId: true, movementType: true, quantity: true },
      });
      // Lock all items first, then check what the reversal takes out (surplus lines) per warehouse.
      await lockInventoryRows(tx, {
        itemIds: movements.map((m) => m.itemId),
        pairs: movements.flatMap((m) => (m.warehouseId ? [{ itemId: m.itemId, warehouseId: m.warehouseId }] : [])),
      });
      await assertStockAvailable(
        tx,
        movements
          .filter((m) => INBOUND_TYPES.includes(m.movementType))
          .map((m) => ({ itemId: m.itemId, warehouseId: m.warehouseId, quantity: m.quantity.toString() })),
        { context: 'stockOpname.cancel', userId: req.user!.userId, reversal: true },
      );
      // Refused with REVERSAL_NEEDS_TRUE_UP when goods of a surplus or revalued item went out since
      // (value true-up, PR-6.5a).
      await reverseDocumentMovements(tx, { referenceType: OPNAME_REFERENCE_TYPE, referenceId: so.id }, { userId: req.user!.userId });

      // Void the opname's journals (JV-<opnameNumber> and any satellites); balances are reversed per line.
      await cancelJournalsInTx(tx, await findDocumentJournals(tx, `JV-${so.opnameNumber}`), {
        label: 'stok opname',
        trail: cancelTrail(req.user!.userId),
      });

    }, { timeout: 15000 });

    return res.json({ message: 'Stok opname dibatalkan.' });
  } catch (error: any) {
    return handleRouteError(res, error, 'PUT /stock-opname/:id/cancel', 'Gagal membatalkan stok opname.');
  }
});

export default router;
