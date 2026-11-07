// Command line and exit code of scripts/repair/e2-opening-balance-audit.ts, kept free of the
// database so the deploy gate of PR-5.14 (--check-duplicates, exit 1 on a duplicate key) is tested.

export interface OpeningAuditCliOptions {
  apply: boolean;
  approvedBy: string | null;
  keyJournals: string[];
  checkDuplicates: boolean;
  out: string | null;
}

export function parseOpeningAuditArgs(argv: readonly string[]): OpeningAuditCliOptions {
  const opts: OpeningAuditCliOptions = { apply: false, approvedBy: null, keyJournals: [], checkDuplicates: false, out: null };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]?.trim();
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--approved-by') opts.approvedBy = value(i++, a);
    else if (a === '--key-journal') opts.keyJournals.push(value(i++, a));
    else if (a === '--check-duplicates') opts.checkDuplicates = true;
    else if (a === '--out') opts.out = value(i++, a);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.checkDuplicates && argv.length > 1) throw new Error('--check-duplicates takes no other argument');
  return opts;
}

/** 1 while any active OPENING/RECURRING sourceKey is held by more than one journal (gate of PR-5.14). */
export function openingAuditExitCode(duplicates: readonly unknown[]): 0 | 1 {
  return duplicates.length > 0 ? 1 : 0;
}
