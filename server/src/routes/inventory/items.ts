import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthRequest } from '../../middleware/auth';
import { validateBody } from '../../utils/validate';
import { clearable } from '../../utils/clearable';
import { CreateInventoryItemSchema, UpdateInventoryItemSchema } from '../../utils/schemas';
import { BusinessError, handleRouteError } from '../../utils/errors';
import { parseListPaging, parseSort } from '../../utils/listQuery';
import {
  DEFAULT_ITEM_SORT,
  ITEM_SORT_FIELDS,
  filterByStockStatus,
  itemDbWhere,
  itemStockStatus,
  parseItemListFilters,
  sortItems,
  summarizeItems,
  usesListMode,
} from '../../services/inventoryItemList';
import { logger } from '../../lib/logger';
import { assertItemAccountValid, assertItemChangeAllowed, itemHoldsStock, ITEM_HAS_STOCK } from '../../services/inventory/itemMasterGuard';
import { listBatchAvailability } from '../../services/inventory/batchAvailability';

const router = Router();

// Loads items matching the DB filter; with `warehouseId` the `currentStock`
// of each item is replaced by its stock in that warehouse (0 if no row).
async function loadItems(where: Record<string, unknown>, warehouseId: string | undefined) {
  const allItems = await prisma.inventoryItem.findMany({
    where,
    include: { account: { select: { id: true, name: true, accountNumber: true } } },
  });
  if (!warehouseId) return allItems;
  const stockRows = await prisma.inventoryStock.findMany({
    where: { warehouseId, itemId: { in: allItems.map((i) => i.id) } },
    select: { itemId: true, currentStock: true },
  });
  const stockByItem = new Map(stockRows.map((s) => [s.itemId, s.currentStock]));
  return allItems.map((i) => ({
    ...i,
    currentStock: stockByItem.get(i.id) ?? 0,
  })) as typeof allItems;
}

// GET /api/inventory/items: with `warehouseId`, currentStock is that warehouse's stock (0 if no row), else the global total.
// Sending sort/stockStatus/category switches to list-page mode (services/inventoryItemList); pickers rely on the default response.
router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const parsed = parseItemListFilters(query);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    if (usesListMode(query)) {
      const { page, limit, skip } = parseListPaging(query, { defaultLimit: 100, maxLimit: 200 });
      const sort = parseSort(query.sort, ITEM_SORT_FIELDS, DEFAULT_ITEM_SORT);
      const loaded = await loadItems(itemDbWhere(filters), filters.warehouseId);
      const rows = sortItems(filterByStockStatus(loaded, filters.stockStatus), sort);
      const data = rows.slice(skip, skip + limit).map((i) => ({
        ...i,
        stockStatus: itemStockStatus(i.currentStock, i.minimumStock),
      }));
      return res.json({ data, total: rows.length, page, limit });
    }

    const { page = '1', limit = '100', search, isActive, warehouseId } = req.query;
    const take = Math.min(Number(limit) || 100, 200);
    const skip = (Number(page) - 1) * take;

    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { code: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      loadItems(where, typeof warehouseId === 'string' && warehouseId.length > 0 ? warehouseId : undefined),
      prisma.inventoryItem.count({ where }),
    ]);

    // Sort by current stock quantity descending
    items.sort((a, b) => Number(b.currentStock) - Number(a.currentStock));

    const paged = items.slice(skip, skip + take);
    return res.json({ data: paged, total, page: Number(page), limit: take });
  } catch (error) {
    logger.error({ error }, 'GET /inventory/items error');
    return res.status(500).json({ error: 'Gagal mengambil data item stok.' });
  }
});

// GET /api/inventory/items/summary — KPI totals for the same filters as the
// list (search, isActive, warehouseId, category, stockStatus). Same RBAC as
// the list (GET open to the inventory mount). Declared before /:id routes.
router.get('/summary', async (req, res) => {
  try {
    const parsed = parseItemListFilters(req.query as Record<string, unknown>);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;
    const [loaded, categoryRows] = await Promise.all([
      loadItems(itemDbWhere(filters), filters.warehouseId),
      prisma.inventoryItem.findMany({ distinct: ['category'], select: { category: true } }),
    ]);
    const rows = filterByStockStatus(loaded, filters.stockStatus);
    return res.json(summarizeItems(rows, categoryRows.map((r) => r.category)));
  } catch (error) {
    return handleRouteError(res, error, 'GET /inventory/items/summary', 'Gagal menghitung ringkasan item stok.');
  }
});

