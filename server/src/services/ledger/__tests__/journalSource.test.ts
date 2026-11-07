import { describe, it, expect } from 'vitest';
import { JournalSourceType } from '@prisma/client';
import {
  classifyLegacyJournal,
  depositRefundSourceKey,
  isMenuCancellableSource,
  isNearImportBatch,
  meetsConfidence,
  parseRemapSourceKey,
  recurringNarrations,
  sourceKeys,
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

  it('a refund narration posted through POST /journals is MANUAL, not DEPOSIT_REFUND', () => {
    expect(classify({ narration: 'Refund UM Pelanggan: PAY-2 - CV B', manualAudit: true }))
      .toMatchObject({ type: 'MANUAL', confidence: 'high' });
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

describe('isMenuCancellableSource', () => {
  it.each(['MANUAL', 'IMPORT', 'RECURRING', 'CASH_BOOK'] as const)('the Journal menu may cancel %s', (t) => {
    expect(isMenuCancellableSource(t)).toBe(true);
  });

  it('every other source type, and an unknown (NULL) one, is cancelled at its source', () => {
    const others = Object.values(JournalSourceType).filter((t) => !['MANUAL', 'IMPORT', 'RECURRING', 'CASH_BOOK'].includes(t));
    expect(others).toEqual(['OPENING', 'FY_CLOSE', 'DEPRECIATION', 'DEPOSIT_REFUND', 'DEPOSIT_OFFSET', 'SYSTEM_DOC']);
    for (const t of others) expect(isMenuCancellableSource(t), t).toBe(false);
    expect(isMenuCancellableSource(null)).toBe(false);
  });
});

describe('sourceKeys', () => {
  it('builds each key in the step 4 format', () => {
    expect(sourceKeys.close('fy-1')).toBe('FY_CLOSE:fy-1');
    expect(sourceKeys.depositRefund('pay-1')).toBe('DEPOSIT_REFUND:pay-1');
    expect(sourceKeys.recurring('tpl-1', '2170-03-31')).toBe('RECURRING:tpl-1:2170-03-31');
    expect(sourceKeys.importGroup('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 3)).toBe('IMPORT:0123456789abcdef:3');
    expect(sourceKeys.remap('AR', 'acc-old', 'acc-new', '2170-03-31')).toBe('REMAP:AR:acc-old:acc-new:21700331');
    expect(sourceKeys.openingAccount('acc-1')).toBe('OPENING:ACCOUNT:acc-1');
    expect(sourceKeys.openingParty('p-1', 'VDEP')).toBe('OPENING:PARTY:p-1:VDEP');
  });

  it('takes the business (WIB) day of a Date, not the UTC day', () => {
    // 2170-03-31 20:00 UTC = 2170-04-01 03:00 WIB
    const late = new Date('2170-03-31T20:00:00Z');
    expect(sourceKeys.recurring('tpl-1', late)).toBe('RECURRING:tpl-1:2170-04-01');
    expect(sourceKeys.remap('CUSTOMER_DEPOSIT', 'a', 'b', late)).toBe('REMAP:CUSTOMER_DEPOSIT:a:b:21700401');
  });

  it('refuses parts that would break parsing', () => {
    expect(() => sourceKeys.close('')).toThrow();
    expect(() => sourceKeys.remap('AR', 'a:b', 'c', '2170-01-01')).toThrow();
    expect(() => sourceKeys.recurring('t', '31/03/2170')).toThrow();
    expect(() => sourceKeys.importGroup('ABC', 1)).toThrow();
    expect(() => sourceKeys.importGroup('0123456789abcdef', 0)).toThrow();
  });

  it('depositRefundSourceKey is the same key, also re-exported by the refund service', async () => {
    const { depositRefundSourceKey: fromService } = await import('../../depositRefundCancel');
    expect(depositRefundSourceKey('pay-1')).toBe('DEPOSIT_REFUND:pay-1');
    expect(fromService('pay-1')).toBe('DEPOSIT_REFUND:pay-1');
  });
});

describe('parseRemapSourceKey', () => {
  it('round-trips a remap key', () => {
    expect(parseRemapSourceKey(sourceKeys.remap('VENDOR_DEPOSIT', 'from', 'to', '2170-12-31'))).toEqual({
      role: 'VENDOR_DEPOSIT', fromAccountId: 'from', toAccountId: 'to', day: '21701231',
    });
  });

  it('round-trips the part number of a split reclass', () => {
    expect(sourceKeys.remap('AR', 'from', 'to', '2170-12-31', 2)).toBe('REMAP:AR:from:to:21701231:2');
    expect(parseRemapSourceKey(sourceKeys.remap('AR', 'from', 'to', '2170-12-31', 2))).toEqual({
      role: 'AR', fromAccountId: 'from', toAccountId: 'to', day: '21701231', part: 2,
    });
    expect(() => sourceKeys.remap('AR', 'a', 'b', '2170-01-01', 0)).toThrow();
    expect(() => sourceKeys.remap('AR', 'a', 'b', '2170-01-01', 1.5)).toThrow();
  });

  it('returns null for anything else', () => {
    for (const key of [null, undefined, '', 'FY_CLOSE:fy-1', 'REMAP:AR:a:b', 'REMAP:AR:a:b:2170-01-01', 'REMAP:AR::b:21700101', 'REMAP:AR:a:b:21700101:x', 'REMAP:AR:a:b:21700101:0', 'REMAP:AR:a:b:21700101:1:2']) {
      expect(parseRemapSourceKey(key), String(key)).toBeNull();
    }
  });
});
