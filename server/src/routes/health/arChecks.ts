// Receivable and customer deposit checks for /api/health-check (E4-R3), and the payable check per
// Supplier (PR-5.10): the ledger balance per party against the subledger the invoices and deposits
// keep (services/ledger/arSubledgerCheck.ts).
// Detection only, no fix: a difference is corrected by the accountant with a document or a journal.
import { prisma } from '../../lib/prisma';
import { findApSubledgerDiffs, findArSubledgerDiffs, findCustomerDepositDiffs, type PartySubledgerDiff } from '../../services/ledger/arSubledgerCheck';
import { PARTY_ROLE_AMBIGUOUS } from '../../services/ledger/partyRules';
import { BusinessError } from '../../utils/errors';
import type { CheckResult } from './checks';

const DETAIL_LIMIT = 20;

/** Detail rows for the client table; the bucket without a party is labelled `noParty`. */
export function detailRows(rows: readonly PartySubledgerDiff[], noParty = '(tanpa Customer)') {
  const listed = rows.slice(0, DETAIL_LIMIT);
  return listed.map((r) => ({
    party_name: r.partyName ?? noParty,
    party_type: r.partyType,
    gl: r.gl.toNumber(),
    subledger: r.subledger.toNumber(),
    difference: r.difference.toNumber(),
  }));
}

/**
 * The rows, or an error result naming the account when the role's mapping is ambiguous
 * (PARTY_ROLE_AMBIGUOUS): the check cannot tell that account's lines apart, and one failing check
 * must not take the whole health check down. `codes` widens the mapping problems caught (the
 * inventory checks also catch ACCOUNT_MAPPING_MISSING).
 */
export async function rowsOrAmbiguous<T>(
  name: string,
  find: () => Promise<T>,
  codes: readonly string[] = [PARTY_ROLE_AMBIGUOUS],
): Promise<T | CheckResult> {
  try {
    return await find();
  } catch (err) {
    if (!(err instanceof BusinessError) || !err.code || !codes.includes(err.code)) throw err;
    return { name, status: 'error', message: err.message, count: 1, details: [], fixable: false };
  }
}

export async function checkArSubledgerVsGl(): Promise<CheckResult> {
  const rows = await rowsOrAmbiguous('AR vs Subledger', () => findArSubledgerDiffs(prisma));
  if (!Array.isArray(rows)) return rows;
  return {
    name: 'AR vs Subledger',
    status: rows.length > 0 ? 'warning' : 'ok',
    message: rows.length > 0
      ? `${rows.length} Customer: saldo Piutang di Buku Besar berbeda dengan sisa tagihan invoice`
      : 'Saldo Piutang di Buku Besar sama dengan sisa tagihan invoice per Customer',
    count: rows.length,
    details: detailRows(rows),
    fixable: false,
  };
}

export async function checkCustomerDepositVsGl(): Promise<CheckResult> {
  const rows = await rowsOrAmbiguous('Customer Deposit vs Subledger', () => findCustomerDepositDiffs(prisma));
  if (!Array.isArray(rows)) return rows;
  return {
    name: 'Customer Deposit vs Subledger',
    status: rows.length > 0 ? 'warning' : 'ok',
    message: rows.length > 0
      ? `${rows.length} Customer: saldo Uang Muka Customer di Buku Besar berbeda dengan sisa uang muka`
      : 'Saldo Uang Muka Customer di Buku Besar sama dengan sisa uang muka per Customer',
    count: rows.length,
    details: detailRows(rows),
    fixable: false,
  };
}

export async function checkApSubledgerVsGl(): Promise<CheckResult> {
  const rows = await rowsOrAmbiguous('AP vs Subledger', () => findApSubledgerDiffs(prisma));
  if (!Array.isArray(rows)) return rows;
  return {
    name: 'AP vs Subledger',
    status: rows.length > 0 ? 'warning' : 'ok',
    message: rows.length > 0
      ? `${rows.length} Supplier: saldo Hutang di Buku Besar berbeda dengan sisa tagihan invoice`
      : 'Saldo Hutang di Buku Besar sama dengan sisa tagihan invoice per Supplier',
    count: rows.length,
    details: detailRows(rows, '(tanpa Supplier)'),
    fixable: false,
  };
}
