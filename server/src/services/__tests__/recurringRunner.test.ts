import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, runDueTemplates } = vi.hoisted(() => ({
  db: { user: { findFirst: vi.fn() } },
  runDueTemplates: vi.fn(),
}));
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../recurringExecute', () => ({ runDueTemplates }));

import { runDueRecurringTemplates } from '../recurringRunner';

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findFirst.mockResolvedValue({ id: 'admin-1' });
});

describe('runDueRecurringTemplates', () => {
  it('runs the due templates as the first active Admin through the one execution path and counts the outcomes', async () => {
    const now = new Date('2026-11-06T19:00:00.000Z');
    runDueTemplates.mockResolvedValue([
      { templateId: 't-1', name: 'Sewa', outcome: 'posted' },
      { templateId: 't-2', name: 'Rusak', outcome: 'failed', code: 'JOURNAL_UNBALANCED', error: 'x' },
      { templateId: 't-3', name: 'Invoice', outcome: 'skipped' },
      { templateId: 't-4', name: 'Listrik', outcome: 'posted' },
    ]);
    expect(await runDueRecurringTemplates(now)).toEqual({ executed: 2, failed: 1, skipped: 1 });
    expect(runDueTemplates).toHaveBeenCalledWith('admin-1', now);
  });

  it('runs nothing without an active Admin to attribute the journals to', async () => {
    db.user.findFirst.mockResolvedValue(null);
    expect(await runDueRecurringTemplates()).toEqual({ executed: 0, failed: 0, skipped: 0 });
    expect(runDueTemplates).not.toHaveBeenCalled();
  });
});
