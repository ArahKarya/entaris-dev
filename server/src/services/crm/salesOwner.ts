/** Sales owner (PIC) validation and the user list behind the PIC picker. */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BusinessError } from '../../utils/errors';

type Db = Prisma.TransactionClient | typeof prisma;

/** Throws when the id is not an active user. */
export async function assertSalesOwner(db: Db, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!user || !user.isActive) throw new BusinessError('PIC sales harus user aktif.');
}

export interface SalesUserOption {
  id: string;
  fullName: string;
}

/** Active users for the PIC picker (id and name only; open to anyone with CRM view). */
export async function listSalesUsers(db: Db = prisma): Promise<SalesUserOption[]> {
  return db.user.findMany({
    where: { isActive: true },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  });
}
