import type { PrismaClient } from '@prisma/client';
import type { Router } from 'express';

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

let savepointSeq = 0;

/**
 * Runs `fn` on `tx` inside a savepoint: a throw rolls back only what `fn` wrote, the way a
 * route's own `$transaction` would, and the outer rollback transaction stays usable.
 */
async function inSavepoint<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  const name = `route_harness_${++savepointSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await fn(tx);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw e;
  }
}

/**
 * Stand-in for `lib/prisma` in integration tests that call route handlers directly: while
 * `state.tx` is set every model call goes to that rollback transaction, and `$transaction`
 * runs its callback on it inside a savepoint, so handlers see the fixture rows, a failed
 * handler leaves no partial writes, and nothing is committed.
 * Use with vi.hoisted + vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) })).
 */
export function txPrismaProxy(state: { tx: Tx | null }): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get: (_target, key: string) => {
      const tx = state.tx;
      if (!tx) throw new Error('route harness: no active transaction');
      if (key === '$transaction') return (fn: (t: Tx) => Promise<unknown>) => inSavepoint(tx, fn);
      return (tx as unknown as Record<string, unknown>)[key];
    },
  });
}

export interface RouteResult {
  status: number;
  body: any; // JSON of any route
}

/**
 * Invoke the handlers of `METHOD path` on an Express router with a minimal req/res. `role` is the
 * role key in req.user (default 'Admin'); requireCap gates resolve it against the roles table.
 * Like Express, the chain stops at a handler that ends the response or does not call next() (a
 * requireCap 403 never reaches the route body); next(err) is rethrown.
 */
export async function callRoute(
  router: Router,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; userId?: string; role?: string; params?: Record<string, string> } = {},
): Promise<RouteResult> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } };
  const layer = (router.stack as Layer[]).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route harness: ${method.toUpperCase()} ${path} not found`);
  const result: RouteResult = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { result.status = code; return res; },
    json(body: unknown) { result.body = body; ended = true; return res; },
    send(body: unknown) { result.body = body; ended = true; return res; },
    setHeader() { return res; },
  };
  const req = {
    query: opts.query ?? {},
    body: opts.body ?? {},
    params: opts.params ?? {},
    headers: {},
    user: opts.userId ? { userId: opts.userId, role: opts.role ?? 'Admin' } : undefined,
    get: () => undefined,
  };
  for (const { handle } of layer.route.stack) {
    let advanced = false;
    let nextArg: unknown;
    await handle(req, res, (arg?: unknown) => { advanced = true; nextArg = arg; });
    if (nextArg !== undefined && nextArg !== 'route' && nextArg !== 'router') throw nextArg;
    if (!advanced || nextArg !== undefined || ended) break;
  }
  return result;
}
