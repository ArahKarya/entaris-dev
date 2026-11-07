/** PR-5.7b: describeAccountOpening, the read model behind GET /coa/:id/opening (never writes). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({ loadControlAccountMap: vi.fn() }));
vi.mock('../accountGuard', async (orig) => ({
  ...(await orig<typeof import('../accountGuard')>()),
  loadControlAccountMap: mocks.loadControlAccountMap,
}));

import { describeAccountOpening, openingJournalInstant, OPENING_ACCOUNT_KIND, OPENING_LEGACY_REVIEW } from '../openingBalance';
import { ACCOUNT_CONTROL, ACCOUNT_GROUP } from '../accountGuard';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const DAY = '2150-01-01';
const KEY = 'OPENING:ACCOUNT:kas';

const journal = (over: Record<string, unknown> = {}) => ({
  id: 'je-1', entryNumber: 'JV-215001-0001', date: openingJournalInstant(DAY), narration: 'Saldo awal akun: 1.1.1 - Kas',
  status: 'Submitted', sourceType: 'OPENING', sourceKey: KEY, fiscalYearId: 'fy', createdAt: new Date(), reversedById: null,
  items: [
    { accountId: 'kas', debit: D(500), credit: D(0), partyId: null },
    { accountId: 'eq', debit: D(0), credit: D(500), partyId: null },
  ],
  ...over,
});

function makeDb(opts: { cutover?: string | null; journals?: any[]; roleRow?: boolean; account?: any; sameDay?: any[]; base?: number } = {}) {
  const cutover = opts.cutover === undefined ? DAY : opts.cutover;
  const account = opts.account === undefined
    ? { id: 'kas', accountNumber: '1.1.1', name: 'Kas', rootType: 'ASSET', isGroup: false, isActive: true }
    : opts.account;
  const write = vi.fn();
  const db = {
    write,
    companySettings: {
      findUnique: vi.fn(async () => ({ cutoverDate: cutover ? new Date(`${cutover}T00:00:00.000Z`) : null })),
      upsert: write,
      update: write,
    },
    fiscalYear: {
      findFirst: vi.fn(async () => ({ id: 'fy', name: '2150', startDate: new Date(`${DAY}T00:00:00.000Z`), endDate: new Date('2150-12-31T00:00:00.000Z') })),
    },
    account: { findUnique: vi.fn(async () => account) },
    systemAccountMapping: {
      findFirst: vi.fn(async ({ where }: any) => (where.role === 'OPENING_EQUITY' ? { accountId: 'eq' } : opts.roleRow ? { id: 'm' } : null)),
    },
    journalEntry: {
      findMany: vi.fn(async ({ where }: any) => (where.OR && where.sourceKey === undefined && where.AND ? (opts.sameDay ?? []) : (opts.journals ?? []))),
    },
    auditLog: { create: write },
    $queryRaw: vi.fn(async () => [{ debit: D(opts.base ?? 0), credit: D(0) }]),
    $executeRaw: write,
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadControlAccountMap.mockResolvedValue(new Map());
});

describe('describeAccountOpening', () => {
  it('returns the recorded opening and the keyed journals without writing', async () => {
    const db = makeDb({ journals: [journal()] });
    const view = await describeAccountOpening(db as any, 'kas');
    expect(view).toMatchObject({
      cutoverDate: DAY, cutoverStored: true, amount: '500.00', editable: true, reason: null, legacyJournals: [], sameDayOpeningEquity: [],
    });
    expect(view.journals).toEqual([{ id: 'je-1', entryNumber: 'JV-215001-0001', date: DAY, amount: '500.00' }]);
    expect(db.write).not.toHaveBeenCalled();
  });

  it('reports the derived cut-over date as not stored and a null amount without a keyed journal', async () => {
    const db = makeDb({ cutover: null });
    const view = await describeAccountOpening(db as any, 'kas');
    expect(view).toMatchObject({ cutoverDate: DAY, cutoverStored: false, amount: null, journals: [], editable: true });
    expect(db.write).not.toHaveBeenCalled();
  });

  it('starts from the ledger opening when there is no keyed journal (same-day Setoran modal awal)', async () => {
    const view = await describeAccountOpening(makeDb({ base: 500_000_000, sameDay: [{ entryNumber: 'JV-215001-0009' }] }) as any, 'kas');
    expect(view).toMatchObject({ amount: '500000000.00', journals: [], sameDayOpeningEquity: ['JV-215001-0009'] });
  });

  it('lists unkeyed legacy journals and blocks editing with OPENING_LEGACY_REVIEW', async () => {
    const legacy = journal({ id: 'je-old', entryNumber: 'OB-0001', sourceKey: null, sourceType: null, narration: 'Saldo awal Kas' });
    const view = await describeAccountOpening(makeDb({ journals: [legacy] }) as any, 'kas');
    expect(view.legacyJournals.map((j) => j.entryNumber)).toEqual(['OB-0001']);
    expect(view).toMatchObject({ editable: false, reason: OPENING_LEGACY_REVIEW, amount: null });
  });

  it('names the other-way openings on the cut-over day', async () => {
    const view = await describeAccountOpening(makeDb({ sameDay: [{ entryNumber: 'JV-215001-0009' }] }) as any, 'kas');
    expect(view.sameDayOpeningEquity).toEqual(['JV-215001-0009']);
  });

  it('is not editable for the opening equity / current profit account', async () => {
    const view = await describeAccountOpening(makeDb({ roleRow: true }) as any, 'eq');
    expect(view).toMatchObject({ editable: false, reason: OPENING_ACCOUNT_KIND });
  });

  it('is not editable for a control account or a group account (rule code)', async () => {
    mocks.loadControlAccountMap.mockResolvedValue(new Map([['kas', ['AR']]]));
    expect((await describeAccountOpening(makeDb() as any, 'kas')).reason).toBe(ACCOUNT_CONTROL);
    mocks.loadControlAccountMap.mockResolvedValue(new Map());
    const group = { id: 'kas', accountNumber: '1.1', name: 'Kas', rootType: 'ASSET', isGroup: true, isActive: true };
    expect((await describeAccountOpening(makeDb({ account: group }) as any, 'kas')).reason).toBe(ACCOUNT_GROUP);
  });
});
