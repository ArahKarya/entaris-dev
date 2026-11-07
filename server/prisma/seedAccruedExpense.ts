import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

// Name of the account the seed and prisma/migrations/2026110900000_accrued_expense_227.sql create.
export const ACCRUED_EXPENSE_ACCOUNT_NAME = 'Biaya Masih Harus Dibayar';

/**
 * Whether the seed may map ACCRUED_EXPENSE to account 2.2.7. The seed never touches existing
 * accounts, so 2.2.7 can be a tenant's own account for something else; mapping the role to it
 * would point accountants at the wrong account. A single-account role that already has a mapping
 * (2.2.6 on an old tenant, or the tenant's own choice) is left alone as well, so a re-seed never
 * adds a second mapping.
 */
export async function shouldSeedAccruedExpense(db: Db, accountId: string): Promise<boolean> {
  if ((await db.systemAccountMapping.count({ where: { role: 'ACCRUED_EXPENSE' } })) > 0) return false;
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { name: true, parent: { select: { accountNumber: true } } },
  });
  return account?.name === ACCRUED_EXPENSE_ACCOUNT_NAME && account.parent?.accountNumber === '2.2';
}
