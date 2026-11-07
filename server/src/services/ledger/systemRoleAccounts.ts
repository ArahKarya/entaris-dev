import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { mappedAccount, type MappedAccount } from '../systemAccounts';

type Tx = Prisma.TransactionClient;

/**
 * Posting accounts for COGS, sales returns and the production conversion credit. All three come
 * from the system account mapping (read through `tx`); no account number is hardcoded, so an
 * accountant who remaps a role sees the next posting follow it. An unmapped role throws
 * ACCOUNT_MAPPING_MISSING (400) instead of falling back to another account.
 */
export function cogsAccountFor(tx: Tx): Promise<MappedAccount> {
  return mappedAccount(tx, 'COGS');
}

export function salesReturnAccount(tx: Tx): Promise<MappedAccount> {
  return mappedAccount(tx, 'SALES_RETURN');
}

export function productionConversionAccount(tx: Tx): Promise<MappedAccount> {
  return mappedAccount(tx, 'PRODUCTION_CONVERSION');
}

export interface ProductionDiffSplit {
  /** Credit to the PRODUCTION_CONVERSION account (conversion cost absorbed into inventory). */
  toConversion: number;
  /** Remainder of a positive difference, credited to the COGS account. */
  toCogs: number;
}

/**
 * Splits a positive output-minus-input value difference: up to the conversion cost goes to the
 * conversion account (PSAK 14), the remainder to COGS. A non-positive difference is a production
 * loss, handled by the caller as a COGS debit.
 */
export function splitProductionDiff(diff: number, conversionCost: number): ProductionDiffSplit {
  if (!(diff > 0)) return { toConversion: 0, toCogs: 0 };
  const toConversion = Math.min(diff, Math.max(conversionCost, 0));
  const toCogs = new Decimal(diff).minus(toConversion).toDecimalPlaces(2).toNumber();
  return { toConversion, toCogs };
}

export interface ProductionDiffAccounts {
  cogs: MappedAccount;
  conversion: MappedAccount | null;
}

/**
 * Accounts a production run needs for its value difference. COGS is always required. The
 * conversion account is required only for a gain (diff > 0): a run with a gain and no
 * PRODUCTION_CONVERSION mapping fails with a clear error, never posts the whole gain to COGS.
 */
export async function productionDiffAccounts(tx: Tx, diff: number): Promise<ProductionDiffAccounts> {
  const cogs = await cogsAccountFor(tx);
  if (!(diff > 0)) return { cogs, conversion: null };
  return { cogs, conversion: await productionConversionAccount(tx) };
}
