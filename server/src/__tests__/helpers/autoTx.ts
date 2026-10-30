import { vi, type Mock } from 'vitest';

type Handler = (args: any, ...rest: any[]) => unknown;

/**
 * A mocked Prisma transaction client: every `tx.<model>.<method>` is a vi.fn.
 * Methods listed in `handlers` (key "model.method") use that implementation;
 * the rest resolve to a sensible default (create/update echo `data` with an id,
 * find* resolve null, findMany/groupBy resolve [], counts resolve 0).
 * Raw queries are `tx.$queryRaw` (key "$queryRaw", default []), called with the template parts.
 */
export function makeAutoTx(handlers: Record<string, Handler> = {}) {
  const fns = new Map<string, Mock>();
  let seq = 0;
  const fallback = (method: string): Handler => {
    if (method === 'create' || method === 'update' || method === 'upsert') {
      return (args) => ({ id: `id-${++seq}`, ...(args?.data ?? args?.create ?? {}) });
    }
    if (method === 'findMany' || method === 'groupBy' || method === 'createManyAndReturn' || method === '$queryRaw') return () => [];
    if (method === 'count') return () => 0;
    if (method === 'createMany' || method === 'updateMany' || method === 'deleteMany') return () => ({ count: 0 });
    return () => null;
  };
  const fn = (key: string): Mock => {
    let f = fns.get(key);
    if (!f) {
      const method = key.split('.')[1] ?? key;
      const impl = handlers[key] ?? fallback(method);
      f = vi.fn(async (...args: unknown[]) => impl(args[0], ...args.slice(1)));
      fns.set(key, f);
    }
    return f;
  };
  const tx = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        model.startsWith('$')
          ? fn(model)
          : new Proxy({}, { get: (_m, method: string) => fn(`${model}.${method}`) }),
    },
  ) as any;
  return { tx, fn };
}
