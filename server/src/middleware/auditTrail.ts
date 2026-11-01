import { randomUUID } from 'crypto';
import { Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import { AuthRequest } from './auth';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { redactSecrets } from '../utils/redact';
import { captureBeforeSnapshot } from './auditSnapshot';

// Synchronous audit trail (E7-R11): a 2xx mutation answered with res.json is held until its
// audit_trail row is written, so a client that saw the response can rely on the row existing.
// Fail-open (owner decision #2): when the write fails the response still goes out and the failure
// is logged with the request id. audit_trail itself is append-only (trigger, migration
// 20261106000000_audit_trail_append_only). Mutations answered with send/end/204 are not audited.

const ACTIONS: Record<string, string> = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Routes that replace the users table: an audit row naming req.user would fail its foreign key
 * (audit_trail.user_id, Restrict), so these are only logged, with the safety backup name.
 */
const LOG_ONLY_ROUTES: ReadonlySet<string> = new Set(['POST /api/settings/reset-data', 'POST /api/backup/restore']);

/** The caller's x-request-id when well formed, otherwise a fresh UUID. */
export function resolveRequestId(header: unknown): string {
  return typeof header === 'string' && REQUEST_ID_RE.test(header) ? header : randomUUID();
}

/** `METHOD /path` without query string or trailing slash. */
function routeKey(method: string, originalUrl: string): string {
  const path = originalUrl.split('?')[0].replace(/\/+$/, '');
  return `${method} ${path}`;
}

export interface AuditInput {
  user: NonNullable<AuthRequest['user']>;
  method: string;
  originalUrl: string;
  body: unknown;
  before: { id: string | null; snapshot: unknown } | null;
  ip: string | undefined;
  userAgent: string | undefined;
}

/** The audit_trail row for one audited response (pure). */
export function buildAuditData(input: AuditInput): Prisma.AuditLogUncheckedCreateInput {
  const { user, body, before } = input;
  // '/api/sales/invoices' → 'sales'
  const segments = input.originalUrl.replace(/^\/api\//, '').split('/').filter(Boolean);
  const bodyId = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
  return {
    userId: user.userId,
    action: ACTIONS[input.method],
    entityType: segments[0] || 'unknown',
    entityId: bodyId ? String(bodyId) : (before?.id ?? 'N/A'),
    oldValues: (before?.snapshot ?? undefined) as Prisma.InputJsonValue | undefined,
    newValues: redactSecrets(body) as Prisma.InputJsonValue,
    ipAddress: input.ip,
    userAgent: input.userAgent,
    // Agent (MCP) or demo-generator actions: mark via so the audit trail shows the origin.
    ...(user.via === 'mcp'
      ? {
          via: 'mcp',
          viaMeta: {
            token: user.mcpToken ?? null,
            channel: user.mcpChannel ?? null,
            tool: user.mcpTool ?? null,
            approvalId: user.mcpApprovalId ?? null,
          },
        }
      : user.via === 'demo'
        ? { via: 'demo' }
        : {}),
  };
}

export const auditTrailMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const user = req.user;
  if (!user || !ACTIONS[req.method]) return next();

  // Before-state for registered documents/masters (never throws; null on skip).
  const before = await captureBeforeSnapshot(req.method, req.originalUrl);
  const route = routeKey(req.method, req.originalUrl);
  const originalJson = res.json.bind(res);
  let sending = false;

  res.json = function (body) {
    if (sending) {
      // The first res.json wins: a later status(500).json(...) must not replace a held response.
      logger.warn({ requestId, route }, 'Extra res.json after the response was committed; ignored');
      return res;
    }
    sending = true;
    const status = res.statusCode;
    if (status < 200 || status >= 300) return originalJson(body);

    if (LOG_ONLY_ROUTES.has(route)) {
      const safetyBackup = res.locals.safetyBackup ?? (body as { safetyBackup?: unknown } | null)?.safetyBackup;
      logger.warn({ requestId, userId: user.userId, route, status, safetyBackup }, 'Audited by log only: this route replaces the users table');
      return originalJson(body);
    }

    const persist = async () => {
      try {
        const data = buildAuditData({
          user, method: req.method, originalUrl: req.originalUrl, body, before,
          ip: req.ip, userAgent: req.headers['user-agent'],
        });
        await prisma.auditLog.create({ data });
      } catch (err) {
        logger.error({ err, requestId, userId: user.userId, route }, 'Audit log write failed; response sent without an audit row');
      }
    };
    void persist().then(() => {
      if (res.headersSent) return;
      res.statusCode = status;
      try {
        originalJson(body);
      } catch (err) {
        logger.error({ err, requestId, route }, 'Sending the held response failed');
      }
    });
    return res;
  };

  next();
};
