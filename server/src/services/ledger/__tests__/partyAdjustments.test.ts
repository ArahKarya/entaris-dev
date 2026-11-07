import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ADJUSTMENT_SIGN, MANUAL_ADJUSTMENT_SOURCES, manualPartyAdjustmentSql, manualPartyAdjustments } from '../partyAdjustments';

const flat = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ');

describe('manualPartyAdjustmentSql', () => {
  it('reads active ledger rows of Submitted MANUAL / IMPORT / RECURRING journals, not journal items', () => {
    const text = flat(manualPartyAdjustmentSql(['ar-1'], 'debit'));
    expect(text).toContain('FROM accounting_ledger_entries ale');
    expect(text).toContain('JOIN journal_entries je ON je.id = ale.reference_id');
    expect(text).not.toContain('journal_entry_accounts');
    expect(text).toContain('ale.is_cancelled = false');
    expect(text).toContain("ale.reference_type = 'JournalEntry'");
    expect(text).toContain("je.status = 'Submitted'");
    expect(text).toContain("je.source_type IN ('MANUAL', 'IMPORT', 'RECURRING')");
    expect(text).toContain('ale.party_id IS NOT NULL');
    expect(text).toContain('GROUP BY ale.party_id');
  });

  it('never counts the cash book, documents or journals without a source type', () => {
    expect(MANUAL_ADJUSTMENT_SOURCES).toEqual(['MANUAL', 'IMPORT', 'RECURRING']);
    const text = flat(manualPartyAdjustmentSql(['ar-1'], 'debit'));
    expect(text).not.toMatch(/CASH_BOOK|SYSTEM_DOC|source_type IS NULL/);
  });

  it('signs by the normal side and binds the account and party ids as parameters', () => {
    const debit = manualPartyAdjustmentSql(['ar-1', 'ar-old'], 'debit', ['p1']);
    expect(flat(debit)).toContain('SUM(ale.debit - ale.credit)');
    expect(debit.values).toEqual(['ar-1', 'ar-old', 'p1']);
    expect(flat(manualPartyAdjustmentSql(['ap-1'], 'credit'))).toContain('SUM(ale.credit - ale.debit)');
    expect(ADJUSTMENT_SIGN).toEqual({ AR: 'debit', VENDOR_DEPOSIT: 'debit', AP: 'credit', CUSTOMER_DEPOSIT: 'credit' });
  });

  it('yields no rows when the role has no account or the party list is empty', () => {
    expect(flat(manualPartyAdjustmentSql([], 'debit'))).toContain('WHERE false');
    expect(flat(manualPartyAdjustmentSql(['ar-1'], 'debit', []))).toContain('WHERE false');
  });
});

describe('manualPartyAdjustments', () => {
  it('uses the role accounts including former ones and returns Decimal per party', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ party_id: 'p1', amount: '5000000.00' }]);
    const tx = {
      systemAccountMapping: { findMany: vi.fn().mockResolvedValue([{ role: 'AR', accountId: 'ar-1', account: { accountNumber: '1.2.1', name: 'Piutang' } }]) },
      journalEntry: { findMany: vi.fn().mockResolvedValue([{ sourceKey: 'REMAP:AR:ar-old:ar-1:20260101', createdAt: new Date('2026-01-01') }]) },
      systemAccountRoleMove: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;
    const out = await manualPartyAdjustments(tx, 'AR', ['p1']);
    expect(out.get('p1')?.toFixed(2)).toBe('5000000.00');
    const [strings, ...args] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const { values } = Prisma.sql(strings, ...args);
    expect(values).toEqual(expect.arrayContaining(['ar-1', 'ar-old', 'p1']));
  });
});
