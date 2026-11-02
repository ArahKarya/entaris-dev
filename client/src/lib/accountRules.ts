/**
 * Mirrors server/src/services/coa/accountRules.ts (a server parity test keeps the prefix table
 * identical): which root type an account number implies and which numbers are valid. The server
 * has the last word; this only lets the form prefill and warn early.
 */

export type RootType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

/** First segment of an account number -> root type. 7 is other income; 8 stays an expense. */
export const ROOT_TYPE_BY_PREFIX: Readonly<Record<string, RootType>> = {
  '1': 'ASSET',
  '2': 'LIABILITY',
  '3': 'EQUITY',
  '4': 'REVENUE',
  '5': 'EXPENSE',
  '6': 'EXPENSE',
  '7': 'REVENUE',
  '8': 'EXPENSE',
};

/** Dotted digits, first segment 1-8: "1", "6.19", "2.1.1.01". */
const NUMBER_PATTERN = /^[1-8](\.\d+)*$/;

export function normalizeAccountNumber(raw: string): string {
  return raw.trim();
}

export function isValidAccountNumber(accountNumber: string): boolean {
  return NUMBER_PATTERN.test(accountNumber);
}

export function numberPrefix(accountNumber: string): string {
  return accountNumber.split('.')[0];
}

/** Root type the number's first segment implies, or null outside 1-8. */
export function deriveRootType(accountNumber: string): RootType | null {
  return ROOT_TYPE_BY_PREFIX[numberPrefix(normalizeAccountNumber(accountNumber))] ?? null;
}

export function prefixChanged(from: string, to: string): boolean {
  return numberPrefix(from) !== numberPrefix(to);
}
