import { describe, it, expect } from 'vitest';
import {
  classifyLegacyJournal,
  isNearImportBatch,
  meetsConfidence,
  recurringNarrations,
  type LegacyJournalFacts,
} from '../journalSource';

const base: LegacyJournalFacts = {
  entryNumber: 'JV-202603-0001',
  narration: 'Bayar sewa kantor',
  fiscalYearId: 'fy-1',
  createdAt: new Date('2026-03-10T03:00:00Z'), // 10:00 WIB
  depreciationEntryCount: 0,
  inCashBookDraft: false,
  openingStockMovement: false,
  hasDocumentLink: false,
  manualAudit: false,
  recurringAudit: false,
  matchesRecurringTemplate: false,
  nearImportBatch: false,
};
const classify = (over: Partial<LegacyJournalFacts>) => classifyLegacyJournal({ ...base, ...over });

describe('classifyLegacyJournal', () => {
  it('CLOSE- is FY_CLOSE with the fiscal-year source key', () => {
    expect(classify({ entryNumber: 'CLOSE-2025' })).toEqual({
      type: 'FY_CLOSE', confidence: 'high', reason: 'number CLOSE-', sourceKey: 'FY_CLOSE:fy-1',
    });
  });

  it('DEP- or a depreciation link is DEPRECIATION', () => {
    expect(classify({ entryNumber: 'DEP-000123' }).type).toBe('DEPRECIATION');
    expect(classify({ depreciationEntryCount: 1 }).type).toBe('DEPRECIATION');
  });

  it('OB- is OPENING', () => {
    expect(classify({ entryNumber: 'OB-202601-0001' })).toMatchObject({ type: 'OPENING', confidence: 'high' });
  });

  it('cash book link or narration is CASH_BOOK', () => {
    expect(classify({ inCashBookDraft: true }).type).toBe('CASH_BOOK');
    expect(classify({ narration: 'Buku Kas DKB-202603-0001 #2: bensin' }).type).toBe('CASH_BOOK');
  });

  it.each(['Refund UM Vendor: PAY-1 - PT A', 'Refund UM Pelanggan: PAY-2 - CV B'])('"%s" is DEPOSIT_REFUND', (n) => {
    expect(classify({ narration: n }).type).toBe('DEPOSIT_REFUND');
  });

  it.each(['Offset UM Vendor: PAY-1 → PI-1', 'Offset UM Pelanggan: PAY-2 → SI-2'])('"%s" is DEPOSIT_OFFSET', (n) => {
    expect(classify({ narration: n }).type).toBe('DEPOSIT_OFFSET');
  });

  it.each([
    'Saldo awal piutang: CV A',
    'Saldo awal hutang: PT B',
    'Saldo awal uang muka vendor: PT B',
    'Saldo awal uang muka pelanggan: CV A',
    'Saldo awal akun: 1.1.1 - Kas',
    'Saldo awal stok: BRG-1 - Beras',
  ])('"%s" is OPENING', (n) => {
    expect(classify({ narration: n }).type).toBe('OPENING');
  });

  it('an opening stock movement is OPENING even though it is a stock link', () => {
    expect(classify({ openingStockMovement: true, hasDocumentLink: true }).type).toBe('OPENING');
  });

  it('demo "Saldo awal aset tetap" is not OPENING', () => {
    expect(classify({ narration: 'Saldo awal aset tetap: Mesin', manualAudit: true }).type).toBe('MANUAL');
  });

  it('document link, document number or system narration is SYSTEM_DOC', () => {
    expect(classify({ hasDocumentLink: true }).type).toBe('SYSTEM_DOC');
    expect(classify({ entryNumber: 'JV-STT-202603-0001' }).type).toBe('SYSTEM_DOC');
    expect(classify({ entryNumber: 'JV-COGS-SI-1' }).type).toBe('SYSTEM_DOC');
    expect(classify({ narration: 'Revisi harga PI-202603-0001' }).type).toBe('SYSTEM_DOC');
    expect(classify({ narration: '[BATAL] Pembatalan uang muka PAY-1' }).type).toBe('SYSTEM_DOC');
  });

  it('a POST /journals audit row is MANUAL (high)', () => {
    expect(classify({ manualAudit: true })).toMatchObject({ type: 'MANUAL', confidence: 'high' });
  });

  it('a recurring execute audit row is RECURRING (high)', () => {
    expect(classify({ recurringAudit: true })).toMatchObject({ type: 'RECURRING', confidence: 'high' });
  });

  it('template narration is RECURRING, medium only at the 02:00 WIB run', () => {
    expect(classify({ matchesRecurringTemplate: true, createdAt: new Date('2026-03-01T19:00:05Z') }))
      .toMatchObject({ type: 'RECURRING', confidence: 'medium' });
    expect(classify({ matchesRecurringTemplate: true })).toMatchObject({ type: 'RECURRING', confidence: 'low' });
  });

  it('near an import batch is IMPORT (medium)', () => {
    expect(classify({ nearImportBatch: true })).toMatchObject({ type: 'IMPORT', confidence: 'medium' });
  });

  it('anything else is MANUAL with low confidence', () => {
    expect(classify({})).toMatchObject({ type: 'MANUAL', confidence: 'low', sourceKey: null });
  });
});

describe('helpers', () => {
  it('meetsConfidence ranks low < medium < high', () => {
    expect(meetsConfidence('high', 'medium')).toBe(true);
    expect(meetsConfidence('medium', 'high')).toBe(false);
    expect(meetsConfidence('low', 'low')).toBe(true);
  });

  it('isNearImportBatch needs the same user and a journal created shortly before', () => {
    const at = new Date('2026-03-10T05:00:00Z');
    const batches = [{ userId: 'u1', at }];
    expect(isNearImportBatch(new Date('2026-03-10T04:58:00Z'), 'u1', batches)).toBe(true);
    expect(isNearImportBatch(new Date('2026-03-10T04:58:00Z'), 'u2', batches)).toBe(false);
    expect(isNearImportBatch(new Date('2026-03-10T05:01:00Z'), 'u1', batches)).toBe(false);
    expect(isNearImportBatch(new Date('2026-03-10T04:00:00Z'), 'u1', batches)).toBe(false);
  });

  it('recurringNarrations collects template names and narrations', () => {
    const set = recurringNarrations([
      { name: 'Sewa', templateData: { narration: 'Sewa gudang bulanan' } },
      { name: 'Listrik', templateData: {} },
    ]);
    expect([...set].sort()).toEqual(['Listrik', 'Sewa', 'Sewa gudang bulanan']);
  });
});
