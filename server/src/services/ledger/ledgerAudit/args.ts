// Command line of scripts/repair/e2-ledger-audit.ts: read-only, so no --apply.

import { parseDateParam, startOfBusinessDay } from '../../../utils/businessDate';
import { sectionIds } from './index';
import type { GateName } from './types';

export interface AuditCliOptions {
  out: string | null;
  sections: string[];
  since: Date | null;
  gate: GateName | null;
}

const GATES: readonly GateName[] = ['trigger', 'tolerance'];

export function parseAuditArgs(argv: readonly string[]): AuditCliOptions {
  const opts: AuditCliOptions = { out: null, sections: [], since: null, gate: null };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = value(i++, a);
    else if (a === '--section') {
      const id = value(i++, a);
      if (!sectionIds().includes(id)) throw new Error(`Unknown section ${id} (known: ${sectionIds().join(', ')})`);
      if (!opts.sections.includes(id)) opts.sections.push(id);
    } else if (a === '--since') {
      const day = value(i++, a);
      if (!parseDateParam(day)) throw new Error(`--since needs a date as YYYY-MM-DD, got ${day}`);
      opts.since = startOfBusinessDay(day);
    } else if (a === '--gate') {
      const g = value(i++, a);
      if (!(GATES as readonly string[]).includes(g)) throw new Error(`--gate must be one of: ${GATES.join(', ')}`);
      opts.gate = g as GateName;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}
