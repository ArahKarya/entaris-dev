// Source guard: every journal writer that knows its origin must keep tagging it. Most writers are
// inline in route handlers, so this checks the source text rather than calling each route; the
// shared posting helper is covered for real in journalSource.integration.test.ts.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../..');

/** file (relative to src) -> source type -> number of writers tagged with it. */
const EXPECTED: Record<string, Record<string, number>> = {
  'routes/recurring.ts': { RECURRING: 1 },
  'services/recurringRunner.ts': { RECURRING: 1 },
  'routes/import/journals.ts': { IMPORT: 1 },
  'routes/fiscalYears.ts': { FY_CLOSE: 1 },
  'routes/fixedAssets.ts': { DEPRECIATION: 2 },
  'routes/customerDeposits.ts': { DEPOSIT_OFFSET: 1, DEPOSIT_REFUND: 1 },
  'routes/vendorDeposits.ts': { DEPOSIT_OFFSET: 1, DEPOSIT_REFUND: 1 },
  'routes/coa.ts': { OPENING: 1 },
  'routes/import/coa.ts': { OPENING: 1 },
  'routes/import/parties.ts': { OPENING: 3 },
  'services/openingStockImport.ts': { OPENING: 1 },
  'services/cashBookDraftPost.ts': { CASH_BOOK: 1 },
};

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Production .ts files under src (tests excluded), relative to src. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [relative(SRC, full)] : [];
  });
}

/** The argument text of every call `name(` in `text` (balanced parentheses), definitions excluded. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    out.push(text.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** Writers through the shared posting path: the source type is a required argument of each call. */
const POSTING_CALLS = ['postJournal', 'createManualJournalInTx'] as const;

describe('journal writers tag their source type', () => {
  for (const [file, tags] of Object.entries(EXPECTED)) {
    it(file, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      for (const [type, n] of Object.entries(tags)) {
        expect(count(text, `sourceType: '${type}'`), `${file} ${type}`).toBe(n);
      }
    });
  }

  it('every call of postJournal / createManualJournalInTx names its sourceType', () => {
    const calls = sourceFiles().flatMap((file) => {
      const text = readFileSync(join(SRC, file), 'utf8');
      return POSTING_CALLS.flatMap((name) => callArgs(text, name).map((args) => ({ file, name, args })));
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.args, `${c.file} ${c.name}`).toMatch(/sourceType\b/);
  });

  it('the Journal menu posts MANUAL through createManualJournalInTx', () => {
    const text = readFileSync(join(SRC, 'routes/journals.ts'), 'utf8');
    const args = callArgs(text, 'createManualJournalInTx');
    expect(args).toHaveLength(1);
    expect(args[0]).toContain("sourceType: 'MANUAL'");
  });

  it('the year-close journal posts through postJournal with its fiscal-year key', () => {
    const args = callArgs(readFileSync(join(SRC, 'routes/fiscalYears.ts'), 'utf8'), 'postJournal');
    expect(args).toHaveLength(1);
    expect(args[0]).toContain("sourceType: 'FY_CLOSE'");
    expect(args[0]).toContain('sourceKey: sourceKeys.close(year.id)');
    expect(args[0]).toContain('periodOptions: { ignoreLock: true }');
  });

  it('postJournalInTx defaults to SYSTEM_DOC', () => {
    const text = readFileSync(join(SRC, 'services/paymentRequestService.ts'), 'utf8');
    expect(text).toContain("sourceType: input.sourceType ?? 'SYSTEM_DOC'");
  });
});
