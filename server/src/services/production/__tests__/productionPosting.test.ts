import { describe, expect, it } from 'vitest';
import { validateJournalLines } from '../../../utils/journalLineRules';
import { computeProductionCosting } from '../productionCosting';
import { productionJournalLines, type ProductionAccounts } from '../productionPosting';

const accounts: ProductionAccounts = { inputs: ['inv-gkp'], outputs: ['inv-beras', 'inv-bekatul'], cogsId: 'cogs', conversionId: 'conv' };
const names = { inputNames: ['GKP'], outputNames: ['Beras', 'Bekatul'], runNumber: 'PR-1' };

/** PRD R1: 1.000 kg GKP @ 6.000 -> 600 kg beras + 100 kg bekatul NRV 2.000, conversion 300/kg. */
function r1(over: { hppOverride?: number; bekatulPrice?: number } = {}) {
  return computeProductionCosting({
    inputs: [{ quantity: 1000, value: 6_000_000 }],
    outputs: [{ quantity: 600 }, { quantity: 100, unitPrice: over.bekatulPrice ?? 2000, isByProduct: true }],
    costs: [{ description: 'Konversi', costSide: 'InputSide', basis: 'InputQty', rate: 300 }],
    hppOverride: over.hppOverride,
  });
}

describe('productionJournalLines', () => {
  it('R1: CR input, DR outputs, the gain to conversion (no COGS rest at 6 dp); postJournal accepts it as balanced', () => {
    const lines = productionJournalLines({ plan: r1().journalPlan, accounts, ...names });
    expect(lines).toEqual([
      { accountId: 'inv-gkp', debit: 0, credit: 6_000_000, description: 'Bahan baku keluar GKP: PR-1' },
      { accountId: 'inv-beras', debit: 6_100_000, credit: 0, description: 'Produksi masuk Beras: PR-1' },
      { accountId: 'inv-bekatul', debit: 200_000, credit: 0, description: 'Produksi masuk Bekatul: PR-1' },
      { accountId: 'conv', debit: 0, credit: 300_000, description: 'Biaya konversi dibebankan: PR-1' },
    ]);
    expect(validateJournalLines(lines).ok).toBe(true);
  });

  it('a gain above the conversion cost credits the rest to COGS', () => {
    // Typed main price 11.000: output 6.600.000 + 200.000 against 6.000.000 -> 300.000 conversion, 500.000 COGS.
    const plan = computeProductionCosting({
      inputs: [{ quantity: 1000, value: 6_000_000 }],
      outputs: [{ quantity: 600, unitPrice: 11_000 }, { quantity: 100, unitPrice: 2000, isByProduct: true }],
      costs: [{ description: 'Konversi', costSide: 'InputSide', basis: 'InputQty', rate: 300 }],
    }).journalPlan;
    const lines = productionJournalLines({ plan, accounts, ...names });
    expect(lines.filter((l) => l.accountId === 'conv' || l.accountId === 'cogs')).toEqual([
      { accountId: 'conv', debit: 0, credit: 300_000, description: 'Biaya konversi dibebankan: PR-1' },
      { accountId: 'cogs', debit: 0, credit: 500_000, description: 'HPP konversi produksi: PR-1' },
    ]);
    expect(validateJournalLines(lines).ok).toBe(true);
  });

  it('a loss (override below cost) is one COGS debit and no conversion credit', () => {
    const lines = productionJournalLines({ plan: r1({ hppOverride: 9000 }).journalPlan, accounts, ...names });
    expect(lines.filter((l) => l.accountId === 'conv')).toEqual([]);
    expect(lines.filter((l) => l.accountId === 'cogs')).toEqual([
      { accountId: 'cogs', debit: 400_000, credit: 0, description: 'HPP rugi produksi: PR-1' },
    ]);
    expect(validateJournalLines(lines).ok).toBe(true);
  });

  it('leaves zero-value lines out and gives no lines for a run without value', () => {
    const plan = computeProductionCosting({ inputs: [{ quantity: 100, value: 0 }], outputs: [{ quantity: 60, unitPrice: 0 }] }).journalPlan;
    expect(productionJournalLines({ plan, accounts, ...names })).toEqual([]);
  });
});
