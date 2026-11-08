// Command line of scripts/repair/e1-stt-cancel-model.ts, kept free of the database so it is tested.

export interface SttCancelCliOptions {
  apply: boolean;
  approvedBy: string | null;
  includeAleFix: boolean;
  /** Fiscal year name; only pairs with a journal booked to it. */
  fiscalYear: string | null;
  out: string | null;
}

export function parseSttCancelArgs(argv: readonly string[]): SttCancelCliOptions {
  const opts: SttCancelCliOptions = { apply: false, approvedBy: null, includeAleFix: false, fiscalYear: null, out: null };
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
    else if (a === '--include-ale-fix') opts.includeAleFix = true;
    else if (a === '--fy') opts.fiscalYear = value(i++, a);
    else if (a === '--out') opts.out = value(i++, a);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Use either --apply or --dry-run.');
  if (opts.apply && !opts.approvedBy) throw new Error('--apply needs --approved-by "<accountant name>"');
  if (opts.includeAleFix && !opts.apply) throw new Error('--include-ale-fix only goes with --apply');
  return opts;
}
