// Monthly period lock (services/periodLock.ts). Mounted at /api/period-lock behind
// requirePerm('journal'), not under /api/fiscal-years: that mount needs the settings right, which
// would turn away a non-Admin role an Admin granted period.lock to.
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AuthRequest, requireCap } from '../middleware/auth';
import { validateBody } from '../utils/validate';
import { SetPeriodLockSchema } from '../utils/schemas';
import { handleRouteError } from '../utils/errors';
import { getPeriodLock, setPeriodLockInTx } from '../services/periodLock';

const router = Router();

// GET /api/period-lock — current lock date and the last 50 changes.
router.get('/', async (_req, res) => {
  try {
    return res.json(await getPeriodLock(prisma));
  } catch (error) {
    return handleRouteError(res, error, 'GET /period-lock', 'Gagal mengambil kunci periode.');
  }
});

// PUT /api/period-lock — set, move or clear (lockDate null or clear: true) the lock date. Requires period.lock;
// a reason is required when the date moves back or is cleared.
router.put('/', requireCap('period.lock'), async (req: AuthRequest, res) => {
  const body = validateBody(SetPeriodLockSchema, req.body ?? {}, res);
  if (!body) return;
  try {
    const result = await prisma.$transaction(
      (tx: Prisma.TransactionClient) =>
        setPeriodLockInTx(tx, { lockDate: body.lockDate, reason: body.reason, userId: req.user!.userId }),
      { timeout: 15000 },
    );
    const message = !result.changed
      ? 'Kunci periode tidak berubah.'
      : result.lockDate === null
        ? 'Kunci periode dibuka.'
        : 'Kunci periode disimpan.';
    return res.json({ message, ...result });
  } catch (error) {
    return handleRouteError(res, error, 'PUT /period-lock', 'Gagal menyimpan kunci periode.');
  }
});

export default router;
