import type { PrismaClient } from '@prisma/client';
import type { Router } from 'express';

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Stand-in for `lib/prisma` in integration tests that call route handlers directly: while
 * `state.tx` is set every model call goes to that rollback transaction, and `$transaction`
 * runs its callback on it, so handlers see the fixture rows and nothing is committed.
 * Use with vi.hoisted + vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) })).
 */
export function txPrismaProxy(state: { tx: Tx | null }): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const tx = state.tx;
      if (!tx) throw new Error('route harness: no active transaction');
      if (key === '$transaction') return (fn: (t: Tx) => unknown) => fn(tx);
      return (tx as unknown as Record<string, unknown>)[key];
    },
  });
}

export interface RouteResult {
  status: number;
  body: any; // JSON of any route
}

/** Invoke the handlers of `METHOD path` on an Express router with a minimal req/res. */
export async function callRoute(
  router: Router,
  method: 'get' | 'post',
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; userId?: string } = {},
): Promise<RouteResult> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } };
  const layer = (router.stack as Layer[]).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route harness: ${method.toUpperCase()} ${path} not found`);
  const result: RouteResult = { status: 200, body: undefined };
  const res = {
    status(code: number) { result.status = code; return res; },
    json(body: unknown) { result.body = body; return res; },
    send(body: unknown) { result.body = body; return res; },
    setHeader() { return res; },
  };
  const req = {
    query: opts.query ?? {},
    body: opts.body ?? {},
    params: {},
    headers: {},
    user: opts.userId ? { userId: opts.userId, role: 'Admin' } : undefined,
    get: () => undefined,
  };
  for (const { handle } of layer.route.stack) await handle(req, res, () => undefined);
  return result;
}
