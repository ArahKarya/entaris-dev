import type { Tx } from './routeHarness';
import { invalidatePermissionCache } from '../../services/permissionService';

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * A role holding exactly `caps` (not super-admin) and an active user with that role, created in
 * `tx`. The built-in roles come from ensureRbacSeed at app boot, not from the seed, so a test that
 * passes a requireCap gate makes its own. Pass both to callRoute as `{ userId, role }`. Resets the
 * permission cache so the next check sees the new role.
 */
export async function createCapUser(tx: Tx, caps: readonly string[]): Promise<{ userId: string; role: string }> {
  const key = `it-caps-${tag()}`;
  const role = await tx.role.create({
    data: { key, name: `Uji ${key}`, capabilities: { create: caps.map((capability) => ({ capability })) } },
  });
  const user = await tx.user.create({
    data: { username: key, fullName: `Uji ${key}`, email: `${key}@test.invalid`, passwordHash: '-', role: role.key },
  });
  invalidatePermissionCache();
  return { userId: user.id, role: role.key };
}