// GET /api/inventory/items/:id/batches?warehouseId=X: inbound batches (non-cancelled inbound movements) with remaining qty
// for the production batch picker (services/inventory/batchAvailability.ts, the rule production checks against).
router.get('/:id/batches', async (req, res) => {
  try {
    const itemId = req.params.id as string;
    const warehouseId = typeof req.query.warehouseId === 'string' && req.query.warehouseId.length > 0
      ? req.query.warehouseId
      : null;

    const listed = await listBatchAvailability(prisma, itemId, warehouseId);
    if (!listed) return res.status(404).json({ error: 'Item tidak ditemukan.' });

    const batches = listed.batches
      .filter((b) => b.available.gt(0.001))
      .map((b) => ({
        id: b.id,
        movementNumber: b.movementNumber,
        date: b.date,
        qtyInbound: b.quantity.toNumber(),
        unitCost: b.unitCost.toNumber(),
        qtyConsumed: b.consumed.toNumber(),
        qtyAvailable: b.available.toNumber(),
        sourceType: b.referenceType ?? 'Other',
        sourceRef: b.referenceNumber ?? null,
        sourceRefId: b.referenceId ?? null,
      }));
    return res.json({ data: batches, item: listed.item, currentStock: listed.currentStock.toNumber() });
  } catch (error) {
    logger.error({ error }, 'GET /inventory/items/:id/batches error');
    return res.status(500).json({ error: 'Gagal mengambil daftar batch stok.' });
  }
});

// POST /api/inventory/items
router.post('/', async (req: AuthRequest, res) => {
  const body = validateBody(CreateInventoryItemSchema, req.body, res);
  if (!body) return;

  try {
    const existing = await prisma.inventoryItem.findUnique({ where: { code: body.code } });
    if (existing) throw new BusinessError(`Kode item '${body.code}' sudah digunakan.`);

    const item = await prisma.$transaction(async (tx) => {
      await assertItemAccountValid(tx, body.accountId);
      return tx.inventoryItem.create({
        data: {
          code: body.code,
          name: body.name,
          unit: body.unit,
          category: body.category || null,
          description: body.description || null,
          minimumStock: body.minimumStock ?? 0,
          accountId: body.accountId || null,
        },
        include: { account: { select: { id: true, name: true, accountNumber: true } } },
      });
    });
    return res.status(201).json(item);
  } catch (error: any) {
    return handleRouteError(res, error, 'POST /inventory/items error', 'Gagal membuat item stok.');
  }
});

// PUT /api/inventory/items/:id
router.put('/:id', async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const body = validateBody(UpdateInventoryItemSchema, req.body, res);
  if (!body) return;

  try {
    const item = await prisma.$transaction(async (tx) => {
      // Serialises two edits of the item and the stock counter update of a posting. Posting paths read
      // accountId before they lock the item, so a posting already in flight can still land on the old account.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_items WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) return null;
      await assertItemChangeAllowed(tx, id, {
        unit: body.unit,
        isActive: body.isActive,
        accountId: body.accountId === undefined ? undefined : body.accountId || null,
      });
      return tx.inventoryItem.update({
        where: { id },
        data: {
          ...(body.code && { code: body.code }),
          ...(body.name && { name: body.name }),
          ...(body.unit && { unit: body.unit }),
          category: clearable(body.category),
          description: clearable(body.description),
          ...(body.minimumStock !== undefined && { minimumStock: body.minimumStock }),
          ...(body.accountId !== undefined && { accountId: body.accountId || null }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
        include: { account: { select: { id: true, name: true, accountNumber: true } } },
      });
    });
    if (!item) return res.status(404).json({ error: 'Item stok tidak ditemukan.' });
    return res.json(item);
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Item stok tidak ditemukan.' });
    return handleRouteError(res, error, 'PUT /inventory/items/:id error', 'Gagal mengupdate item stok.');
  }
});

// DELETE /api/inventory/items/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;

    const found = await prisma.$transaction(async (tx) => {
      // Same row lock as PUT, so a posting or an edit in flight cannot slip between the checks and the delete.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_items WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) return false;

      // Check if item has stock movements
      const movementCount = await tx.stockMovement.count({ where: { itemId: id, isCancelled: false } });
      if (movementCount > 0) {
        throw new BusinessError(
          `Item memiliki ${movementCount} mutasi stok aktif. Batalkan semua mutasi terlebih dahulu atau nonaktifkan item.`,
        );
      }

      // Check if item is used in purchase/sales invoice items
      const [purchaseUsage, salesUsage] = await Promise.all([
        tx.purchaseInvoiceItem.count({ where: { inventoryItemId: id } }),
        tx.salesInvoiceItem.count({ where: { inventoryItemId: id } }),
      ]);
      if (purchaseUsage > 0 || salesUsage > 0) {
        throw new BusinessError('Item sudah digunakan di invoice. Nonaktifkan item jika tidak ingin dipakai lagi.');
      }

      // Stock without an active movement behind it (drift) would vanish from the stock book with the item
      // and its warehouse rows, while the GL still carries the value.
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id }, select: { currentStock: true } });
      if (await itemHoldsStock(tx, id, item.currentStock)) {
        throw new BusinessError(
          'Item tidak dapat dihapus selama masih memiliki stok (termasuk stok negatif). Kosongkan stok di semua gudang atau nonaktifkan item.',
          ITEM_HAS_STOCK,
        );
      }

      // Safe to delete — also remove cancelled movements
      await tx.stockMovement.deleteMany({ where: { itemId: id } });
      await tx.inventoryItem.delete({ where: { id } });
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Item stok tidak ditemukan.' });

    return res.json({ message: 'Item stok dihapus.' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Item stok tidak ditemukan.' });
    return handleRouteError(res, error, 'DELETE /inventory/items/:id', 'Gagal menghapus item stok.');
  }
});

export default router;
