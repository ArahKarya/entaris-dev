import { describe, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => ({ date: null as Date | null }));
vi.mock('../../../lib/prisma', () => ({
  prisma: { periodLock: { findUnique: vi.fn(async () => ({ lockDate: lock.date })) } },
}));

import { DemoSetupError, ensurePeriodUnlocked } from '../scenario/setup';

// Span of 90 days plus 4 days of early fixed-asset purchases: the first demo day is 10 Jul.
const today = new Date(2026, 9, 12);

describe('ensurePeriodUnlocked', () => {
  it('passes with no lock or a lock before the first demo day', async () => {
    lock.date = null;
    await expect(ensurePeriodUnlocked(today)).resolves.toBeUndefined();
    lock.date = new Date('2026-07-09T00:00:00Z');
    await expect(ensurePeriodUnlocked(today)).resolves.toBeUndefined();
  });

  it('refuses a lock on or after the first demo day, naming both dates', async () => {
    lock.date = new Date('2026-07-10T00:00:00Z');
    await expect(ensurePeriodUnlocked(today)).rejects.toThrow(DemoSetupError);
    lock.date = new Date('2026-09-30T00:00:00Z');
    await expect(ensurePeriodUnlocked(today)).rejects.toThrow(/2026-09-30.*2026-07-10/);
  });
});
