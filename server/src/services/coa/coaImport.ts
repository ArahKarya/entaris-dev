// Chart-of-accounts import (E2-R6), split into three steps: parse the spreadsheet rows, validate
// them against the structure rules and the stored accounts (the preview runs both, the import
// runs both and then writes), and apply (routes/import/coa.ts). A row that fails is reported with
// its row number and skipped; the other rows still go in. The opening balance column is read as
// an exact decimal and written through the opening balance service (services/ledger/openingBalance.ts).

import type { Prisma } from '@prisma/client';
import { parseImportAmount, parseImportDate } from '../../utils/importDate';
import {
  planImportRow,
  type ImportRowInput,
  type ImportRowPlan,
  type ParentFacts,
} from './accountRules';
import { loadImportFacts } from './accountStructure';

type Db = Prisma.TransactionClient;

export const ACCOUNT_IMPORT_DUPLICATE = 'ACCOUNT_IMPORT_DUPLICATE';
export const ACCOUNT_IMPORT_STALE = 'ACCOUNT_IMPORT_STALE';

export interface ImportRowError {
  row: number;
  message: string;
  code?: string;
}

export interface ParsedCoaRow {
  rowNum: number;
  accountNumber: string;
  name: string;
  rootType: string;
  accountType: string;
  /** Effective parent: the file's value, else the number minus its last segment ('' = top level). */
  parentNumber: string;
  isGroup: boolean | null;
  /**
   * The opening balance at the cut-over date as an exact decimal string (normal side, negative for
   * a contra balance), or null when the cell is blank: a blank cell leaves the opening balance as it is.
   */
  openingBalance: string | null;
  /** YYYY-MM-DD from the optional openingDate column; null (blank) means the cut-over date. */
  openingDate: string | null;
}

export interface CoaImportRow extends ImportRowPlan {
  rowNum: number;
  name: string;
  openingBalance: string | null;
  openingDate: string | null;
  /** What the row was planned from, so the write can plan it again under the locks. */
  input: ImportRowInput;
  hasChildInFile: boolean;
}

type RawRow = Record<string, string>;
/** Per row, the headers whose Excel cell was a number or formula (routes/import/shared.ts parseFileDetailed). */
type NumericCells = Record<string, boolean>;

/**
 * Opening balance headers. A "balance" column (or the party columns outstandingAmount/piutang/hutang)
 * is not read: the old template exported the running balance there, and posting it as the opening
 * balance would count every movement after the cut-over twice.
 */
const OPENING_BALANCE_KEYS = ['openingBalance', 'opening_balance', 'saldoAwal', 'saldo_awal'] as const;
const OPENING_DATE_KEYS = ['openingDate', 'opening_date', 'asOfDate'] as const;

/** The first non-blank cell among `keys`, with whether that cell was a number in the sheet. */
function pickCell(r: RawRow, numeric: NumericCells, keys: readonly string[]): { text: string; fromNumberCell: boolean } {
  for (const key of keys) {
    const text = (r[key] ?? '').toString().trim();
    if (text) return { text, fromNumberCell: !!numeric[key] };
  }
  return { text: '', fromNumberCell: false };
}

const TRUE_WORDS = ['true', '1', 'yes', 'ya'];
const FALSE_WORDS = ['false', '0', 'no', 'tidak'];

function parseIsGroup(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(v)) return true;
  if (FALSE_WORDS.includes(v)) return false;
  return null;
}

export function derivedParentNumber(accountNumber: string): string {
  return accountNumber.split('.').slice(0, -1).join('.');
}

/**
 * Step 1: read the columns of every row; only missing or unreadable cells are errors here. The
 * opening balance follows the journal amount rules (utils/importDate.ts parseImportAmount): text
 * with at most 2 decimals, no thousands separators, no exponent; a number cell within rounding of 2 decimals.
 */
export function parseCoaRows(
  rows: readonly RawRow[],
  sanitize: (value: string) => string,
  numericCells: readonly NumericCells[] = [],
): { parsed: ParsedCoaRow[]; errors: ImportRowError[] } {
  const parsed: ParsedCoaRow[] = [];
  const errors: ImportRowError[] = [];
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const accountNumber = (r.accountNumber || r.account_number || '').trim();
    const name = (r.name || '').trim();
    const rootType = (r.rootType || r.root_type || '').trim().toUpperCase();
    // A blank accountType means "same as rootType".
    const accountType = (r.accountType || r.account_type || rootType).trim().toUpperCase();
    const explicitParent = (r.parentNumber || r.parent_number || '').trim();
    const isGroup = parseIsGroup((r.isGroup || r.is_group || '').toString());
    const numeric = numericCells[i] ?? {};
    const balanceCell = pickCell(r, numeric, OPENING_BALANCE_KEYS);
    const dateCell = pickCell(r, numeric, OPENING_DATE_KEYS);

    if (!accountNumber) return void errors.push({ row: rowNum, message: 'Kolom "accountNumber" wajib diisi.' });
    if (!name) return void errors.push({ row: rowNum, message: 'Kolom "name" wajib diisi.' });
    let openingBalance: string | null = null;
    if (balanceCell.text) {
      const amount = parseImportAmount(balanceCell.text, { fromNumberCell: balanceCell.fromNumberCell });
      if (!amount.ok) return void errors.push({ row: rowNum, message: `openingBalance: ${amount.message}` });
      openingBalance = amount.value;
    }
    let openingDate: string | null = null;
    if (dateCell.text) {
      const day = parseImportDate(dateCell.text);
      if (!day.ok) return void errors.push({ row: rowNum, message: `openingDate: ${day.message}` });
      openingDate = day.day;
    }
    parsed.push({
      rowNum,
      accountNumber,
      name: sanitize(name),
      rootType,
      accountType,
      parentNumber: explicitParent || derivedParentNumber(accountNumber),
      isGroup,
      openingBalance,
      openingDate,
    });
  });
  return { parsed, errors };
}

