// The route harness must stop where Express stops: a gate that answers 403 and never calls next()
// may not let the route body run and overwrite the status, or a capability test passes by accident.
import { describe, it, expect } from 'vitest';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { callRoute } from './helpers/routeHarness';

function routerWith(gate: (req: Request, res: Response, next: NextFunction) => unknown) {
  const ran: string[] = [];
  const router = Router();
  router.post('/x', gate, (_req: Request, res: Response) => {
    ran.push('body');
    res.status(400).json({ error: 'body ran' });
  });
  return { router, ran };
}

describe('callRoute', () => {
  it('stops after a middleware that ends the response', async () => {
    const { router, ran } = routerWith((_req, res) => res.status(403).json({ error: 'denied' }));
    const r = await callRoute(router, 'post', '/x', { userId: 'u' });
    expect(r).toEqual({ status: 403, body: { error: 'denied' } });
    expect(ran).toEqual([]);
  });

  it('stops after a middleware that neither responds nor calls next()', async () => {
    const { router, ran } = routerWith(() => undefined);
    await callRoute(router, 'post', '/x', { userId: 'u' });
    expect(ran).toEqual([]);
  });

  it('runs the handler after a middleware that calls next()', async () => {
    const { router, ran } = routerWith((_req, _res, next) => next());
    const r = await callRoute(router, 'post', '/x', { userId: 'u' });
    expect(r.status).toBe(400);
    expect(ran).toEqual(['body']);
  });

  it('rethrows next(err)', async () => {
    const { router, ran } = routerWith((_req, _res, next) => next(new Error('boom')));
    await expect(callRoute(router, 'post', '/x', { userId: 'u' })).rejects.toThrow('boom');
    expect(ran).toEqual([]);
  });
});
