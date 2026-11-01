// The plug-in entry point registers the receivable and customer deposit close checks (E4-R3) after
// the built-in ones, as blocking and baseline-aware, and the baseline script can name them.
import { describe, expect, it } from 'vitest';
import '../closeCheckPlugins';
import { baselineCaptureChecks, closeChecks } from '../fiscalYearClose';

describe('close check plug-ins', () => {
  it('registers ar-subledger and customer-deposit-subledger after the built-in checks', () => {
    const ids = closeChecks().map((c) => c.id);
    expect(ids.slice(0, 8)).toContain('do-uninvoiced');
    expect(ids.slice(8)).toEqual(['ar-subledger', 'customer-deposit-subledger']);
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
});
