import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Guard for the GL lock-date bypass (owner decision #10, PR-5.7a). periodOptions carries
 * { ignoreLock } into postJournal and the journal voids; only the year-end close and the opening
 * balance service (period.lock holders with a reason) may pass it. The documents without a GL
 * effect that skip the lock through getOpenFiscalYear are not covered here.
 */
const SRC = path.resolve(__dirname, '..');

/** Files that may mention periodOptions: its definitions, its two users and the deposit cancel it passes through. */
const ALLOWED = new Set([
  'services/ledger/postJournal.ts',
  'services/ledger/cancelJournals.ts',
  'utils/journalCancel.ts',
  'routes/fiscalYears.ts',
  'services/ledger/openingBalance.ts',
  // Party targets of the opening balance service (PR-5.11).
  'services/ledger/openingBalanceParty.ts',
  // Passes the option on to the deposit journal void; only the opening balance service sets it, the deposit routes never do.
  'services/depositCancel.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('GL period lock bypass', () => {
  const users = sourceFiles(SRC)
    .filter((f) => /\bperiodOptions\b/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'));

  it('passes periodOptions only from the year-end close and the opening balance service', () => {
    expect(users.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it('keeps the allow-list free of stale entries', () => {
    expect([...ALLOWED].filter((f) => !users.includes(f))).toEqual([]);
  });
});
