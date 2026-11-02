// Chart-of-accounts import (E2-R6), split into three steps: parse the spreadsheet rows, validate
// them against the structure rules and the stored accounts (the preview runs both, the import
// runs both and then writes), and apply (routes/import/coa.ts). A row that fails is reported with
// its row number and skipped; the other rows still go in.

import type { Prisma } from '@prisma/client';
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
  openingBalance: number;
}

export interface CoaImportRow extends ImportRowPlan {
  rowNum: number;
  name: string;
  openingBalance: number;
  /** What the row was planned from, so the write can plan it again under the locks. */
  input: ImportRowInput;
  hasChildInFile: boolean;
}

type RawRow = Record<string, string>;

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

/** Step 1: read the columns of every row; only missing or unreadable cells are errors here. */
export function parseCoaRows(
  rows: readonly RawRow[],
  sanitize: (value: string) => string,
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
    const openingBalanceStr = (r.openingBalance || r.opening_balance || r.outstandingAmount || r.outstanding_amount || r.saldoAwal || r.saldo_awal || r.piutang || r.hutang || r.balance || '').toString().trim();
    const openingBalance = openingBalanceStr ? parseFloat(openingBalanceStr) : 0;

    if (!accountNumber) return void errors.push({ row: rowNum, message: 'Kolom "accountNumber" wajib diisi.' });
    if (!name) return void errors.push({ row: rowNum, message: 'Kolom "name" wajib diisi.' });
    if (isNaN(openingBalance)) {
      return void errors.push({ row: rowNum, message: `openingBalance "${openingBalanceStr}" bukan angka valid.` });
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
      ...plan.data, rowNum: row.rowNum, name: row.name, openingBalance: row.openingBalance,
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
