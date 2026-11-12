import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthRequest, requireCap } from '../../middleware/auth';
import { validateBody } from '../../utils/validate';
import { CreateStockMovementSchema, UpdateStockMovementSchema } from '../../utils/schemas';
import { handleRouteError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import {
  cancelManualMovementInTx,
  createManualMovementInTx,
  editManualMovementInTx,
} from '../../services/inventory/manualMovement';
import { parseListPaging, parseSort } from '../../utils/listQuery';
import {
  DEFAULT_STOCK_MOVEMENT_SORT,
  LEGACY_STOCK_MOVEMENT_ORDER,
  STOCK_MOVEMENT_SORT_FIELDS,
  buildStockMovementWhere,
  stockMovementOrderBy,
  summarizeStockMovements,
} from '../../services/stockMovementList';

const router = Router();

// GET /api/inventory/movements: paged list (limit <= 200), business-day date range.
// Without `sort` the order is movement number desc.
router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const { page, limit: take, skip } = parseListPaging(query, { defaultLimit: 50, maxLimit: 200 });
    const filter = buildStockMovementWhere(query);
    if (!filter.ok) return res.status(400).json({ error: filter.error });
    const { where } = filter;
    const orderBy = query.sort === undefined
      ? LEGACY_STOCK_MOVEMENT_ORDER
      : stockMovementOrderBy(parseSort(query.sort, STOCK_MOVEMENT_SORT_FIELDS, DEFAULT_STOCK_MOVEMENT_SORT));

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          item: { select: { id: true, name: true, code: true, unit: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          offsetAccount: { select: { id: true, name: true, accountNumber: true } },
        },
        orderBy,
        skip,
        take,
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return res.json({ data: movements, total, page, limit: take });
  } catch (error) {
    logger.error({ error }, 'GET /inventory/movements error');
    return res.status(500).json({ error: 'Gagal mengambil data gerakan stok.' });
  }
});

// GET /api/inventory/movements/summary — KPI totals (counts, qty & value in /
// out, cancelled) for the same filters as the list. Declared before /:id.
router.get('/summary', async (req, res) => {
  try {
    const filter = buildStockMovementWhere(req.query as Record<string, unknown>);
    if (!filter.ok) return res.status(400).json({ error: filter.error });
    const groups = await prisma.stockMovement.groupBy({
      by: ['movementType', 'isCancelled'],
      where: filter.where,
      _count: { _all: true },
      _sum: { quantity: true, totalValue: true },
    });
    return res.json(summarizeStockMovements(groups));
  } catch (error) {
    return handleRouteError(res, error, 'GET /inventory/movements/summary', 'Gagal menghitung ringkasan gerakan stok.');
  }
});

// POST /api/inventory/movements: manual movement (services/inventory/manualMovement.ts). Outbound
// rows are valued at the average cost; inbound rows need a unit cost > 0 and an offset account.
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateStockMovementSchema, req.body, res);
  if (!body) return;

  try {
    const result = await prisma.$transaction((tx) => createManualMovementInTx(tx, body, req.user!.userId), { timeout: 15000 });
    return res.status(201).json(result);
  } catch (error) {
    return handleRouteError(res, error, 'POST /inventory/movements', 'Gagal mencatat gerakan stok.');
  }
});

// GET /api/inventory/movements/:id — single movement for edit
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id as string;
    const movement = await prisma.stockMovement.findUnique({
      where: { id },
      include: {
        item: { select: { id: true, name: true, code: true, unit: true } },
        offsetAccount: { select: { id: true, name: true, accountNumber: true } },
      },
    });
    if (!movement) return res.status(404).json({ error: 'Gerakan stok tidak ditemukan.' });
    return res.json(movement);
  } catch (error) {
    return handleRouteError(res, error, 'GET /inventory/movements/:id', 'Gagal mengambil data gerakan stok.');
  }
});

// PUT /api/inventory/movements/:id — edit movement (reverse old + re-post)
router.put('/:id', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const body = validateBody(UpdateStockMovementSchema, req.body, res);
  if (!body) return;

  try {
    const result = await prisma.$transaction((tx) => editManualMovementInTx(tx, id, body, req.user!.userId), { timeout: 15000 });
    return res.json(result);
  } catch (error) {
    return handleRouteError(res, error, 'PUT /inventory/movements/:id', 'Gagal mengupdate gerakan stok.');
  }
});

// PUT /api/inventory/movements/:id/cancel
router.put('/:id/cancel', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const id = req.params.id as string;

  try {
    await prisma.$transaction((tx) => cancelManualMovementInTx(tx, id, req.user!.userId), { timeout: 15000 });
    return res.json({ message: 'Gerakan stok dibatalkan.' });
  } catch (error) {
    return handleRouteError(res, error, 'PUT /inventory/movements/:id/cancel', 'Gagal membatalkan gerakan stok.');
  }
});

export default router;
