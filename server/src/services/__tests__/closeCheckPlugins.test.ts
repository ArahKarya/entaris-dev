// The plug-in entry point registers the receivable and customer deposit close checks (E4-R3) after
// the built-in ones, as blocking and baseline-aware, and the baseline script can name them.
import { describe, expect, it } from 'vitest';
import '../closeCheckPlugins';
import { Prisma } from '@prisma/client';
import { baselineCaptureChecks, closeChecks } from '../fiscalYearClose';
import { subledgerBaselineCovers } from '../ledger/arSubledgerCloseChecks';

describe('close check plug-ins', () => {
  it('registers ar-subledger and customer-deposit-subledger after the built-in checks', () => {
    const ids = closeChecks().map((c) => c.id);
    expect(ids.slice(0, 9)).toContain('do-uninvoiced');
    expect(ids.slice(9)).toEqual(['ar-subledger', 'customer-deposit-subledger']);
  });

  it('makes both blocking and baseline-aware', () => {
    const plugins = closeChecks().filter((c) => c.id.endsWith('subledger'));
    expect(plugins.map((c) => [c.id, c.severity, !!c.baselineAware])).toEqual([
      ['ar-subledger', 'block', true],
      ['customer-deposit-subledger', 'block', true],
    ]);
  });

  it('lets a baseline capture name them with --check', () => {
    expect(baselineCaptureChecks(['ar-subledger', 'customer-deposit-subledger']).map((c) => c.id)).toEqual([
      'ar-subledger',
      'customer-deposit-subledger',
    ]);
  });

  it('covers a difference of the same sign that is no larger than the baseline', () => {
    const covers = (current: string, baseline: string) => subledgerBaselineCovers(new Prisma.Decimal(current), new Prisma.Decimal(baseline));
    expect(closeChecks().filter((c) => c.id.endsWith('subledger')).every((c) => c.baselineCovers === subledgerBaselineCovers)).toBe(true);
    expect(covers('1000000.00', '1000000.00')).toBe(true);
    expect(covers('400000.00', '1000000.00')).toBe(true);
    expect(covers('-400000.00', '-1000000.00')).toBe(true);
    expect(covers('1000000.01', '1000000.00')).toBe(false);
    expect(covers('-400000.00', '1000000.00')).toBe(false);
    expect(covers('400000.00', '-1000000.00')).toBe(false);
  });
});
