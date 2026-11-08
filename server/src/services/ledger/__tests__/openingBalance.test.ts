import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  postJournal: vi.fn(),
  cancelJournalsInTx: vi.fn(),
  generateDocumentNumber: vi.fn(),
  assertPostableAccount: vi.fn(),
  mappedAccount: vi.fn(),
  fiscalYearOn: vi.fn(),
  setPartyOpeningInTx: vi.fn(),
}));
vi.mock('../openingBalanceParty', () => ({
  setPartyOpeningInTx: mocks.setPartyOpeningInTx,
  findActivePartyOpeningJournals: vi.fn(),
  recordedPartyOpening: vi.fn(),
}));
vi.mock('../postJournal', () => ({ postJournal: mocks.postJournal }));
vi.mock('../cancelJournals', () => ({ cancelJournalsInTx: mocks.cancelJournalsInTx }));
vi.mock('../../../utils/documentNumber', () => ({ generateDocumentNumber: mocks.generateDocumentNumber }));
vi.mock('../../systemAccounts', () => ({ mappedAccount: mocks.mappedAccount }));
vi.mock('../accountGuard', async (orig) => ({
  ...(await orig<typeof import('../accountGuard')>()),
  assertPostableAccount: mocks.assertPostableAccount,
}));
vi.mock('../../../utils/periodGuard', async (orig) => ({
  ...(await orig<typeof import('../../../utils/periodGuard')>()),
  fiscalYearOn: mocks.fiscalYearOn,
}));

import {
  OPENING_ACCOUNT_KIND,
  OPENING_DATE_MISMATCH,
  OPENING_LEGACY_REVIEW,
  openingJournalInstant,
  peekCutoverDate,
  resolveCutoverDate,
  setOpeningBalanceInTx,
} from '../openingBalance';
import { OPENING_ACCOUNT_RULE } from '../accountGuard';
import { FISCAL_YEAR_MISSING } from '../../../utils/periodGuard';
import { businessDayOf } from '../../../utils/businessDate';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const DAY = '2150-01-01';
const KEY = 'OPENING:ACCOUNT:kas';

interface FakeState {
  cutover: string | null;
  openYearStart: string | null;
  rootType: string;
  /** Sum of the ledger before the cut-over day (debit, credit). */
  base: [number, number];
  journals: any[];
  roles: string[];
}

function journal(over: Partial<any> = {}) {
  return {
    id: 'je-old', entryNumber: 'JV-215001-0001', date: openingJournalInstant(DAY), narration: 'Saldo awal akun: 1.1.1 - Kas',
    status: 'Submitted', sourceType: 'OPENING', sourceKey: KEY, fiscalYearId: 'fy', createdAt: new Date(), reversedById: null,
    items: [
      { accountId: 'kas', debit: D(500), credit: D(0), partyId: null },
      { accountId: 'eq', debit: D(0), credit: D(500), partyId: null },
    ],
    ...over,
  };
}

function makeTx(over: Partial<FakeState> = {}) {
  const s: FakeState = { cutover: DAY, openYearStart: DAY, rootType: 'ASSET', base: [0, 0], journals: [], roles: [], ...over };
  const calls: string[] = [];
  const tx = {
    calls,
    state: s,
    companySettings: {
      findUnique: vi.fn(async () => (s.cutover ? { cutoverDate: new Date(`${s.cutover}T00:00:00.000Z`) } : { cutoverDate: null })),
      upsert: vi.fn(async () => { calls.push('upsert-settings'); return {}; }),
    },
    fiscalYear: {
      findFirst: vi.fn(async () =>
        s.openYearStart ? { id: 'fy', name: '2150', startDate: new Date(`${s.openYearStart}T00:00:00.000Z`), endDate: new Date('2150-12-31T00:00:00.000Z') } : null),
    },
    account: { findUnique: vi.fn(async () => ({ rootType: s.rootType })) },
    systemAccountMapping: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.role === 'OPENING_EQUITY') return { accountId: 'eq' };
        const role = s.roles.find((r) => where.role.in.includes(r));
        return role ? { role } : null;
      }),
    },
    journalEntry: { findMany: vi.fn(async () => s.journals) },
    auditLog: { create: vi.fn(async ({ data }: any) => { calls.push(`audit:${data.action}`); return {}; }) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM accounts')) { calls.push('lock-accounts'); return []; }
      if (sql.includes('FROM company_settings')) { calls.push('lock-settings'); return [{ id: 'cs', cutover_date: s.cutover }]; }
      if (sql.includes('accounting_ledger_entries')) return [{ debit: D(s.base[0]), credit: D(s.base[1]) }];
      return [];
    }),
    $executeRaw: vi.fn(async () => { calls.push('store-cutover'); s.cutover = s.openYearStart; return 1; }),
  };
  return tx;
}

