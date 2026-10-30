import { describe, expect, it } from 'vitest';
import { isMenuCancellable } from './journalSource';

describe('isMenuCancellable', () => {
  it.each(['MANUAL', 'IMPORT', 'RECURRING', 'CASH_BOOK'])('allows %s', (source) => {
    expect(isMenuCancellable(source)).toBe(true);
  });

  it.each(['OPENING', 'FY_CLOSE', 'DEPRECIATION', 'DEPOSIT_REFUND', 'DEPOSIT_OFFSET', 'SYSTEM_DOC'])('refuses %s', (source) => {
    expect(isMenuCancellable(source)).toBe(false);
  });

  it('refuses an unknown legacy journal (no source type)', () => {
    expect(isMenuCancellable(null)).toBe(false);
    expect(isMenuCancellable(undefined)).toBe(false);
  });
});
