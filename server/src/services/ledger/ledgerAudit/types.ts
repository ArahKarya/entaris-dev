// Shared shapes of the ledger audit (scripts/repair/e2-ledger-audit.ts): one registry of sections,
// each a read-only query over the caller's transaction that returns rows for the one CSV the
// accountant receives.

import type { Prisma } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/**
 * Which switch a section guards. trigger: ledger rows that the ledger balance triggers (PR-4.6)
 * would reject on their next write. tolerance: journals the zero-tolerance journal trigger would
 * reject. A finding gates only while its fiscal year is open; closed years are reported.
 */
export type GateName = 'trigger' | 'tolerance';

export interface AuditOptions {
  /** Only journals / ledger rows created on or after this instant (the daily gate of PR-4.6). */
  since?: Date;
  fiscalYearId?: string;
}

export interface AuditRow {
  section: string;
  /** Machine-readable reason, kebab-case, stable for the accountant's filters. */
  cause: string;
  /** Stable identity of the finding (document id, account id, template id ...). */
  key: string;
  label: string;
  /** Business day (WIB) of the document, or null. */
  date: string | null;
  /** Money the finding is about, 2 decimals, or null. */
  amount: string | null;
  /** How many records the row stands for (1 except for grouped sections). */
  count: number;
  /** Whether the finding's fiscal year is closed; null when no single year applies. */
  yearClosed: boolean | null;
  /** True when this row makes the section's gate fail (open year). */
  gate: boolean;
  detail: string;
}

export interface AuditSection {
  id: string;
  title: string;
  gate: GateName | null;
  run(tx: Tx, opts: AuditOptions): Promise<AuditRow[]>;
}

export const AUDIT_CSV_COLUMNS = ['section', 'cause', 'key', 'label', 'date', 'amount', 'count', 'year_closed', 'gate', 'detail'] as const;
