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
import { businessDayRange, businessToday, parseDateParam } from '../utils/businessDate';
import { cancelTrail, claimCancel } from '../utils/cancelClaim';
import { cancelJournalsInTx, findDocumentJournals } from '../services/ledger/cancelJournals';
import { postJournal } from '../services/ledger/postJournal';
import { DOCUMENT_RULE } from '../services/ledger/accountGuard';
import type { JournalLineInput } from '../utils/journalLineRules';
import { logger } from '../lib/logger';
import type { Prisma } from '@prisma/client';
import { assertStockAvailable, lockInventoryRows, type LockedItem } from '../services/inventory/stockLocks';
import { postInbound, postOutbound, reverseDocumentMovements } from '../services/inventory/inventoryLedger';
import { postReversalValueJournals } from '../services/inventory/reversalValueJournal';
import { inventoryAccountFor } from '../services/inventory/itemAccount';
import { assertVarianceAccountUsable } from '../services/inventory/varianceAccount';
import { qtyAsOf } from '../services/inventory/stockAsOf';
import { firstString, parseListPaging, parseSort } from '../utils/listQuery';
import { INBOUND_TYPES } from '../services/stockMovementList';
import { VALUE_DP } from '../services/inventory/inventoryValueMath';
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

/**
 * Error code (409): the stock of a sent line as of the count date is no longer the stock the form
 * showed (expectedSystemStock): a movement was posted since the form loaded it. The answer lists the
 * lines; the user reloads the system stock and checks them again (E3-R11).
 */
export const OPNAME_STOCK_CHANGED = 'OPNAME_STOCK_CHANGED';

/**
 * Error code (409): a later active count of the same warehouse already counted one of the items, so
 * a count dated before it would book the same difference again (E3-R11). The user cancels the later
 * count first.
 */
export const OPNAME_LATER_COUNT_EXISTS = 'OPNAME_LATER_COUNT_EXISTS';

const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** |expected − as of| above this is a changed stock (quantities are stored to 3 decimals). */
const OPNAME_VERSION_TOLERANCE = new Decimal('0.0005');

/** Description prefix of a revaluation line in a count's journal (written before PR-6.8a removed count revaluation). */
const REVALUATION_LINE = 'Revaluasi nilai ';

export interface OpnameStockChange {
  itemId: string;
  itemName: string;
  expectedSystemStock: string;
  systemStock: string;
}

/** OPNAME_STOCK_CHANGED with the changed lines, so the form can mark and refresh them. */
export class OpnameStockChangedError extends BusinessError {
  constructor(readonly items: OpnameStockChange[]) {
    super(
      `Stok sistem ${items.length} item berubah sejak form dibuka (${items.map((i) => i.itemName).join(', ')}). Muat ulang stok sistem lalu periksa lagi barisnya.`,
      OPNAME_STOCK_CHANGED,
      409,
    );
    this.name = 'OpnameStockChangedError';
  }
}

/**
 * Refuses a count of an item a later active count of the same warehouse already counted: the stock
 * as of this date adds that count's own adjustment back, so this count would book the same
 * difference again and leave the later count's actual stock wrong. The user cancels the later count
 * first (409 OPNAME_LATER_COUNT_EXISTS). Runs after the item locks, so no later count commits in
 * between. "Later" is the as-of rule's next business day (stockAsOf.ts).
 */
async function assertNoLaterCount(
  tx: Prisma.TransactionClient,
  q: { warehouseId: string; itemIds: string[]; day: string },
): Promise<void> {
  const later = await tx.stockOpnameItem.findFirst({
    where: {
      itemId: { in: q.itemIds },
      OR: [{ warehouseId: q.warehouseId }, { warehouseId: null, stockOpname: { warehouseId: q.warehouseId } }],
      stockOpname: { status: 'Submitted', date: { gte: businessDayRange(q.day).lt } },
    },
    orderBy: { stockOpname: { date: 'desc' } },
    select: { item: { select: { name: true } }, stockOpname: { select: { opnameNumber: true } } },
  });
  if (!later) return;
  throw new BusinessError(
    `'${later.item.name}' sudah dihitung di stok opname ${later.stockOpname.opnameNumber} yang bertanggal sesudahnya. Batalkan stok opname itu dulu, lalu hitung ulang.`,
    OPNAME_LATER_COUNT_EXISTS,
    409,
  );
}

interface OpnameLine { itemId: string; difference: Decimal; totalValue: Decimal }

interface OpnameEffectsInput {
  opnameId: string;
  opnameNumber: string;
  date: Date;
  fiscalYearId: string;
  userId: string;
  warehouseId: string;
  items: Map<string, LockedItem>;
  lines: OpnameLine[];
}

