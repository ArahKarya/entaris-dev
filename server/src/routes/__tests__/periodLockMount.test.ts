/**
 * PR-7b: /api/period-lock is mounted behind the journal right, not the settings gate of
 * /api/fiscal-years, so a role an Admin grants period.lock to can use it without settings:edit.
 * The route harness never runs index.ts mounts, so this reads them from the static route inventory.
 * period.lock is an Admin-only capability: listed in the catalogue, not granted to Accountant.
 */
import { describe, it, expect } from 'vitest';
import { buildRouteInventory } from '../../ai/catalog/inventoryRoutes';
import { BACKFILL_CAPS, CAPABILITY_KEYS, DEFAULT_CAPS } from '../../constants/modules';

const routes = buildRouteInventory().filter((r) => r.path === '/api/period-lock');
const guardsOf = (method: string) => routes.find((r) => r.method === method)?.guards.map((g) => `${g.scope}:${g.kind}(${g.args.join(',')})`);

describe('/api/period-lock mount', () => {
  it('GET needs the journal right only', () => {
    expect(guardsOf('GET')).toEqual(['mount:requirePerm(journal)']);
  });

  it('PUT needs the journal right and period.lock, and no settings right', () => {
    expect(guardsOf('PUT')).toEqual(['mount:requirePerm(journal)', 'route:requireCap(period.lock)']);
    expect(routes.flatMap((r) => r.guards).some((g) => g.args.includes('settings'))).toBe(false);
  });
});

describe('period.lock capability', () => {
  it('is in the catalogue but not a default or backfilled capability of any role', () => {
    expect(CAPABILITY_KEYS).toContain('period.lock');
    expect(Object.values(DEFAULT_CAPS).flat()).not.toContain('period.lock');
    expect(BACKFILL_CAPS.flatMap((b) => b.caps)).not.toContain('period.lock');
  });
});