const byDepthThenNumber = (a: { accountNumber: string }, b: { accountNumber: string }) => {
  const depth = a.accountNumber.split('.').length - b.accountNumber.split('.').length;
  return depth !== 0 ? depth : a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true });
};

/**
 * Step 2: apply the structure rules row by row, parents before children. Reads the stored
 * accounts through `db` (the preview too) and writes nothing. A parent counts only if the file's
 * own row for it was accepted, so a rejected parent rejects its children instead of orphaning them.
 */
export async function validateCoaRows(
  db: Db,
  parsed: readonly ParsedCoaRow[],
): Promise<{ rows: CoaImportRow[]; errors: ImportRowError[] }> {
  const errors: ImportRowError[] = [];
  const sorted = [...parsed].sort(byDepthThenNumber);

  // Numbers that have a row under them in the file: each prefix of every number.
  const hasChildInFile = new Set<string>();
  for (const row of sorted) {
    const parts = row.accountNumber.split('.');
    for (let depth = 1; depth < parts.length; depth++) hasChildInFile.add(parts.slice(0, depth).join('.'));
  }

  const facts = await loadImportFacts(db, sorted.flatMap((r) => [r.accountNumber, r.parentNumber].filter(Boolean)));
  const accepted = new Map<string, ParentFacts>();
  const rejected = new Set<string>();
  const rows: CoaImportRow[] = [];

  for (const row of sorted) {
    if (accepted.has(row.accountNumber) || rejected.has(row.accountNumber)) {
      errors.push({
        row: row.rowNum,
        code: ACCOUNT_IMPORT_DUPLICATE,
        message: `Nomor akun ${row.accountNumber} muncul lebih dari sekali di file; baris ini dilewati.`,
      });
      continue;
    }
    const parent = row.parentNumber
      ? accepted.get(row.parentNumber) ?? (rejected.has(row.parentNumber) ? null : facts.parents.get(row.parentNumber) ?? null)
      : null;
    const childInFile = hasChildInFile.has(row.accountNumber);
    const plan = planImportRow(row, {
      existing: facts.existing.get(row.accountNumber) ?? null,
      parent,
      hasChildInFile: childInFile,
    });
    if (!plan.ok) {
      rejected.add(row.accountNumber);
      errors.push({ row: row.rowNum, message: plan.message, code: plan.code });
      continue;
    }
    accepted.set(row.accountNumber, {
      id: plan.data.existingId ?? '',
      accountNumber: row.accountNumber,
      rootType: plan.data.rootType,
      isGroup: plan.data.isGroup,
    });
    rows.push({
      ...plan.data, rowNum: row.rowNum, name: row.name, openingBalance: row.openingBalance, openingDate: row.openingDate,
      input: row, hasChildInFile: childInFile,
    });
  }
  errors.sort((a, b) => a.row - b.row);
  return { rows, errors };
}

/**
 * Step 3a, inside the row's write transaction and after its accounts are locked: read the stored
 * facts again and plan the row again. The validation ran once over the whole file without locks,
 * so a posting or an edit may have landed since; the row is written only if the plan still holds.
 * Returns the parent's id for the write.
 */
export async function replanImportRow(
  tx: Db,
  row: CoaImportRow,
): Promise<{ ok: true; parentId: string | null } | { ok: false; message: string; code: string }> {
  const facts = await loadImportFacts(tx, [row.accountNumber, row.input.parentNumber].filter(Boolean));
  const parent = row.input.parentNumber ? facts.parents.get(row.input.parentNumber) ?? null : null;
  const plan = planImportRow(row.input, {
    existing: facts.existing.get(row.accountNumber) ?? null,
    parent,
    hasChildInFile: row.hasChildInFile,
  });
  if (!plan.ok) return { ok: false, message: plan.message, code: plan.code };
  const p = plan.data;
  if (p.rootType !== row.rootType || p.isGroup !== row.isGroup || p.existingId !== row.existingId || p.parentNumber !== row.parentNumber) {
    return {
      ok: false,
      code: ACCOUNT_IMPORT_STALE,
      message: `Data akun ${row.accountNumber} berubah saat impor berjalan; baris ini dilewati. Unggah ulang file.`,
    };
  }
  return { ok: true, parentId: parent?.id ?? null };
}
