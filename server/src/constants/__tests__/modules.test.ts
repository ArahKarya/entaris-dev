import { describe, it, expect } from 'vitest';
import { BACKFILL_CAPS, CAPABILITY_KEYS, DEFAULT_CAPS, DEFAULT_MATRIX } from '../modules';

// The tax report needs the Reports view right (E7-R10). CI has no built-in roles (they come from
// ensureRbacSeed at boot), so this pins which built-in roles keep the report on a fresh database.
describe('DEFAULT_MATRIX reports right', () => {
  it('Accountant and Viewer can view reports', () => {
    expect(DEFAULT_MATRIX.Accountant.reports).toBe('view');
    expect(DEFAULT_MATRIX.Viewer.reports).toBe('view');
  });

  it('StaffProduksi has no reports right', () => {
    expect(DEFAULT_MATRIX.StaffProduksi).not.toHaveProperty('reports');
  });
});

// Manual journals to control accounts (owner decision step 4 #1): Admin only, like period.lock.
describe('journal.control capability', () => {
  it('is in the catalogue but not a default or backfilled capability of any role', () => {
    expect(CAPABILITY_KEYS).toContain('journal.control');
    expect(Object.values(DEFAULT_CAPS).flat()).not.toContain('journal.control');
    expect(BACKFILL_CAPS.flatMap((b) => b.caps)).not.toContain('journal.control');
  });
});