const input = (over: Partial<Parameters<typeof setOpeningBalanceInTx>[1]> = {}) => ({
  target: { kind: 'ACCOUNT' as const, accountId: 'kas' },
  amount: '500',
  userId: 'u1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPostableAccount.mockResolvedValue({ id: 'kas', accountNumber: '1.1.1', name: 'Kas', rootType: 'ASSET', isGroup: false, isActive: true });
  mocks.mappedAccount.mockResolvedValue({ id: 'eq', accountNumber: '3.1', name: 'Ekuitas Saldo Awal' });
  mocks.fiscalYearOn.mockResolvedValue({ id: 'fy', name: '2150' });
  mocks.generateDocumentNumber.mockResolvedValue('JV-215001-0002');
  mocks.cancelJournalsInTx.mockImplementation(async (_tx, journals: any[]) => journals.map((j) => j.entryNumber));
  mocks.postJournal.mockImplementation(async (_tx, i: any) => ({ journal: { id: 'je-new', entryNumber: i.entryNumber, items: [] }, fiscalYear: { id: 'fy' } }));
});

afterEach(() => {
  delete process.env.APP_UTC_OFFSET;
});

describe('cut-over date', () => {
  it('peek returns the stored date without writing', async () => {
    const tx = makeTx();
    await expect(peekCutoverDate(tx as any)).resolves.toEqual({ day: DAY, stored: true });
    expect(tx.companySettings.upsert).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('peek derives the start of the earliest open year when none is stored, still without writing', async () => {
    const tx = makeTx({ cutover: null, openYearStart: '2150-01-01' });
    await expect(peekCutoverDate(tx as any)).resolves.toEqual({ day: '2150-01-01', stored: false });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses without an open fiscal year', async () => {
    const tx = makeTx({ cutover: null, openYearStart: null });
    await expect(peekCutoverDate(tx as any)).rejects.toMatchObject({ code: FISCAL_YEAR_MISSING });
  });

  it('resolve stores an empty date once, with one audit row', async () => {
    const tx = makeTx({ cutover: null });
    await expect(resolveCutoverDate(tx as any, 'u1')).resolves.toBe(DAY);
    expect(tx.calls).toEqual(['upsert-settings', 'lock-settings', 'store-cutover', 'audit:SET_CUTOVER_DATE']);
  });

  it('resolve keeps a stored date and writes nothing else', async () => {
    const tx = makeTx({ cutover: '2149-07-01' });
    await expect(resolveCutoverDate(tx as any, 'u1')).resolves.toBe('2149-07-01');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['-03:00', '+09:00', '+07:00'])('openingJournalInstant is the start of the business day at %s', (offset) => {
    process.env.APP_UTC_OFFSET = offset;
    const instant = openingJournalInstant(DAY);
    expect(instant.toISOString()).toBe(new Date(`${DAY}T00:00:00.000${offset}`).toISOString());
    expect(businessDayOf(instant)).toBe(DAY);
    expect(businessDayOf(new Date(instant.getTime() - 1))).toBe('2149-12-31');
  });
});

describe('setOpeningBalanceInTx', () => {
  it('refuses an asOfDate other than the cut-over date before any write', async () => {
    const tx = makeTx();
    await expect(setOpeningBalanceInTx(tx as any, input({ asOfDate: '2150-03-15' }))).rejects.toMatchObject({ code: OPENING_DATE_MISMATCH });
    expect(mocks.postJournal).not.toHaveBeenCalled();
    expect(tx.calls).toEqual([]);
  });

  it('checks the target under OPENING_ACCOUNT_RULE and refuses the opening equity and current profit accounts', async () => {
    for (const role of ['OPENING_EQUITY', 'CURRENT_PROFIT']) {
      const tx = makeTx({ roles: [role] });
      await expect(setOpeningBalanceInTx(tx as any, input())).rejects.toMatchObject({ code: OPENING_ACCOUNT_KIND });
      expect(mocks.assertPostableAccount).toHaveBeenLastCalledWith(tx, 'kas', OPENING_ACCOUNT_RULE);
    }
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });

  it('posts amount minus the ledger before the cut-over day, dated on the cut-over day, keyed', async () => {
    const tx = makeTx({ cutover: null, base: [120, 20] });
    const out = await setOpeningBalanceInTx(tx as any, input({ amount: '500.50' }));
    expect(out.action).toBe('posted');
    expect(out.asOfDate).toBe(DAY);
    const call = mocks.postJournal.mock.calls[0][1];
    expect(call.date.getTime()).toBe(openingJournalInstant(DAY).getTime());
    expect(call.sourceType).toBe('OPENING');
    expect(call.sourceKey).toBe(KEY);
    expect(call.entryNumber).toBe('JV-215001-0002');
    expect(call.lineRules.get('kas')).toBe(OPENING_ACCOUNT_RULE);
    expect(call.periodOptions).toEqual({ ignoreLock: false });
    expect(call.narration).toBe('Saldo awal akun: 1.1.1 - Kas');
    expect(call.lines).toMatchObject([
      { accountId: 'kas', debit: '400.50', credit: null },
      { accountId: 'eq', debit: null, credit: '400.50' },
    ]);
    // number (advisory lock) before the account rows, cut-over stored before the posting
    expect(tx.calls).toEqual(['lock-accounts', 'upsert-settings', 'lock-settings', 'store-cutover', 'audit:SET_CUTOVER_DATE']);
    expect(mocks.generateDocumentNumber.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
  });

  it.each([
    ['ASSET', '-200', { kas: 'credit', eq: 'debit' }],
    ['LIABILITY', '300', { kas: 'credit', eq: 'debit' }],
    ['LIABILITY', '-300', { kas: 'debit', eq: 'credit' }],
    ['EQUITY', '300', { kas: 'credit', eq: 'debit' }],
  ])('%s amount %s puts the target on its side', async (rootType, amount, sides) => {
    const tx = makeTx({ rootType });
    mocks.assertPostableAccount.mockResolvedValue({ id: 'kas', accountNumber: '2.4', name: 'Akun', rootType, isGroup: false, isActive: true });
    await setOpeningBalanceInTx(tx as any, input({ amount }));
    const [target, equity] = mocks.postJournal.mock.calls[0][1].lines;
    expect(target[sides.kas]).toBe(new Prisma.Decimal(amount).abs().toFixed(2));
    expect(equity[sides.eq]).toBe(new Prisma.Decimal(amount).abs().toFixed(2));
  });

  it('is unchanged without a journal when the ledger already holds the amount', async () => {
    const tx = makeTx({ cutover: null, base: [500, 0] });
    const out = await setOpeningBalanceInTx(tx as any, input());
    expect(out).toMatchObject({ action: 'unchanged', journal: null, cancelled: [] });
    expect(mocks.postJournal).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('is unchanged when the keyed journal already holds the same line', async () => {
    const old = journal();
    const tx = makeTx({ journals: [old] });
    const out = await setOpeningBalanceInTx(tx as any, input());
    expect(out).toMatchObject({ action: 'unchanged', journal: old, cancelled: [] });
    expect(mocks.cancelJournalsInTx).not.toHaveBeenCalled();
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });

  it('replaces a keyed journal: cancel first, then post the new amount', async () => {
    const tx = makeTx({ journals: [journal()] });
    const out = await setOpeningBalanceInTx(tx as any, input({ amount: '600' }));
    expect(out).toMatchObject({ action: 'replaced', cancelled: ['JV-215001-0001'] });
    expect(mocks.cancelJournalsInTx.mock.invocationCallOrder[0]).toBeLessThan(mocks.postJournal.mock.invocationCallOrder[0]);
    expect(mocks.postJournal.mock.calls[0][1].lines[0].debit).toBe('600.00');
    expect(mocks.cancelJournalsInTx.mock.calls[0][2].trail).toMatchObject({ cancelledById: 'u1' });
  });

  it('cancels the keyed journal alone when the new amount equals the ledger before the cut-over', async () => {
    const tx = makeTx({ journals: [journal()], base: [100, 0] });
    const out = await setOpeningBalanceInTx(tx as any, input({ amount: '100' }));
    expect(out).toMatchObject({ action: 'cancelled', journal: null, cancelled: ['JV-215001-0001'] });
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });

  it.each([
    ['sourceType OPENING without a key', { sourceKey: null }],
    ['an OB- number with source NULL', { sourceKey: null, sourceType: null, entryNumber: 'OB-215003-0001', narration: 'Saldo Awal: 1.1.1 - Kas' }],
    ['an import narration with source NULL', { sourceKey: null, sourceType: null, entryNumber: 'JV-215003-0004' }],
  ])('refuses a legacy journal (%s) without cancelling or posting', async (_name, over) => {
    const tx = makeTx({ journals: [journal(over)] });
    await expect(setOpeningBalanceInTx(tx as any, input())).rejects.toMatchObject({ code: OPENING_LEGACY_REVIEW });
    expect(mocks.cancelJournalsInTx).not.toHaveBeenCalled();
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });

  it('ignores an unkeyed journal the legacy rules do not call an opening balance', async () => {
    const tx = makeTx({ journals: [journal({ sourceKey: null, sourceType: 'MANUAL', narration: 'Saldo awal kas kecil' })] });
    await expect(setOpeningBalanceInTx(tx as any, input())).resolves.toMatchObject({ action: 'posted' });
  });

  it('throughLock skips the lock date for cancel and post and writes an audit row with the reason', async () => {
    const tx = makeTx({ journals: [journal()] });
    await setOpeningBalanceInTx(tx as any, input({ amount: '700', throughLock: { reason: 'Saldo awal dari auditor' } }));
    expect(mocks.cancelJournalsInTx.mock.calls[0][2].periodOptions).toEqual({ ignoreLock: true });
    expect(mocks.postJournal.mock.calls[0][1].periodOptions).toEqual({ ignoreLock: true });
    const audit = tx.auditLog.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.action === 'OPENING_THROUGH_LOCK');
    expect(audit.newValues).toMatchObject({ reason: 'Saldo awal dari auditor', journalNumber: 'JV-215001-0002', cancelled: ['JV-215001-0001'] });
  });

  it('hands a party target to the party service', async () => {
    const tx = makeTx();
    mocks.setPartyOpeningInTx.mockResolvedValue({ action: 'posted' });
    const target = { kind: 'PARTY' as const, partyId: 'p', subledger: 'AR' as const };
    await expect(setOpeningBalanceInTx(tx as any, input({ target }))).resolves.toEqual({ action: 'posted' });
    expect(mocks.setPartyOpeningInTx).toHaveBeenCalledWith(tx, expect.objectContaining({ target }), 'p', 'AR');
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });
});
