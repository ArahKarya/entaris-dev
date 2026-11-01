import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Deletes audit_trail rows from a test's own committed fixtures. audit_trail is append-only
 * (trigger, E7-R11); like the data reset, the cleanup sets entaris.audit_purge for its own
 * transaction only. Test code only: production code never deletes audit rows.
 */
export async function purgeAuditRows(prisma: PrismaClient, where: Prisma.AuditLogWhereInput): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('entaris.audit_purge', 'on', true)`);
    return (await tx.auditLog.deleteMany({ where })).count;
  });
}
