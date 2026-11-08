import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  postJournal: vi.fn(),
  cancelJournalsInTx: vi.fn(),
  cancelDepositPaymentInTx: vi.fn(),
  generateDocumentNumber: vi.fn(),
  mappedAccount: vi.fn(),
  fiscalYearOn: vi.fn(),
  roleAccountIds: vi.fn(),
  adjustPartyOpening: vi.fn(),
  recalcPartyOutstanding: vi.fn(),
}));
vi.mock('../postJournal', () => ({ postJournal: mocks.postJournal }));
vi.mock('../cancelJournals', () => ({ cancelJournalsInTx: mocks.cancelJournalsInTx }));
vi.mock('../../depositCancel', () => ({ cancelDepositPaymentInTx: mocks.cancelDepositPaymentInTx }));
vi.mock('../../../utils/documentNumber', () => ({ generateDocumentNumber: mocks.generateDocumentNumber }));
vi.mock('../../systemAccounts', () => ({ mappedAccount: mocks.mappedAccount, systemAccounts: {} }));
vi.mock('../../../utils/accountBalance', () => ({ recalcPartyOutstanding: mocks.recalcPartyOutstanding }));
vi.mock('../partyRules', async (orig) => ({
  ...(await orig<typeof import('../partyRules')>()),
  roleAccountIds: mocks.roleAccountIds,
}));
vi.mock('../partySides', async (orig) => ({
  ...(await orig<typeof import('../partySides')>()),
  adjustPartyOpening: mocks.adjustPartyOpening,
}));
vi.mock('../../../utils/periodGuard', async (orig) => ({
  ...(await orig<typeof import('../../../utils/periodGuard')>()),
  fiscalYearOn: mocks.fiscalYearOn,
}));

import {
  OPENING_DATE_MISMATCH,
  OPENING_IN_USE,
  OPENING_LEGACY_REVIEW,
  OPENING_NEGATIVE,
  OPENING_PARTY_HAS_HISTORY,
  openingJournalInstant,
  setOpeningBalanceInTx,
} from '../openingBalance';
import { PARTY_TYPE_MISMATCH } from '../partyRules';
import type { OpeningPartyKind } from '../journalSource';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const DAY = '2156-01-01';
const ACCOUNT_OF: Record<string, string> = { AR: 'ar', AP: 'ap', VENDOR_DEPOSIT: 'vdep', CUSTOMER_DEPOSIT: 'cdep', OPENING_EQUITY: 'eq' };

interface FakeState {
  partyType: string;
  openingReceivable: number;
  openingPayable: number;
  openingOutstanding: number;
  history: boolean;
  journals: any[];
  payments: any[];
  used: { refundedAmount: number; applications: number };
  fromReturn: boolean;
}

function journal(kind: OpeningPartyKind, amount: number, over: Partial<any> = {}) {
  const account = { AR: 'ar', AP: 'ap', VDEP: 'vdep', CDEP: 'cdep' }[kind];
  const partyDebit = kind === 'AR' || kind === 'VDEP';
  return {
    id: `je-${kind}`, entryNumber: `JV-215601-000${kind.length}`, date: openingJournalInstant(DAY), narration: `Saldo awal: Mitra`,
    status: 'Submitted', sourceType: 'OPENING', sourceKey: `OPENING:PARTY:p1:${kind}`, fiscalYearId: 'fy', createdAt: new Date(), reversedById: null,
    items: [
      { accountId: account, partyId: 'p1', debit: D(partyDebit ? amount : 0), credit: D(partyDebit ? 0 : amount) },
      { accountId: 'eq', partyId: null, debit: D(partyDebit ? 0 : amount), credit: D(partyDebit ? amount : 0) },
    ],
    ...over,
  };
}