/** DR `debitId` / CR `creditId` of a positive amount, or the other way round of a negative one. */
function pair(debitId: string, creditId: string, amount: Decimal, description: string): JournalLineInput[] {
  if (amount.isZero()) return [];
  const [dr, cr] = amount.gt(0) ? [debitId, creditId] : [creditId, debitId];
  const value = amount.abs().toString();
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
 * The count's stock and value through the value ledger (E3-R6), dated the count date, then its
 * journal JV-<opname> of the same amounts against Selisih Persediaan through postJournal
 * (assertVarianceAccountUsable: never the rounding account or a group):
 * - a surplus line: AdjustmentIn at |difference| x the average;
 * - a deficit line: AdjustmentOut valued by the ledger from the book.
 * Returns the posted movement of each line.
 */
async function postOpnameEffects(tx: Tx, i: OpnameEffectsInput) {
  const varianceAccount = await assertVarianceAccountUsable(tx);
  const journalLines: JournalLineInput[] = [];
  const posted: { itemId: string; movementId: string; unitCost: Decimal; value: Decimal }[] = [];
  const base = {
    date: i.date, fiscalYearId: i.fiscalYearId, createdById: i.userId, warehouseId: i.warehouseId,
    referenceType: OPNAME_REFERENCE_TYPE, referenceId: i.opnameId, referenceNumber: i.opnameNumber,
    offsetAccountId: varianceAccount.id,
  };

  for (const line of i.lines) {
    const item = i.items.get(line.itemId)!;
    const quantity = line.difference.abs();
    const notes = `Stok opname ${i.opnameNumber}: ${item.name}`;
    const movement = line.difference.gt(0)
      ? await postInbound(tx, { ...base, itemId: item.id, movementType: 'AdjustmentIn', quantity, value: line.totalValue, notes })
      : await postOutbound(tx, { ...base, itemId: item.id, movementType: 'AdjustmentOut', quantity, notes });
    posted.push({ itemId: item.id, movementId: movement.movement.id, unitCost: movement.unitCost, value: movement.valueDelta.abs() });
    const label = line.difference.gt(0) ? 'Surplus' : 'Defisit';
    journalLines.push(...pair(await itemInventoryAccount(tx, item), varianceAccount.id, movement.valueDelta, `${label} stok ${item.name}: ${i.opnameNumber}`));
  }

  if (journalLines.length > 0) {
    await postJournal(tx, {
      date: i.date,
      narration: `Penyesuaian stok opname: ${i.opnameNumber}`,
      lines: journalLines,
      sourceType: 'SYSTEM_DOC',
      createdBy: i.userId,
      // The cancel finds and voids the count's journal by this number (findDocumentJournals).
      entryNumber: `JV-${i.opnameNumber}`,
      accountRule: DOCUMENT_RULE,
      partyRule: 'off',
      expectFiscalYearId: i.fiscalYearId,
    });
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

// GET /api/stock-opname/system-stock?warehouseId&date — the form's "stok sistem per tanggal"
// (E3-R11): each active item's stock in the warehouse as of the end of `date` (default today, WIB),
// plus inactive items still holding stock then. The form sends it back as expectedSystemStock.
// → { warehouseId, date, items: [{ itemId, code, name, unit, systemStock }] } by item code.
// Defined before '/:id' so the path is not taken as an id.
router.get('/system-stock', async (req, res) => {
  try {
    const warehouseId = firstString((req.query as Record<string, unknown>).warehouseId);
    if (!warehouseId || !UUID_RE.test(warehouseId)) return res.status(400).json({ error: 'Gudang opname wajib dipilih.' });
    const day = parseDateParam(req.query.date);
    if (day === null) return res.status(400).json({ error: 'Parameter date tidak valid.' });
    const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true } });
    if (!warehouse) return res.status(400).json({ error: 'Gudang opname tidak ditemukan.' });
    const date = day ?? businessToday();

    const items = await prisma.inventoryItem.findMany({
      select: { id: true, code: true, name: true, unit: true, isActive: true },
      orderBy: { code: 'asc' },
    });
    const stock = await qtyAsOf(prisma, { warehouseId, itemIds: items.map((i) => i.id), day: date });
    const rows = items
      .map((i) => ({ itemId: i.id, code: i.code, name: i.name, unit: i.unit, isActive: i.isActive, systemStock: stock.get(i.id)!.toNumber() }))
      .filter((r) => r.isActive || r.systemStock !== 0)
      .map(({ isActive: _isActive, ...r }) => r);
    return res.json({ warehouseId, date, items: rows });
  } catch (error) {
    return handleRouteError(res, error, 'GET /stock-opname/system-stock', 'Gagal mengambil stok sistem per tanggal.');
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

// POST /api/stock-opname — Create and submit in one step (E3-R11)
// Body: { date, warehouseId, notes?, items: [{ itemId, actualStock, expectedSystemStock, notes? }] }:
// only the lines the user changed. systemStock is the warehouse stock as of the count date
// (stockAsOf); a line whose stock differs from expectedSystemStock refuses the count (409
// OPNAME_STOCK_CHANGED + items). Differences post on the count date.
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateStockOpnameSchema, req.body, res);
  if (!body) return;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // UTC midnight of the date: inside its business day (WIB), so movements and the journal fall on it.
      const txDate = new Date(body.date);
      const fiscalYear = await getOpenFiscalYear(tx, txDate);
      const userId = req.user!.userId;

      const existingDraft = await tx.stockOpname.findFirst({ where: { status: 'Draft' as any } });
      if (existingDraft) throw new BusinessError('Masih ada stok opname Draft yang belum selesai.');

      const warehouseId = body.warehouseId;
      const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { isActive: true } });
      if (!warehouse) throw new BusinessError('Gudang opname tidak ditemukan.');
      if (!warehouse.isActive) throw new BusinessError('Gudang tidak aktif.');

      // Lock every counted item (and its row at the warehouse) before reading the stock as of the
      // date, so no movement can commit between that read and the count's own posting. Only
      // existing rows are locked; the ledger creates one for a surplus.
      const itemIds = body.items.map((i) => i.itemId);
      const locked = await lockInventoryRows(tx, {
        itemIds,
        pairs: itemIds.map((itemId) => ({ itemId, warehouseId })),
        createMissing: false,
      });
      const missing = itemIds.find((id) => !locked.items.has(id));
      if (missing) throw new BusinessError(`Item dengan ID ${missing} tidak ditemukan.`);
      await assertNoLaterCount(tx, { warehouseId, itemIds, day: body.date });

      const systemStock = await qtyAsOf(tx, { warehouseId, itemIds, day: body.date });
      const changed = body.items.filter((l) => systemStock.get(l.itemId)!.minus(l.expectedSystemStock).abs().gt(OPNAME_VERSION_TOLERANCE));
      if (changed.length > 0) {
        throw new OpnameStockChangedError(changed.map((l) => ({
          itemId: l.itemId,
          itemName: locked.items.get(l.itemId)!.name,
          expectedSystemStock: new Decimal(l.expectedSystemStock).toString(),
          systemStock: systemStock.get(l.itemId)!.toString(),
        })));
      }

      const lines = body.items.map((input) => {
        const item = locked.items.get(input.itemId)!;
        const system = systemStock.get(input.itemId)!.toDecimalPlaces(3);
        const difference = new Decimal(input.actualStock).minus(system).toDecimalPlaces(3);
        return {
          itemId: input.itemId,
          system,
          actualStock: input.actualStock,
          difference,
          // A surplus comes in at the average; a deficit's cost and value are the ledger's (set below).
          unitCost: item.averageCost,
          totalValue: difference.abs().times(item.averageCost).toDecimalPlaces(VALUE_DP),
          notes: input.notes || null,
        };
      });
      const withDiff = lines.filter((l) => !l.difference.isZero());

      // A count dated in the past takes its deficit out of today's stock: the warehouse must still
      // hold it (the stock that left since was counted as there).
      await assertStockAvailable(
        tx,
        withDiff.filter((l) => l.difference.lt(0)).map((l) => ({ itemId: l.itemId, warehouseId, quantity: l.difference.abs() })),
        { context: 'stockOpname.create', userId },
      );

      // Numbers after the item locks (LOCK ORDER in services/inventory/stockLocks.ts).
      const opnameNumber = await generateDocumentNumber(tx, 'SO', txDate, fiscalYear.id);
      const so = await tx.stockOpname.create({
        data: {
          opnameNumber,
          date: txDate,
          status: 'Submitted' as any,
          notes: body.notes || null,
          warehouseId,
          fiscalYearId: fiscalYear.id,
          createdById: userId,
          submittedAt: new Date(),
          items: {
            create: lines.map((l) => ({
              itemId: l.itemId, warehouseId, systemStock: l.system.toString(), actualStock: l.actualStock,
              difference: l.difference.toString(), unitCost: l.unitCost.toString(), totalValue: l.totalValue.toString(), notes: l.notes,
            })),
          },
        },
      });

      if (withDiff.length > 0) {
        const posted = await postOpnameEffects(tx, {
          opnameId: so.id, opnameNumber, date: txDate, fiscalYearId: fiscalYear.id, userId,
          warehouseId, items: locked.items, lines: withDiff,
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
          warehouse: { select: { id: true, code: true, name: true } },
          items: {
            include: { item: { select: { id: true, name: true, code: true, unit: true } } },
            orderBy: { item: { code: 'asc' } },
          },
        },
      });
    }, { timeout: 30000 });

    return res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof OpnameStockChangedError) {
      return res.status(409).json({ error: error.message, code: error.code, items: error.items });
    }
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
      // When goods of the item went out since, the value they took differently comes back as a
      // true-up against COGS, and value left at zero stock is swept to COGS (E3-R8), journalled
      // before the count's journal is voided (lock order): book = GL.
      const reversed = await reverseDocumentMovements(
        tx, { referenceType: OPNAME_REFERENCE_TYPE, referenceId: so.id }, { userId: req.user!.userId, trueUp: 'replay', sweepAtZero: true },
      );
      await postReversalValueJournals(tx, reversed, { userId: req.user!.userId, documentLabel: `stok opname ${so.opnameNumber}` });

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
