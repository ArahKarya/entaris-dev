// Receivable and customer deposit checks for /api/health-check (E4-R3): the ledger balance per
// Customer against the subledger the invoices and deposits keep (services/ledger/arSubledgerCheck.ts).
// Detection only, no fix: a difference is corrected by the accountant with a document or a journal.
import { prisma } from '../../lib/prisma';
import { findArSubledgerDiffs, findCustomerDepositDiffs, type PartySubledgerDiff } from '../../services/ledger/arSubledgerCheck';
import { PARTY_ROLE_AMBIGUOUS } from '../../services/ledger/partyRules';
import { BusinessError } from '../../utils/errors';
import type { CheckResult } from './checks';

const DETAIL_LIMIT = 20;

/**
 * Detail rows for the client table; the bucket without a party is labelled "(tanpa Customer)". The
 * client takes its columns from the first row, so once any listed party has an ignored opening
 * outstanding every row carries the column (null where there is none).
 */
export function detailRows(rows: readonly PartySubledgerDiff[]) {
  const listed = rows.slice(0, DETAIL_LIMIT);
  const showIgnored = listed.some((r) => r.openingIgnored);
  return listed.map((r) => ({
    party_name: r.partyName ?? '(tanpa Customer)',
    party_type: r.partyType,
    gl: r.gl.toNumber(),
    subledger: r.subledger.toNumber(),
    difference: r.difference.toNumber(),
    ...(showIgnored ? { opening_outstanding_ignored: r.openingIgnored?.toNumber() ?? null } : {}),
  }));
}

/**
 * The rows, or an error result naming the account when the role's mapping is ambiguous
 * (PARTY_ROLE_AMBIGUOUS): the check cannot tell that account's lines apart, and one failing check
 * must not take the whole health check down.
 */
async function rowsOrAmbiguous(
  name: string,
  find: () => Promise<PartySubledgerDiff[]>,
): Promise<PartySubledgerDiff[] | CheckResult> {
  try {
    return await find();
  } catch (err) {
    if (!(err instanceof BusinessError) || err.code !== PARTY_ROLE_AMBIGUOUS) throw err;
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
