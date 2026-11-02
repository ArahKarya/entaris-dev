// Journal import (E7-R9), pure part: turns sheet rows into journal groups, checks every line with
// the one journal line validator, and builds the content hash that makes a re-upload idempotent.
// No database here; the route resolves accounts, periods and writes.
import { createHash } from 'node:crypto';
import { journalLineIssueMessage, validateJournalLines, type NormalizedJournalLine } from '../utils/journalLineRules';
import { parseImportAmount, parseImportDate } from '../utils/importDate';

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportItem {
  accountNumber: string;
  debit: string;
  credit: string;
  description?: string;
  /** 1-based sheet row (header = row 1). */
  rowNum: number;
}

export interface ImportGroup {
  /** `ref:<ref>` when the sheet has a ref column value, else `<day>||<narration>`. */
  groupKey: string;
  ref: string;
  /** YYYY-MM-DD. */
  day: string;
  narration: string;
  items: ImportItem[];
  /** A row of this group already failed; balance is not judged on a partial group. */
  broken: boolean;
}

export interface ParsedImport {
  groups: ImportGroup[];
  errors: ImportRowError[];
}

/** Largest number of journals in one file: they post in one transaction. */
export const MAX_IMPORT_GROUPS = 500;

type SanitizeFn = (value: unknown) => string;

/** Groups the sheet rows into journals and reports every unreadable row. */
export function parseJournalRows(
  rows: readonly Record<string, string>[],
  numericCells: ReadonlyArray<Record<string, boolean>>,
  sanitize: SanitizeFn,
): ParsedImport {
  const errors: ImportRowError[] = [];
  const groups = new Map<string, ImportGroup>();
  const firstRow = new Map<string, number>();

  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const numeric = numericCells[i] ?? {};
    const rawDate = (r.date || '').trim();
    const narration = sanitize(r.narration);
    const accountNumber = (r.accountNumber || r.account_number || '').trim();
    const description = sanitize(r.description);
    const ref = sanitize(r.ref);

    const date = rawDate ? parseImportDate(rawDate) : null;
    // A bad row still taints its journal: judging the balance of the leftover lines would mislead.
    const taint = () => {
      const key = ref ? `ref:${ref}` : date?.ok && narration ? `${date.day}||${narration}` : null;
      if (!key) return;
      const existing = groups.get(key);
      if (existing) existing.broken = true;
      else {
        groups.set(key, { groupKey: key, ref, day: date?.ok ? date.day : '', narration, items: [], broken: true });
        firstRow.set(key, rowNum);
      }
    };

    if (!date) { errors.push({ row: rowNum, message: 'Kolom "date" wajib diisi.' }); taint(); return; }
    if (!narration) { errors.push({ row: rowNum, message: 'Kolom "narration" wajib diisi.' }); taint(); return; }
    if (!accountNumber) { errors.push({ row: rowNum, message: 'Kolom "accountNumber" wajib diisi.' }); taint(); return; }
    if (numeric.accountNumber || numeric.account_number) {
      // Excel keeps 5.10 as the number 5.1, which is a different account.
      errors.push({ row: rowNum, message: `Kolom "accountNumber" harus berformat teks: angka di sel Excel kehilangan nol di belakang (5.10 terbaca ${accountNumber}). Ubah format sel menjadi Text.` });
      taint();
      return;
    }

    const debit = parseImportAmount(r.debit, { fromNumberCell: numeric.debit });
    const credit = parseImportAmount(r.credit, { fromNumberCell: numeric.credit });
    if (!date.ok) errors.push({ row: rowNum, message: date.message });
    if (!debit.ok) errors.push({ row: rowNum, message: debit.message });
    if (!credit.ok) errors.push({ row: rowNum, message: credit.message });
    if (!date.ok || !debit.ok || !credit.ok) { taint(); return; }

    const groupKey = ref ? `ref:${ref}` : `${date.day}||${narration}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { groupKey, ref, day: date.day, narration, items: [], broken: false };
      groups.set(groupKey, group);
      firstRow.set(groupKey, rowNum);
    } else if (ref && group.day && (group.day !== date.day || group.narration !== narration)) {
      errors.push({
        row: rowNum,
        message: `Baris dengan ref "${ref}" harus memiliki tanggal dan narasi yang sama dengan baris pertama kelompok (baris ${firstRow.get(groupKey)}).`,
      });
      group.broken = true;
      return;
    }
    group.items.push({ accountNumber, debit: debit.value, credit: credit.value, description: description || undefined, rowNum });
  });

  return { groups: [...groups.values()], errors };
}

export interface CheckedGroup {
  group: ImportGroup;
  lines: NormalizedJournalLine[];
}

/**
 * Runs the line validator on each group that has no unreadable row. A line issue is reported on its
 * own sheet row; a journal-level issue (unbalanced, too few lines) on every row of the group.
 */
export function checkGroupLines(groups: readonly ImportGroup[]): { checked: CheckedGroup[]; errors: ImportRowError[] } {
  const checked: CheckedGroup[] = [];
  const errors: ImportRowError[] = [];
  for (const group of groups) {
    if (group.broken) continue;
    const result = validateJournalLines(group.items.map((i) => ({
      // accountId is only a carrier here: the line validator never looks at it.
      accountId: i.accountNumber,
      debit: i.debit,
      credit: i.credit,
      description: i.description,
    })));
    if (result.ok) {
      checked.push({ group, lines: result.lines });
      continue;
    }
    for (const issue of result.issues) {
      if (issue.index === null) {
        for (const item of group.items) errors.push({ row: item.rowNum, message: journalLineIssueMessage(issue) });
      } else {
        errors.push({ row: group.items[issue.index].rowNum, message: issue.message });
      }
    }
  }
  return { checked, errors };
}

/**
 * Hash of what the group says (ref, day, narration, lines sorted by account and amount), so the same
 * journal in a corrected or reordered file keeps its hash and a changed journal gets a new one.
 * Lines carry the account number in `accountId` (see checkGroupLines).
 */
export function groupContentHash(group: ImportGroup, lines: readonly NormalizedJournalLine[]): string {
  const normalized = lines
    .map((l) => [l.accountId, l.debit.toFixed(2), l.credit.toFixed(2), l.partyId ?? ''].join('|'))
    .sort();
  return createHash('sha256').update(JSON.stringify([group.ref.toLowerCase(), group.day, group.narration, normalized])).digest('hex');
}

/**
 * Hash per group, plus the n-th occurrence among identical hashes in the file, so two identical
 * journals in one file get distinct sourceKeys and a re-upload gives each the same key again.
 */
export function groupSourceKeyParts(checked: readonly CheckedGroup[]): Array<{ hash: string; occurrence: number }> {
  const seen = new Map<string, number>();
  return checked.map(({ group, lines }) => {
    const hash = groupContentHash(group, lines);
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    return { hash, occurrence };
  });
}
