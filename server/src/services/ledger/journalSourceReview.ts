// Reads the accountant-reviewed backfill CSV (e1-journal-source-backfill --from-csv). The dry run
// writes one row per legacy journal with an empty approved_type column; the accountant fills in
// a JournalSourceType for the rows they decided and leaves the rest blank. Pure: the script loads
// the journals and writes; this module parses, validates and decides which rows may be applied.

import { parse } from 'csv-parse/sync';
import { JournalSourceType } from '@prisma/client';

export interface ReviewedRow {
  id: string;
  type: JournalSourceType;
  /** 1-based line in the file (the header is line 1). */
  line: number;
}

export interface ReviewedCsv {
  rows: ReviewedRow[];
  /** Rows with an empty approved_type: not reviewed, left alone. */
  blank: number;
  /** Any error means nothing may be applied. */
  errors: string[];
}

const SOURCE_TYPES: ReadonlySet<string> = new Set(Object.values(JournalSourceType));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Spreadsheets saved with an Indonesian locale separate columns with ';'. */
function delimiterOf(text: string): string {
  const header = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return header.includes(';') && !header.includes(',') ? ';' : ',';
}

/** Parses the reviewed CSV; needs the columns `id` and `approved_type`. */
export function parseReviewedSourceCsv(text: string): ReviewedCsv {
  let records: Record<string, string>[];
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter: delimiterOf(text),
    }) as Record<string, string>[];
  } catch (e) {
    return { rows: [], blank: 0, errors: [`CSV cannot be read: ${(e as Error).message}`] };
  }
  const columns = records.length > 0 ? Object.keys(records[0]!) : parseHeader(text);
  const missing = ['id', 'approved_type'].filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    return { rows: [], blank: 0, errors: missing.map((c) => `Missing column "${c}".`) };
  }

  const rows: ReviewedRow[] = [];
  const byId = new Map<string, ReviewedRow>();
  const errors: string[] = [];
  let blank = 0;
  records.forEach((r, i) => {
    const line = i + 2;
    const id = r.id ?? '';
    const raw = (r.approved_type ?? '').trim();
    if (raw === '') {
      blank++;
      return;
    }
    const type = raw.toUpperCase();
    if (!UUID.test(id)) {
      errors.push(`line ${line}: id "${id}" is not a journal id.`);
      return;
    }
    if (!SOURCE_TYPES.has(type)) {
      errors.push(`line ${line}: approved_type "${raw}" is not one of ${[...SOURCE_TYPES].join(', ')}.`);
      return;
    }
    const prev = byId.get(id);
    if (prev) {
      if (prev.type !== type) errors.push(`line ${line}: journal ${id} was reviewed as ${prev.type} on line ${prev.line} and as ${type} here.`);
      return;
    }
    const row: ReviewedRow = { id, type: type as JournalSourceType, line };
    byId.set(id, row);
    rows.push(row);
  });
  return { rows, blank, errors };
}

function parseHeader(text: string): string[] {
  const header = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return header.split(delimiterOf(text)).map((c) => c.trim().replace(/^"|"$/g, ''));
}

export interface ReviewedPlan {
  /** Journals that exist and still have no source type. */
  apply: ReviewedRow[];
  /** Tagged since the dry run (by a writer or an earlier run); never overwritten. */
  alreadyTagged: (ReviewedRow & { current: JournalSourceType })[];
  notFound: ReviewedRow[];
}

/** Splits reviewed rows by the journals' current source type (id -> type, NULL = untagged). */
export function planReviewedRows(
  rows: readonly ReviewedRow[],
  current: ReadonlyMap<string, JournalSourceType | null>,
): ReviewedPlan {
  const plan: ReviewedPlan = { apply: [], alreadyTagged: [], notFound: [] };
  for (const row of rows) {
    if (!current.has(row.id)) plan.notFound.push(row);
    else {
      const type = current.get(row.id) ?? null;
      if (type === null) plan.apply.push(row);
      else plan.alreadyTagged.push({ ...row, current: type });
    }
  }
  return plan;
}
