// Source guard: every journal writer that knows its origin must keep tagging it. Most writers are
// inline in route handlers, so this checks the source text rather than calling each route; the
// shared posting helper is covered for real in journalSource.integration.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../..');

/** file (relative to src) -> source type -> number of writers tagged with it. */
const EXPECTED: Record<string, Record<string, number>> = {
  'routes/journals.ts': { MANUAL: 1 },
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

describe('journal writers tag their source type', () => {
  for (const [file, tags] of Object.entries(EXPECTED)) {
    it(file, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      for (const [type, n] of Object.entries(tags)) {
        expect(count(text, `sourceType: '${type}'`), `${file} ${type}`).toBe(n);
      }
    });
  }

  it('the year-close journal carries its fiscal-year key', () => {
    const text = readFileSync(join(SRC, 'routes/fiscalYears.ts'), 'utf8');
    expect(text).toMatch(/sourceKey: `FY_CLOSE:\$\{[^}]+\}`/);
  });

  it('postJournalInTx defaults to SYSTEM_DOC', () => {
    const text = readFileSync(join(SRC, 'services/paymentRequestService.ts'), 'utf8');
    expect(text).toContain("sourceType: input.sourceType ?? 'SYSTEM_DOC'");
  });
});
