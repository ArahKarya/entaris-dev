// Diagnostic dashboard endpoints (mounted behind the audit permission). Checks only detect;
// the one fix left (stored-balance recalculation) needs doc.cancel. Check SQL and the
// preview/fix transaction (with its audit row) live in routes/health/*.ts; this file only dispatches
// and records a failed fix.
import { Router } from 'express';
import { AuthRequest, requireCap } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { handleRouteError } from '../utils/errors';
import {
  type CheckResult,
  checkAccountBalanceDrift,
  checkUnbalancedJournals,
  checkStockMovementMismatch,
  checkWarehouseStockDrift,
} from './health/checks';
import { checkAleSync, checkNonJournalAle, checkOrphanAle } from './health/aleChecks';
import { checkPartyOutstandingDrift } from './health/partyChecks';
import { checkRequiredTriggers } from './health/schemaGuards';
import { checkApSubledgerVsGl, checkArSubledgerVsGl, checkCustomerDepositVsGl } from './health/arChecks';
import { checkAleFiscalYear } from './health/fiscalYearChecks';
import { checkFormerRoleAccounts } from './health/formerRoleAccountChecks';
import { checkInventoryVarianceAccount, checkInventoryVsGl, checkStockValueInvariant } from './health/inventoryChecks';
import { FIX_ACTION, previewAccountBalanceDrift, fixAccountBalanceDrift } from './health/fixes';

const router = Router();

const DETECT_ONLY_MESSAGE = 'Pemeriksaan ini hanya mendeteksi. Koreksi lewat jurnal di periode berjalan atau skrip perbaikan.';

// GET /api/health-check: Run all diagnostic checks in parallel
router.get('/', async (_req, res) => {
  try {
    const checks: CheckResult[] = await Promise.all([
      checkAleSync(),
      checkAccountBalanceDrift(),
      checkUnbalancedJournals(),
      checkOrphanAle(),
      checkStockMovementMismatch(),
      checkWarehouseStockDrift(),
      checkInventoryVarianceAccount(),
      checkInventoryVsGl(),
      checkStockValueInvariant(),
      checkRequiredTriggers(),
      checkArSubledgerVsGl(),
      checkCustomerDepositVsGl(),
      checkApSubledgerVsGl(),
      checkAleFiscalYear(),
      checkFormerRoleAccounts(),
      checkNonJournalAle(),
      checkPartyOutstandingDrift(),
    ]);

    const overallStatus = checks.some((c) => c.status === 'error')
      ? 'error'
      : checks.some((c) => c.status === 'warning')
        ? 'warning'
        : 'ok';

    res.json({ success: true, data: { status: overallStatus, checks } });
  } catch (error) {
    logger.error(error, 'Health check failed');
    res.status(500).json({ success: false, error: 'Gagal menjalankan health check' });
  }
});

// GET /api/health-check/preview/:check: Preview what fix will change
router.get('/preview/:check', async (req, res) => {
  const check = String(req.params.check ?? '');

  try {
    if (check !== 'account-balance-drift') {
      return res.status(400).json({ success: false, error: DETECT_ONLY_MESSAGE });
    }
    const preview = await previewAccountBalanceDrift();

    res.json({ success: true, data: { check, ...preview } });
  } catch (error) {
    handleRouteError(res, error, `Health check preview failed: ${check}`, 'Gagal membuat preview');
  }
});

// POST /api/health-check/fix/:check: Auto-fix a specific check
router.post('/fix/:check', requireCap('doc.cancel'), async (req: AuthRequest, res) => {
  const check = String(req.params.check ?? '');
  const userId = req.user?.userId;
  const userAgent = Array.isArray(req.headers['user-agent'])
    ? req.headers['user-agent'][0]
    : req.headers['user-agent'];

  if (check !== 'account-balance-drift') {
    return res.status(400).json({ success: false, error: DETECT_ONLY_MESSAGE });
  }

  const startedAt = new Date();
  try {
    // The success audit row is written inside the fix's transaction.
    const result = await fixAccountBalanceDrift({ userId, ipAddress: req.ip, userAgent, startedAt });

    logger.info({ check, userId, fixed: result.fixed }, 'Health check fix applied');
    res.json({ success: true, data: { fixed: result.fixed, message: result.message } });
  } catch (error) {
    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId,
          action: `${FIX_ACTION}_FAILED`,
          entityType: 'health-check',
          entityId: check,
          newValues: {
            check,
            error: error instanceof Error ? error.message : String(error),
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
          },
          ipAddress: req.ip,
          userAgent,
        },
      }).catch((err) => logger.error({ err }, 'Audit log write failed for health fix error'));
    }
    handleRouteError(res, error, `Health check fix failed: ${check}`, 'Gagal memperbaiki masalah');
  }
});

export default router;
