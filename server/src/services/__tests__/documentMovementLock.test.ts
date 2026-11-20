import { describe, expect, it } from 'vitest';
import { documentMovementLockMessage } from '../documentMovementLock';
import { translateMessage } from '../../i18n/translateMessage';

const mov = (referenceType: string | null, referenceId: string | null, movementType = 'In') => ({ referenceType, referenceId, movementType });

const DOCUMENT_TYPES = [
  'GoodsReceipt', 'DeliveryOrder', 'SalesReturn', 'ProductionRun', 'StockOpname', 'StockTransfer', 'PurchaseInvoice', 'SalesInvoice',
];

describe('documentMovementLockMessage', () => {
  it.each(DOCUMENT_TYPES)('locks %s movements that name their document, for edit and cancel', (type) => {
    expect(documentMovementLockMessage(mov(type, 'doc-1'), 'edit')).toMatch(/tidak dapat diedit per baris/);
    expect(documentMovementLockMessage(mov(type, 'doc-1'), 'cancel')).toMatch(/tidak dapat dibatalkan per baris/);
  });

  it.each(DOCUMENT_TYPES)('leaves a %s reference typed by a client (no referenceId) correctable', (type) => {
    expect(documentMovementLockMessage(mov(type, null), 'edit')).toBeNull();
    expect(documentMovementLockMessage(mov(type, null), 'cancel')).toBeNull();
  });

  it('always locks OpeningBalance and points to a stock adjustment', () => {
    for (const action of ['edit', 'cancel'] as const) {
      expect(documentMovementLockMessage(mov('OpeningBalance', null), action)).toMatch(/saldo awal .*Penyesuaian Stok/);
      expect(documentMovementLockMessage(mov('OpeningBalance', 'x'), action)).toMatch(/Penyesuaian Stok/);
    }
  });

  it('always locks the drift repair write-off (StockDriftRepair) and points to a stock adjustment', () => {
    for (const action of ['edit', 'cancel'] as const) {
      expect(documentMovementLockMessage(mov('StockDriftRepair', null, 'AdjustmentOut'), action)).toMatch(/selisih gudang .*Penyesuaian Stok/);
    }
  });

  it.each(['TransferIn', 'TransferOut'])('always locks %s, whatever its reference', (type) => {
    for (const ref of [mov(null, null, type), mov('StockTransfer', 'st-1', type), mov('JournalEntry', 'x', type)]) {
      expect(documentMovementLockMessage(ref, 'cancel')).toMatch(/transfer stok .*halaman Transfer Stok/);
      expect(documentMovementLockMessage(ref, 'edit')).toMatch(/transfer stok/);
    }
  });

  it('leaves manual and other movements editable', () => {
    expect(documentMovementLockMessage(mov(null, null), 'edit')).toBeNull();
    expect(documentMovementLockMessage(mov('JournalEntry', 'je-1', 'Out'), 'cancel')).toBeNull();
  });

  it('every lock message has an English translation', () => {
    const messages = [
      ...DOCUMENT_TYPES.map((t) => mov(t, 'doc-1')),
      mov('OpeningBalance', null),
      mov('StockDriftRepair', null, 'AdjustmentOut'),
      mov(null, null, 'TransferOut'),
    ].flatMap((m) => (['edit', 'cancel'] as const).map((a) => documentMovementLockMessage(m, a)!));
    for (const text of messages) {
      const en = translateMessage(text, 'en');
      expect(en, text).not.toBe(text);
      expect(en, text).not.toMatch(/\b(dari|halaman|tidak|stok)\b/i);
    }
  });
});
