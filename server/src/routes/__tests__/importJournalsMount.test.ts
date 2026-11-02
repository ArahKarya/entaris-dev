/**
 * E7-R9: importing journals needs the journal right as well as the settings gate of /api/import,
 * so a role with settings:edit but no journal access cannot post journals through the importer.
 * Read from the static route inventory (the route harness never runs index.ts mounts).
 */
import { describe, it, expect } from 'vitest';
import { buildRouteInventory } from '../../ai/catalog/inventoryRoutes';

const route = buildRouteInventory().find((r) => r.method === 'POST' && r.path === '/api/import/journals');

describe('POST /api/import/journals guards', () => {
  it('exists', () => {
    expect(route).toBeDefined();
  });

  it('needs the settings right and the journal right', () => {
    const guards = route!.guards.map((g) => `${g.scope}:${g.kind}(${g.args.join(',')})`);
    expect(guards).toContain('mount:requireWrite(settings)');
    expect(guards).toContain('route:requirePerm(journal)');
  });
});