function makeTx(over: Partial<FakeState> = {}) {
  const s: FakeState = {
    partyType: 'Customer', openingReceivable: 0, openingPayable: 0, openingOutstanding: 0, history: false,
    journals: [], payments: [], used: { refundedAmount: 0, applications: 0 }, fromReturn: false, ...over,
  };
  const calls: string[] = [];
  const tx = {
    calls,
    companySettings: {
      findUnique: vi.fn(async () => ({ cutoverDate: new Date(`${DAY}T00:00:00.000Z`) })),
      upsert: vi.fn(async () => ({})),
    },
    fiscalYear: { findFirst: vi.fn(async () => null) },
    party: {
      findUnique: vi.fn(async () => ({ id: 'p1', name: 'Mitra', partyType: s.partyType })),
      findUniqueOrThrow: vi.fn(async () => ({
        openingOutstanding: D(s.openingOutstanding), openingReceivable: D(s.openingReceivable), openingPayable: D(s.openingPayable),
      })),
      update: vi.fn(async ({ data }: any) => { calls.push(`party:${Object.keys(data)[0]}`); return {}; }),
    },
    accountingLedgerEntry: { findFirst: vi.fn(async (_args: any) => (s.history ? { id: 'ale' } : null)) },
    journalEntry: {
      findMany: vi.fn(async () => s.journals),
      findUnique: vi.fn(async ({ where }: any) => s.journals.find((j) => (where.id ? j.id === where.id : j.entryNumber === where.entryNumber)) ?? null),
    },
    payment: {
      // Linked owners, unlinked owners (by payment number), and the old deposit screen's opening deposits.
      findMany: vi.fn(async ({ where }: any) => s.payments.filter((p) => {
        if (where.journalEntryId?.in) return where.journalEntryId.in.includes(p.journalEntryId);
        if (where.journalEntryId === null) return !p.journalEntryId && where.paymentNumber.in.includes(p.paymentNumber);
        return p.accountId === where.accountId && !where.id.notIn.includes(p.id);
      })),
      findUnique: vi.fn(async ({ where }: any) => (where.journalEntryId ? null : {
        refundedAmount: D(s.used.refundedAmount),
        customerDepositApplications: Array.from({ length: s.used.applications }, (_, i) => ({ id: `a${i}` })),
        depositApplications: [],
      })),
      create: vi.fn(async ({ data }: any) => { calls.push('payment:create'); return { id: 'pay-new', ...data }; }),
      update: vi.fn(async ({ data }: any) => ({ id: 'pay-new', ...data })),
    },
    salesReturn: { findFirst: vi.fn(async () => (s.fromReturn ? { id: 'sr' } : null)) },
    auditLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM accounts')) calls.push('lock-accounts');
      else if (sql.includes('FROM parties')) calls.push('lock-party');
      else if (sql.includes('FROM payments')) calls.push('lock-payments');
      else if (sql.includes('FROM company_settings')) return [{ id: 'cs', cutover_date: DAY }];
      return [];
    }),
    $executeRaw: vi.fn(async () => 1),
  };
  return tx;
}

const input = (subledger: OpeningPartyKind, amount: string, over: Record<string, unknown> = {}) => ({
  target: { kind: 'PARTY' as const, partyId: 'p1', subledger },
  amount,
  userId: 'u1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mappedAccount.mockImplementation(async (_tx, role: string) => ({ id: ACCOUNT_OF[role], accountNumber: role, name: role }));
  mocks.roleAccountIds.mockImplementation(async (_tx, role: string) => [ACCOUNT_OF[role]]);
  mocks.fiscalYearOn.mockResolvedValue({ id: 'fy', name: '2156' });
  mocks.generateDocumentNumber.mockImplementation(async (_tx, prefix: string) => `${prefix}-215601-0009`);
  mocks.cancelJournalsInTx.mockImplementation(async (_tx, journals: any[]) => journals.map((j) => j.entryNumber));
  mocks.cancelDepositPaymentInTx.mockImplementation(async (_tx, id: string) => ({ id, journalNumber: `JV-of-${id}` }));
  mocks.postJournal.mockImplementation(async (_tx, i: any) => ({ journal: { id: 'je-new', entryNumber: i.entryNumber, items: [] }, fiscalYear: { id: 'fy' } }));
  mocks.adjustPartyOpening.mockImplementation(async (_tx, _id, _side, delta) => D(delta));
});

