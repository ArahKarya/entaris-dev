import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { CreateServiceItemSchema, UpdateServiceItemSchema } from '../utils/schemas';
import { handleRouteError } from '../utils/errors';
import { logger } from '../lib/logger';
import { assertPostableAccount, type PostableRule } from '../services/ledger/accountGuard';
import { parseListPaging, parseSort } from '../utils/listQuery';
import {
  DEFAULT_SERVICE_ITEM_SORT,
  SERVICE_ITEM_SORT_FIELDS,
  buildServiceItemWhere,
  serviceItemOrderBy,
} from '../services/serviceItemList';

const router = Router();

/** The account a service is sold on: an active REVENUE detail account. */
const SERVICE_REVENUE_RULE: PostableRule = { label: 'Akun pendapatan layanan', rootTypes: ['REVENUE'] };

// GET /api/service-items
// Legacy (no `page`): { data } with every matching row, ordered by code.
// Paged (`page` sent): page, limit (≤200), isActive (true | false), search,
// sort (code | name | defaultRate, "-" = desc) → { data, total, page, limit }.
router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    if (query.page !== undefined) {
      const filter = buildServiceItemWhere(query);
      if (!filter.ok) return res.status(400).json({ error: filter.error });
      const { page, limit, skip } = parseListPaging(query, { defaultLimit: 25, maxLimit: 200 });
      const sort = parseSort(query.sort, SERVICE_ITEM_SORT_FIELDS, DEFAULT_SERVICE_ITEM_SORT);
      const [data, total] = await Promise.all([
        prisma.serviceItem.findMany({
          where: filter.where,
          include: { account: { select: { id: true, accountNumber: true, name: true } } },
          orderBy: serviceItemOrderBy(sort),
          skip,
          take: limit,
        }),
        prisma.serviceItem.count({ where: filter.where }),
      ]);
      return res.json({ data, total, page, limit });
    }

    const { search, isActive } = req.query;

    const where: Record<string, unknown> = {};
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) {
      where.OR = [
        { code: { contains: search as string, mode: 'insensitive' } },
        { name: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.serviceItem.findMany({
      where,
      include: { account: { select: { id: true, accountNumber: true, name: true } } },
      orderBy: { code: 'asc' },
    });

    return res.json({ data: items });
  } catch (error) {
    logger.error({ error }, 'GET /service-items error');
    return res.status(500).json({ error: 'Gagal mengambil data layanan.' });
  }
});

// POST /api/service-items
router.post('/', async (req, res) => {
  const body = validateBody(CreateServiceItemSchema, req.body, res);
  if (!body) return;

  try {
    const item = await prisma.$transaction(async (tx) => {
      await assertPostableAccount(tx, body.accountId, SERVICE_REVENUE_RULE);
      return tx.serviceItem.create({
        data: {
          code: body.code,
          name: body.name,
          unit: body.unit,
          defaultRate: body.defaultRate,
          accountId: body.accountId,
          description: body.description,
        },
        include: { account: { select: { id: true, accountNumber: true, name: true } } },
      });
    });

    return res.status(201).json(item);
  } catch (error: unknown) {
    return handleRouteError(res, error, 'POST /service-items', 'Gagal menyimpan layanan.');
  }
});

// PATCH /api/service-items/:id
router.patch('/:id', async (req, res) => {
  const body = validateBody(UpdateServiceItemSchema, req.body, res);
  if (!body) return;

  try {
    const id = req.params.id as string;
    const item = await prisma.$transaction(async (tx) => {
      if (body.accountId) {
        // Only a changed account is checked, so saving other fields of a service whose old
        // account no longer qualifies is not blocked.
        const current = await tx.serviceItem.findUnique({ where: { id }, select: { accountId: true } });
        if (current && current.accountId !== body.accountId) await assertPostableAccount(tx, body.accountId, SERVICE_REVENUE_RULE);
      }
      return tx.serviceItem.update({
        where: { id },
        data: body,
        include: { account: { select: { id: true, accountNumber: true, name: true } } },
      });
    });

    return res.json(item);
  } catch (error: unknown) {
    return handleRouteError(res, error, 'PATCH /service-items/:id', 'Gagal mengubah layanan.');
  }
});

// DELETE /api/service-items/:id (soft delete)
router.delete('/:id', requireCap('doc.cancel'), async (req, res) => {
  try {
    await prisma.serviceItem.update({
      where: { id: req.params.id as string },
      data: { isActive: false },
    });

    return res.json({ success: true });
  } catch (error: unknown) {
    return handleRouteError(res, error, 'DELETE /service-items/:id', 'Gagal menghapus layanan.');
  }
});

export default router;
