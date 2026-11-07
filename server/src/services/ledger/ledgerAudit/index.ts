// The one ledger audit (E2-R3 and neighbours). A registry of read-only sections; a later PR adds a
// section by adding one file under sections/ and one line here. Everything takes the caller's
// transaction and writes nothing. scripts/repair/e2-ledger-audit.ts is the command line around it.

import { csvCell } from '../../../utils/csv';
import { aleGroupsSection } from './sections/aleGroups';
import { journalSubCentSection } from './sections/journalSubCent';
import { journalTooFewLinesSection } from './sections/journalTooFewLines';
import { ledgerOnGroupOrInactiveSection } from './sections/ledgerOnGroupOrInactive';
import { manualPartyLinesSection } from './sections/manualPartyLines';
import { nonJournalAleSection } from './sections/nonJournalAle';
import { recurringTemplatesSection } from './sections/recurringTemplates';
import { sourceNullSection } from './sections/sourceNull';
import { AUDIT_CSV_COLUMNS, type AuditOptions, type AuditRow, type AuditSection, type GateName, type Tx } from './types';

export type { AuditOptions, AuditRow, AuditSection, GateName } from './types';

export const LEDGER_AUDIT_SECTIONS: readonly AuditSection[] = [
  aleGroupsSection,
  journalSubCentSection,
  journalTooFewLinesSection,
  ledgerOnGroupOrInactiveSection,
  manualPartyLinesSection,
  nonJournalAleSection,
  recurringTemplatesSection,
  sourceNullSection,
];

export interface SectionResult {
  id: string;
  title: string;
  gate: GateName | null;
  rows: AuditRow[];
  /** Rows that make the section's gate fail. */
  gateRows: number;
}

export interface LedgerAuditResult {
  sections: SectionResult[];
}

export const sectionIds = (): string[] => LEDGER_AUDIT_SECTIONS.map((s) => s.id);

/** Runs the chosen sections (all when `only` is empty), in registry order. */
export async function runLedgerAudit(tx: Tx, opts: AuditOptions & { only?: readonly string[] } = {}): Promise<LedgerAuditResult> {
  const { only = [], ...auditOpts } = opts;
  const chosen = only.length === 0 ? LEDGER_AUDIT_SECTIONS : LEDGER_AUDIT_SECTIONS.filter((s) => only.includes(s.id));
  const sections: SectionResult[] = [];
  for (const s of chosen) {
    const rows = await s.run(tx, auditOpts);
    sections.push({ id: s.id, title: s.title, gate: s.gate, rows, gateRows: s.gate ? rows.filter((r) => r.gate).length : 0 });
  }
  return { sections };
}

/** Exit code of a run: 1 when a section guarding `gate` has a finding in an open year, else 0. */
export function gateExitCode(result: LedgerAuditResult, gate: GateName | null): 0 | 1 {
  if (!gate) return 0;
  return result.sections.some((s) => s.gate === gate && s.gateRows > 0) ? 1 : 0;
}

export function auditCsv(result: LedgerAuditResult): string {
  const lines = result.sections.flatMap((s) =>
    s.rows.map((r) =>
      [r.section, r.cause, r.key, r.label, r.date, r.amount, r.count, r.yearClosed === null ? '' : r.yearClosed ? 'yes' : 'no', r.gate ? 'yes' : 'no', r.detail]
        .map(csvCell)
        .join(','),
    ),
  );
  return `${[AUDIT_CSV_COLUMNS.join(','), ...lines].join('\n')}\n`;
}