describe('party opening balance', () => {
  it('refuses a negative amount, another date and a party type without that side before any write', async () => {
    await expect(setOpeningBalanceInTx(makeTx() as any, input('AR', '-1'))).rejects.toMatchObject({ code: OPENING_NEGATIVE });
    await expect(setOpeningBalanceInTx(makeTx() as any, input('AR', '1', { asOfDate: '2156-03-15' }))).rejects.toMatchObject({ code: OPENING_DATE_MISMATCH });
    await expect(setOpeningBalanceInTx(makeTx() as any, input('AP', '1'))).rejects.toMatchObject({ code: PARTY_TYPE_MISMATCH });
    await expect(setOpeningBalanceInTx(makeTx({ partyType: 'Supplier' }) as any, input('CDEP', '1'))).rejects.toMatchObject({ code: PARTY_TYPE_MISMATCH });
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });

  it('refuses AR when the party has receivable rows before the cut-over date', async () => {
    const tx = makeTx({ history: true });
    await expect(setOpeningBalanceInTx(tx as any, input('AR', '50'))).rejects.toMatchObject({ code: OPENING_PARTY_HAS_HISTORY });
    expect(tx.accountingLedgerEntry.findFirst.mock.calls[0][0].where).toMatchObject({ partyId: 'p1', accountId: { in: ['ar'] }, date: { lt: openingJournalInstant(DAY) } });
  });

  it('posts AR as Dr AR (party) / Cr opening equity, keyed, and sets the receivable opening', async () => {
    const tx = makeTx();
    const out = await setOpeningBalanceInTx(tx as any, input('AR', '50000000'));
    expect(out.action).toBe('posted');
    const call = mocks.postJournal.mock.calls[0][1];
    expect(call).toMatchObject({ sourceType: 'OPENING', sourceKey: 'OPENING:PARTY:p1:AR', partyRule: 'strict', partyEffect: 'none', narration: 'Saldo awal piutang: Mitra' });
    expect(call.date.getTime()).toBe(openingJournalInstant(DAY).getTime());
    expect(call.lines).toMatchObject([
      { accountId: 'ar', partyId: 'p1', debit: '50000000.00', credit: null },
      { accountId: 'eq', debit: null, credit: '50000000.00' },
    ]);
    expect(mocks.adjustPartyOpening).toHaveBeenCalledWith(tx, 'p1', 'RECEIVABLE', D('50000000'));
    expect(mocks.recalcPartyOutstanding).toHaveBeenCalledWith(tx, 'p1');
    expect(tx.calls.slice(0, 2)).toEqual(['lock-accounts', 'lock-party']);
  });

  it('posts AP for a Both party on the payable side only', async () => {
    const tx = makeTx({ partyType: 'Both' });
    await setOpeningBalanceInTx(tx as any, input('AP', '20000000'));
    expect(mocks.postJournal.mock.calls[0][1].lines).toMatchObject([
      { accountId: 'eq', debit: '20000000.00', credit: null },
      { accountId: 'ap', partyId: 'p1', debit: null, credit: '20000000.00' },
    ]);
    expect(mocks.adjustPartyOpening).toHaveBeenCalledWith(tx, 'p1', 'PAYABLE', D('20000000'));
  });

  it('is unchanged for the same keyed journal, and replaces it for another amount', async () => {
    const same = makeTx({ journals: [journal('AR', 500)], openingReceivable: 500, openingOutstanding: 500 });
    await expect(setOpeningBalanceInTx(same as any, input('AR', '500'))).resolves.toMatchObject({ action: 'unchanged', cancelled: [] });
    expect(mocks.cancelJournalsInTx).not.toHaveBeenCalled();

    const other = makeTx({ journals: [journal('AR', 500)], openingReceivable: 500, openingOutstanding: 500 });
    const out = await setOpeningBalanceInTx(other as any, input('AR', '600'));
    expect(out).toMatchObject({ action: 'replaced', cancelled: ['JV-215601-0002'] });
    expect(mocks.cancelJournalsInTx.mock.invocationCallOrder[0]).toBeLessThan(mocks.postJournal.mock.invocationCallOrder[0]);
    expect(mocks.adjustPartyOpening).toHaveBeenCalledWith(other, 'p1', 'RECEIVABLE', D(100));
  });

  it('refuses OPENING_IN_USE when a payment took part of the keyed opening', async () => {
    const lowered = makeTx({ journals: [journal('AR', 500)], openingReceivable: 400, openingOutstanding: 400 });
    await expect(setOpeningBalanceInTx(lowered as any, input('AR', '600'))).rejects.toMatchObject({ code: OPENING_IN_USE });
    // before PR-5.13 a payment remainder lowers opening_outstanding alone
    const undirected = makeTx({ journals: [journal('AR', 500)], openingReceivable: 500, openingOutstanding: 450 });
    await expect(setOpeningBalanceInTx(undirected as any, input('AR', '600'))).rejects.toMatchObject({ code: OPENING_IN_USE });
    expect(mocks.cancelJournalsInTx).not.toHaveBeenCalled();
  });

  it.each([
    ['an unkeyed opening journal', { journals: [journal('AR', 500, { sourceKey: null })], openingReceivable: 500, openingOutstanding: 500 }],
    ['an opening column without a keyed journal', { openingReceivable: 300, openingOutstanding: 300 }],
    ['an undirected opening', { openingOutstanding: 700 }],
    // keyed by the 5.6 audit over a column still undirected: not a payment taking it
    ['a keyed journal over an undirected opening', { journals: [journal('AR', 500)], openingOutstanding: 500 }],
  ])('refuses OPENING_LEGACY_REVIEW for %s', async (_name, state) => {
    const tx = makeTx(state);
    await expect(setOpeningBalanceInTx(tx as any, input('AR', '600'))).rejects.toMatchObject({ code: OPENING_LEGACY_REVIEW });
    expect(mocks.postJournal).not.toHaveBeenCalled();
  });

  it('replaces opening deposits by cancelling their payments, then posts a keyed deposit payment', async () => {
    const legacy = journal('CDEP', 300, { id: 'je-old', sourceKey: null, sourceType: null, narration: 'Saldo Awal Uang Muka Pelanggan: PAY-1 - Mitra' });
    const tx = makeTx({ journals: [legacy], payments: [{ id: 'pay-old', journalEntryId: 'je-old', amount: D(300) }] });
    const out = await setOpeningBalanceInTx(tx as any, input('CDEP', '400', { asOfDate: DAY }));
    expect(out).toMatchObject({ action: 'replaced', cancelled: ['JV-of-pay-old'] });
    expect(mocks.cancelDepositPaymentInTx).toHaveBeenCalledWith(tx, 'pay-old', 'CUSTOMER', expect.objectContaining({ cancelledById: 'u1' }), { periodOptions: { ignoreLock: false } });
    expect(mocks.cancelJournalsInTx).toHaveBeenCalledWith(tx, [], expect.anything());
    expect(tx.payment.create.mock.calls[0][0].data).toMatchObject({ paymentType: 'CustomerDeposit', accountId: 'eq', amount: '400.00', paymentNumber: 'PAY-215601-0009' });
    expect(mocks.postJournal.mock.calls[0][1]).toMatchObject({ sourceKey: 'OPENING:PARTY:p1:CDEP', entryNumber: 'JV-215601-0009' });
    expect(mocks.postJournal.mock.calls[0][1].lines).toMatchObject([
      { accountId: 'eq', debit: '400.00' },
      { accountId: 'cdep', partyId: 'p1', credit: '400.00' },
    ]);
    expect(tx.calls).toEqual(['lock-payments', 'lock-accounts', 'lock-party', 'payment:create', 'party:customerDepositBalance']);
    // The payment rows before the PAY/JV numbers, like the deposit apply and refund routes.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.generateDocumentNumber.mock.invocationCallOrder[0]);
    expect(out.payment).toMatchObject({ journalEntryId: 'je-new' });
    expect(mocks.adjustPartyOpening).not.toHaveBeenCalled();
  });

  it('replaces a journal-less opening deposit of the old deposit screen instead of adding to it', async () => {
    const tx = makeTx({ partyType: 'Supplier', payments: [{ id: 'pay-old', paymentNumber: 'PAY-1', journalEntryId: null, accountId: 'eq', amount: D(10) }] });
    const out = await setOpeningBalanceInTx(tx as any, input('VDEP', '10'));
    expect(out.action).toBe('replaced');
    expect(mocks.cancelDepositPaymentInTx).toHaveBeenCalledWith(tx, 'pay-old', 'VENDOR', expect.anything(), expect.anything());
  });

  it('pairs an unkeyed opening deposit journal with its payment posted before the payment-to-journal link', async () => {
    const legacy = journal('VDEP', 300, { id: 'je-old', entryNumber: 'JV-PAY-1', sourceKey: null, sourceType: null, narration: 'Saldo Awal Uang Muka Vendor: PAY-1 - Mitra' });
    const tx = makeTx({ partyType: 'Supplier', journals: [legacy], payments: [{ id: 'pay-old', paymentNumber: 'PAY-1', journalEntryId: null, accountId: 'cash', amount: D(300) }] });
    const out = await setOpeningBalanceInTx(tx as any, input('VDEP', '400'));
    expect(out.action).toBe('replaced');
    expect(mocks.cancelDepositPaymentInTx).toHaveBeenCalledWith(tx, 'pay-old', 'VENDOR', expect.anything(), expect.anything());
    expect(mocks.cancelJournalsInTx).toHaveBeenCalledWith(tx, [], expect.anything());
  });

  it('keeps the reference, notes and tags typed on an opening deposit; other ones replace it', async () => {
    const details = { referenceNo: 'KW-123', notes: 'sisa DP 2025', salesOrderId: 'so-1', proformaInvoiceId: 'pf-1' };
    const tx = makeTx();
    await setOpeningBalanceInTx(tx as any, input('CDEP', '400', { deposit: details }));
    expect(tx.payment.create.mock.calls[0][0].data).toMatchObject(details);
    expect(mocks.postJournal.mock.calls[0][1].narration).toBe('Saldo awal uang muka Customer: Mitra');

    const keyed = journal('CDEP', 400, { id: 'je-dep' });
    const stored = { id: 'pay-1', journalEntryId: 'je-dep', amount: D(400), ...details };
    await expect(setOpeningBalanceInTx(makeTx({ journals: [keyed], payments: [stored] }) as any, input('CDEP', '400', { deposit: details })))
      .resolves.toMatchObject({ action: 'unchanged' });
    await expect(setOpeningBalanceInTx(makeTx({ journals: [keyed], payments: [stored] }) as any, input('CDEP', '400', { deposit: { ...details, notes: 'lain' } })))
      .resolves.toMatchObject({ action: 'replaced' });
  });

  it('is unchanged for the same keyed opening deposit', async () => {
    const keyed = journal('VDEP', 250, { id: 'je-dep' });
    const tx = makeTx({ partyType: 'Supplier', journals: [keyed], payments: [{ id: 'pay-1', journalEntryId: 'je-dep', amount: D(250), notes: 'Saldo awal uang muka Supplier: Mitra' }] });
    const out = await setOpeningBalanceInTx(tx as any, input('VDEP', '250'));
    expect(out).toMatchObject({ action: 'unchanged', payment: { id: 'pay-1' } });
    expect(mocks.cancelDepositPaymentInTx).not.toHaveBeenCalled();
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it.each([
    ['applied', { used: { refundedAmount: 0, applications: 1 } }],
    ['refunded', { used: { refundedAmount: 10, applications: 0 } }],
    ['from a sales return', { fromReturn: true }],
  ])('refuses OPENING_IN_USE for an opening deposit that is %s', async (_name, state) => {
    const tx = makeTx({ journals: [journal('CDEP', 300, { id: 'je-old' })], payments: [{ id: 'pay-old', journalEntryId: 'je-old', amount: D(300) }], ...state });
    await expect(setOpeningBalanceInTx(tx as any, input('CDEP', '400'))).rejects.toMatchObject({ code: OPENING_IN_USE });
    expect(mocks.cancelDepositPaymentInTx).not.toHaveBeenCalled();
  });

  it('refuses an unkeyed deposit opening journal no payment owns', async () => {
    const tx = makeTx({ journals: [journal('CDEP', 300, { sourceKey: null })] });
    await expect(setOpeningBalanceInTx(tx as any, input('CDEP', '400'))).rejects.toMatchObject({ code: OPENING_LEGACY_REVIEW });
  });

  it('throughLock skips the lock date and writes an audit row on the party', async () => {
    const tx = makeTx();
    await setOpeningBalanceInTx(tx as any, input('AR', '10', { throughLock: { reason: 'Saldo awal dari auditor' } }));
    expect(mocks.postJournal.mock.calls[0][1].periodOptions).toEqual({ ignoreLock: true });
    expect(tx.auditLog.create.mock.calls.map((c: any) => c[0].data)).toContainEqual(
      expect.objectContaining({ action: 'OPENING_THROUGH_LOCK', entityType: 'Party', entityId: 'p1' }),
    );
  });
});
