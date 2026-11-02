import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => {
  const tx = { journalEntry: { create: vi.fn() }, accountingLedgerEntry: { createMany: vi.fn() } };
  const db = {
    _tx: tx,
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    recurringTemplate: { findMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { db };
});
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../utils/accountBalance', () => ({ updateBalancesForItems: vi.fn() }));
vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async () => 'JV-1') }));
vi.mock('../../utils/fiscalYear', () => ({ getOpenFiscalYear: vi.fn(async () => ({ id: 'fy-1' })) }));

import { runDueRecurringTemplates } from '../recurringRunner';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const template = (debit: number, credit: number) => ({
  id: 't-1', name: 'Sewa', templateType: 'journal', frequency: 'monthly', dayOfMonth: null,
  templateData: { narration: 'Sewa', items: [{ accountId: A, debit, credit: 0 }, { accountId: B, debit: 0, credit }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findFirst.mockResolvedValue({ id: 'admin-1' });
  db.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);
  db._tx.journalEntry.create.mockResolvedValue({ id: 'je-1', items: [] });
});

describe('runDueRecurringTemplates', () => {
  it('does not post a stored template that is out of balance', async () => {
    db.recurringTemplate.findMany.mockResolvedValue([template(10_000_000, 9_000_000)]);
    const r = await runDueRecurringTemplates();
    expect(r).toMatchObject({ executed: 0, failed: 1 });
    expect(db._tx.journalEntry.create).not.toHaveBeenCalled();
    expect(db.recurringTemplate.update).not.toHaveBeenCalled();
  });

  it('posts a balanced template', async () => {
    db.recurringTemplate.findMany.mockResolvedValue([template(100, 100)]);
    const r = await runDueRecurringTemplates();
    expect(r).toMatchObject({ executed: 1, failed: 0 });
    expect(db._tx.journalEntry.create).toHaveBeenCalledTimes(1);
  });
});
