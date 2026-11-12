import path from 'path';
import { describe, expect, it } from 'vitest';
import { scanDir } from './messageScanner';
import { hasTranslation } from '../translateMessage';

/**
 * Every user-facing message literal in the server (`error:` / `message:` properties, thrown errors,
 * handleRouteError fallbacks, Zod messages) must have an English entry in src/i18n/messages, so a
 * new Indonesian message cannot ship untranslated. Add the entry, or list the text below with a reason.
 */
const IGNORED = new Set<string>([
  // Already English: internal/diagnostic text, never shown as Indonesian copy.
  'CORS: origin {0} not allowed',
  'Token has been revoked.',
  'Invalid CSRF token.',
  '{0} timed out',
  '{0} spawn error: {1}',
  'File write error: {0}',
  '{0} exited {1}: {2}',
  'restore timed out',
  '{0} error: {1}',
  'Bot detected.',
  'No Admin user available to attribute public inquiry to',
  'Inventory item {0} not found during COGS backfill settle.',
  'HTTP {0}',
  // Programming error at module load (duplicate year-close check id), never reaches a client.
  'Close check {0} is already registered',
  // Programming errors of the sourceKey builders (services/ledger/journalSource.ts sourceKeys), never reach a client.
  'sourceKey part "{0}" must be non-empty and contain no ":"',
  'sourceKey day "{0}" must be YYYY-MM-DD',
  'sourceKey import hash must be lowercase SHA-256 hex',
  'sourceKey import group "{0}" must be a positive integer',
  'sourceKey remap part "{0}" must be a positive integer',
  // Programming error of the legacy cancel pair SQL fragment (services/ledger/legacyCxlPair.ts), never reaches a client.
  'Invalid SQL alias {0}',
  // Refusals of the one-time baseline capture script (scripts/repair/e1-close-baseline.ts), CLI only.
  '{0} is not a baseline-aware close check (known: {1})',
  '--allow-existing only goes with --check <id>',
  'The baseline already has rows for {0}; a check is captured once.',
  'The baseline already has {0} row(s); it is captured once. To capture a check added later, pass --check <id> --allow-existing.',
  // Refusals of the --apply repairs without an approver (services/salesInvoiceAudit.ts,
  // scripts/repair/e5-pi-approval-amount.ts, scripts/repair/e2-rupiah-only-check.ts), and the audit
  // user of the party side recalculation (services/ledger/partySides.ts), CLI only.
  '--apply needs --approved-by "<accountant name>"',
  'No active Admin user to record the audit rows under.',
  // Refusals of the read-only ledger audit command line (scripts/repair/e2-ledger-audit.ts,
  // services/ledger/ledgerAudit/args.ts), CLI only.
  '{0} needs a value',
  'Unknown section {0} (known: {1})',
  '--since needs a date as YYYY-MM-DD, got {0}',
  '--gate must be one of: {0}',
  'Unknown argument: {0}',
  // Refusals of the opening-balance audit command line (scripts/repair/e2-opening-balance-audit.ts,
  // services/ledger/openingBalanceAuditArgs.ts) and of scripts/repair/e2-party-side-recalc.ts, CLI only.
  'Use either --apply or --dry-run.',
  '--check-duplicates takes no other argument',
  // Refusal of the legacy STT cancel command line (services/ledger/sttCancelLegacyArgs.ts), CLI only.
  '--include-ale-fix only goes with --apply',
  // Party opening audit (scripts/repair/e2-party-opening-audit.ts, services/ledger/partyOpeningAudit.ts),
  // CLI only: its other refusals are the shared ones above; this one rolls an --apply batch back.
  'Party {0} is {1} after the {2} repair; nothing was applied.',
  // Item vs warehouse drift repair (services/inventory/stockDriftRepair.ts, run by
  // scripts/repair/e3-stock-drift.ts), CLI only; its other refusals are the shared ones above.
  'Unknown warehouse_code: {0}. Nothing was applied.',
  'The plan is stale; nothing was applied. {0}',
  'Drift left after the repair on {0}; nothing was applied.',
]);

/** Machine-readable error codes (`engine_busy`, `turn_in_progress`) are mapped to text by the client. */
const isErrorCode = (text: string) => /^[a-z0-9_]+$/.test(text);

const SRC = path.resolve(__dirname, '../..');

describe('server message dictionary coverage', () => {
  const messages = scanDir(SRC);

  it('finds the message literals', () => {
    expect(messages.length).toBeGreaterThan(1000);
    expect(messages.some((m) => m.file.startsWith('routes/'))).toBe(true);
  });

  it('has an English entry for every message', () => {
    const missing = [
      ...new Set(
        messages
          .filter((m) => !isErrorCode(m.text) && !IGNORED.has(m.text) && !hasTranslation(m.text))
          .map((m) => `${m.file}:${m.line}  ${m.text}`),
      ),
    ];
    expect(missing, `Add these to src/i18n/messages/*.ts:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps the ignore list free of stale entries', () => {
    const texts = new Set(messages.map((m) => m.text));
    expect([...IGNORED].filter((t) => !texts.has(t))).toEqual([]);
  });
});
