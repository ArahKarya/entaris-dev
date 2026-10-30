// Bootstrap RBAC idempoten: pastikan 4 role bawaan + matriks izin default ada.
// Dipanggil saat boot (index.ts). HANYA mengisi role yang belum ada (tidak
// menimpa perubahan Admin). Selalu menjamin Admin = super-admin (anti-lockout).
// Matriks default mereproduksi akses lama → no-regression. Lihat constants/modules.ts.

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import {
  BUILTIN_ROLES, DEFAULT_MATRIX, DEFAULT_CAPS, BACKFILL_MODULES, BACKFILL_CAPS, type CapBackfill,
} from '../constants/modules';
import { invalidatePermissionCache } from './permissionService';

type CapBackfillClient = Pick<PrismaClient, '$executeRaw' | '$queryRaw' | '$transaction'>;

/** Same DDL as loose SQL 2026100900000; normally the table already exists before the app boots. */
async function ensureMarkerTable(client: CapBackfillClient): Promise<void> {
  try {
    await client.$executeRaw`CREATE TABLE IF NOT EXISTS "data_fix_markers" (
      "key" TEXT PRIMARY KEY,
      "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
  } catch (err) {
    // Two instances creating it at once can collide on the catalog; fine if it exists now.
    const rows = await client.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('data_fix_markers')::text AS t`;
    if (!rows[0]?.t) throw err;
  }
}

/**
 * Grants each BACKFILL_CAPS entry once per database. The marker insert and the grant share one
 * transaction: a concurrent boot blocks on the marker key and then skips, and a failed grant rolls
 * the marker back so the entry retries on the next boot. Never throws: a failing entry is logged
 * and the rest still run. Returns the number of entries applied on this call.
 */
export async function runCapBackfill(client: CapBackfillClient, entries: readonly CapBackfill[]): Promise<number> {
  if (entries.length === 0) return 0;
  try {
    await ensureMarkerTable(client);
  } catch (err) {
    logger.error({ err }, 'RBAC: data_fix_markers unavailable; capability backfill retried on next boot');
    return 0;
  }
  let applied = 0;
  for (const entry of entries) {
    try {
      const result = await client.$transaction(async (tx) => {
        const marked = await tx.$executeRaw`INSERT INTO "data_fix_markers" ("key") VALUES (${entry.key}) ON CONFLICT ("key") DO NOTHING`;
        if (marked === 0) return null;
        const role = await tx.role.findUnique({ where: { key: entry.role } });
        if (!role || role.isSuperAdmin || entry.caps.length === 0) return { roleFound: !!role, inserted: 0 };
        const res = await tx.roleCapability.createMany({
          data: entry.caps.map((capability) => ({ roleId: role.id, capability })),
          skipDuplicates: true,
        });
        return { roleFound: true, inserted: res.count };
      });
      if (!result) continue;
      applied += 1;
      logger.info({ key: entry.key, role: entry.role, caps: entry.caps, ...result }, 'RBAC: one-time capability backfill applied');
    } catch (err) {
      logger.error({ err, key: entry.key }, 'RBAC: capability backfill failed; retried on next boot');
    }
  }
  return applied;
}

export async function ensureRbacSeed(): Promise<void> {
  try {
    for (const def of BUILTIN_ROLES) {
      const existing = await prisma.role.findUnique({ where: { key: def.key } });

      if (!existing) {
        const role = await prisma.role.create({
          data: {
            key: def.key,
            name: def.name,
            description: def.description,
            isSystem: true,
            isSuperAdmin: def.isSuperAdmin,
          },
        });

        const matrix = DEFAULT_MATRIX[def.key];
        if (matrix) {
          await prisma.rolePermission.createMany({
            data: Object.entries(matrix).map(([module, action]) => ({
              roleId: role.id,
              module,
              canView: true,
              canEdit: action === 'edit',
            })),
            skipDuplicates: true,
          });
        }

        const caps = DEFAULT_CAPS[def.key] ?? [];
        if (caps.length > 0) {
          await prisma.roleCapability.createMany({
            data: caps.map((capability) => ({ roleId: role.id, capability })),
            skipDuplicates: true,
          });
        }
        logger.info({ role: def.key }, 'RBAC: role bawaan dibuat + matriks default');
      } else {
        // Jaga flag penting agar Admin selalu super-admin & role bawaan tetap isSystem.
        if (existing.isSystem !== true || existing.isSuperAdmin !== def.isSuperAdmin) {
          await prisma.role.update({
            where: { id: existing.id },
            data: { isSystem: true, isSuperAdmin: def.isSuperAdmin },
          });
        }
      }
    }

    await runCapBackfill(prisma, BACKFILL_CAPS);

    // One-shot backfill of newer modules into system roles, only when the module has no
    // RolePermission yet; otherwise every boot would restore permissions an Admin revoked.
    for (const moduleKey of BACKFILL_MODULES) {
      const already = await prisma.rolePermission.count({ where: { module: moduleKey } });
      if (already > 0) continue;

      const systemRoles = await prisma.role.findMany({ where: { isSystem: true } });
      const rows = systemRoles.flatMap((role) => {
        const action = DEFAULT_MATRIX[role.key]?.[moduleKey];
        if (!action) return [];
        return [{ roleId: role.id, module: moduleKey, canView: true, canEdit: action === 'edit' }];
      });
      if (rows.length > 0) {
        await prisma.rolePermission.createMany({ data: rows, skipDuplicates: true });
        logger.info({ module: moduleKey, roles: rows.length }, 'RBAC: backfill izin modul baru ke role sistem');
      }
    }

    invalidatePermissionCache();
  } catch (err) {
    logger.error({ err }, 'ensureRbacSeed gagal (diabaikan saat boot)');
  }
}
