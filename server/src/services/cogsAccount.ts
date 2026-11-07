import type { Prisma } from '@prisma/client';
import { systemAccounts } from './systemAccounts';

type Tx = Prisma.TransactionClient;

/**
 * Account the sales invoice debits for COGS when it invoices delivered stock: the account mapped
 * to the COGS system role. Used as the "akun lawan" metadata of delivery-order stock-out
 * movements; returns null instead of throwing so a missing mapping never blocks a delivery.
 */
export async function resolveCogsAccountId(_tx: Tx): Promise<string | null> {
  const [cogs] = await systemAccounts.getAccounts('COGS');
  return cogs?.id ?? null;
}
