import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { getOpenFiscalYear } from '../fiscalYear';
import { BusinessError } from '../errors';
import { FISCAL_YEAR_MISSING, PERIOD_CLOSED } from '../periodGuard';

interface Fy { id: string; name?: string; startDate: Date; endDate: Date; isClosed: boolean }
interface Where { isClosed?: boolean; startDate?: { lt?: Date }; endDate?: { gte?: Date } }

/**
 * In-memory findFirst that honours the where/orderBy shape the period guard sends, plus the
 * FOR SHARE row read that answers with the committed isClosed (`lockedAs` overrides it by id).
 */
function txWith(years: Fy[], lockedAs: Record<string, boolean> = {}): Prisma.TransactionClient {
  const findFirst = async ({ where, orderBy }: { where: Where; orderBy?: { startDate: 'asc' | 'desc' } }) => {
    const hits = years.filter(
      (fy) =>
        (where.isClosed === undefined || fy.isClosed === where.isClosed) &&
        (!where.startDate?.lt || fy.startDate < where.startDate.lt) &&
        (!where.endDate?.gte || fy.endDate >= where.endDate.gte),
    );
    if (orderBy?.startDate === 'desc') hits.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
    return hits[0] ?? null;
  };
  const $queryRaw = vi.fn(async (_sql: TemplateStringsArray, id: string) =>
    years.filter((fy) => fy.id === id).map((fy) => ({ is_closed: lockedAs[fy.id] ?? fy.isClosed })),
  );
  return { fiscalYear: { findFirst }, $queryRaw } as unknown as Prisma.TransactionClient;
}

// FYs as stored by `new Date('YYYY-MM-DD')` (UTC midnight) and at WIB midnight.
const utcMidnight: Fy[] = [
  { id: 'fy2026', startDate: new Date('2026-01-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), isClosed: false },
  { id: 'fy2027', startDate: new Date('2027-01-01T00:00:00.000Z'), endDate: new Date('2027-12-31T00:00:00.000Z'), isClosed: false },
];
const wibMidnight: Fy[] = [
  { id: 'fy2026', startDate: new Date('2025-12-31T17:00:00.000Z'), endDate: new Date('2026-12-30T17:00:00.000Z'), isClosed: false },
  { id: 'fy2027', startDate: new Date('2026-12-31T17:00:00.000Z'), endDate: new Date('2027-12-30T17:00:00.000Z'), isClosed: false },
];

const DEC31_2330_WIB = new Date('2026-12-31T16:30:00.000Z');
const JAN1_0300_WIB = new Date('2026-12-31T20:00:00.000Z');

describe('getOpenFiscalYear', () => {
  beforeEach(() => {
    process.env.APP_UTC_OFFSET = '+07:00';
  });
  afterEach(() => {
    delete process.env.APP_UTC_OFFSET;
  });

  describe.each([
    ['UTC midnight', utcMidnight],
    ['WIB midnight', wibMidnight],
  ])('FYs stored at %s', (_label, years) => {
    it('puts 31 Dec 23:30 WIB in the old year', async () => {
      await expect(getOpenFiscalYear(txWith(years), DEC31_2330_WIB)).resolves.toMatchObject({ id: 'fy2026' });
    });

    it('puts 1 Jan 03:00 WIB in the new year', async () => {
      await expect(getOpenFiscalYear(txWith(years), JAN1_0300_WIB)).resolves.toMatchObject({ id: 'fy2027' });
    });

    it('matches date-only values stored at UTC midnight on the first and last day', async () => {
      await expect(getOpenFiscalYear(txWith(years), new Date('2026-01-01'))).resolves.toMatchObject({ id: 'fy2026' });
      await expect(getOpenFiscalYear(txWith(years), new Date('2026-12-31'))).resolves.toMatchObject({ id: 'fy2026' });
      await expect(getOpenFiscalYear(txWith(years), new Date('2027-01-01'))).resolves.toMatchObject({ id: 'fy2027' });
    });
  });

  it('prefers the later year when an odd end time overlaps the next year', async () => {
    const years: Fy[] = [
      { id: 'old', startDate: new Date('2026-01-01T00:00:00.000Z'), endDate: new Date('2026-12-31T23:59:59.999Z'), isClosed: false },
      { id: 'new', startDate: new Date('2027-01-01T00:00:00.000Z'), endDate: new Date('2027-12-31T00:00:00.000Z'), isClosed: false },
    ];
    await expect(getOpenFiscalYear(txWith(years), JAN1_0300_WIB)).resolves.toMatchObject({ id: 'new' });
  });

  it('rejects a closed year with PERIOD_CLOSED and a missing one with FISCAL_YEAR_MISSING', async () => {
    const closed = utcMidnight.map((fy) => ({ ...fy, name: fy.id, isClosed: fy.id === 'fy2026' }));
    await expect(getOpenFiscalYear(txWith(closed), DEC31_2330_WIB)).rejects.toMatchObject({ code: PERIOD_CLOSED });
    await expect(getOpenFiscalYear(txWith([]), DEC31_2330_WIB)).rejects.toMatchObject({ code: FISCAL_YEAR_MISSING });
    await expect(getOpenFiscalYear(txWith([]), DEC31_2330_WIB)).rejects.toBeInstanceOf(BusinessError);
  });

  it('names the document in the message, "dokumen" by default', async () => {
    await expect(getOpenFiscalYear(txWith([]), DEC31_2330_WIB)).rejects.toThrow(/Tahun buku untuk dokumen tidak ditemukan/);
    await expect(getOpenFiscalYear(txWith([]), DEC31_2330_WIB, { label: 'invoice' })).rejects.toThrow(/Tahun buku untuk invoice tidak ditemukan/);
  });

  it('share-locks the year row and trusts its committed isClosed, so a close that won the race rejects the posting', async () => {
    const tx = txWith(utcMidnight, { fy2026: true });
    await expect(getOpenFiscalYear(tx, DEC31_2330_WIB)).rejects.toMatchObject({ code: PERIOD_CLOSED });
    const [sql, id] = (tx.$queryRaw as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((sql as string[]).join('?')).toMatch(/FROM fiscal_years WHERE id = \? FOR SHARE/);
    expect(id).toBe('fy2026');
  });
});
