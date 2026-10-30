import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';
import { BusinessError } from '../errors';
import { assertPeriodOpen, resolveJournalFiscalYear, FISCAL_YEAR_MISSING, PERIOD_CLOSED } from '../periodGuard';
import { translateMessage } from '../../i18n/translateMessage';

const openFy = { id: 'fy-1', name: '2026', isClosed: false };
const closedFy = { id: 'fy-0', name: '2025', isClosed: true };

/** The FOR SHARE row read: answers with the committed isClosed of the given rows, by id. */
const lockRows =
  (...rows: { id: string; isClosed: boolean }[]) =>
  (_sql: TemplateStringsArray, id: string) =>
    rows.filter((r) => r.id === id).map((r) => ({ is_closed: r.isClosed }));

async function caught(p: Promise<unknown>): Promise<BusinessError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e;
    throw e;
  }
  throw new Error('expected a BusinessError');
}

afterEach(() => vi.unstubAllEnvs());

describe('assertPeriodOpen', () => {
  it('returns the open fiscal year by id', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy, $queryRaw: lockRows(openFy) });
    await expect(assertPeriodOpen(tx, { fiscalYearId: 'fy-1' }, 'jurnal')).resolves.toEqual(openFy);
  });

  it('throws FISCAL_YEAR_MISSING when no fiscal year exists', async () => {
    const { tx } = makeAutoTx();
    const e = await caught(assertPeriodOpen(tx, { date: new Date('2026-03-01T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(FISCAL_YEAR_MISSING);
    expect(e.message).toMatch(/Tahun buku untuk invoice tidak ditemukan/);
  });

  it('throws PERIOD_CLOSED for a closed fiscal year', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy, $queryRaw: lockRows(closedFy) });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0' }, 'pembayaran'));
    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/Tahun buku 2025 sudah ditutup; pembayaran/);
  });

  it('looks a date up by its WIB business day, without an isClosed filter', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy, $queryRaw: lockRows(openFy) });
    // 31 Dec 23:30 WIB = 31 Dec 16:30Z -> business day 31 Dec.
    await resolveJournalFiscalYear(tx, new Date('2026-12-31T16:30:00Z'));
    expect(fn('fiscalYear.findFirst')).toHaveBeenCalledWith({
      where: {
        startDate: { lt: new Date('2026-12-31T17:00:00Z') },
        endDate: { gte: new Date('2026-12-30T17:00:00Z') },
      },
      orderBy: { startDate: 'desc' },
    });
  });

  it('moves 1 Jan 03:00 WIB (UTC 31 Dec) into 1 Jan', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy, $queryRaw: lockRows(openFy) });
    await assertPeriodOpen(tx, { date: new Date('2026-12-31T20:00:00Z') }, 'jurnal');
    expect(fn('fiscalYear.findFirst').mock.calls[0]![0].where).toEqual({
      startDate: { lt: new Date('2027-01-01T17:00:00Z') },
      endDate: { gte: new Date('2026-12-31T17:00:00Z') },
    });
  });

  it('follows APP_UTC_OFFSET', async () => {
    vi.stubEnv('APP_UTC_OFFSET', '+08:00');
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy, $queryRaw: lockRows(openFy) });
    await assertPeriodOpen(tx, { date: new Date('2026-06-10T16:30:00Z') }, 'jurnal'); // 00:30 WITA 11 Jun
    expect(fn('fiscalYear.findFirst').mock.calls[0]![0].where.endDate).toEqual({ gte: new Date('2026-06-10T16:00:00Z') });
  });

  describe('with a negative APP_UTC_OFFSET', () => {
    // Bounds at UTC midnight (seed, POST /fiscal-years) and at local midnight (-05:00).
    const years = [
      { id: 'fy26', name: '2026', isClosed: false, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
      { id: 'fy27', name: '2027', isClosed: false, startDate: new Date('2027-01-01T05:00:00Z'), endDate: new Date('2027-12-31T05:00:00Z') },
    ];
    const rowsTx = () =>
      makeAutoTx({
        'fiscalYear.findFirst': ({ where }: any) =>
          years
            .filter((y) => y.startDate < where.startDate.lt && y.endDate >= where.endDate.gte)
            .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())[0] ?? null,
        $queryRaw: lockRows(...years),
      }).tx;

    it('keeps a date-only value on its own calendar day', async () => {
      vi.stubEnv('APP_UTC_OFFSET', '-05:00');
      expect((await resolveJournalFiscalYear(rowsTx(), new Date('2027-01-01'))).id).toBe('fy27');
      expect((await resolveJournalFiscalYear(rowsTx(), new Date('2026-12-31'))).id).toBe('fy26');
      expect((await resolveJournalFiscalYear(rowsTx(), new Date('2027-12-31'))).id).toBe('fy27');
    });

    it('places a timed instant by its local day', async () => {
      vi.stubEnv('APP_UTC_OFFSET', '-05:00');
      // 1 Jan 03:00Z = 31 Dec 22:00 local; 1 Jan 05:30Z = 1 Jan 00:30 local.
      expect((await resolveJournalFiscalYear(rowsTx(), new Date('2027-01-01T03:00:00Z'))).id).toBe('fy26');
      expect((await resolveJournalFiscalYear(rowsTx(), new Date('2027-01-01T05:30:00Z'))).id).toBe('fy27');
    });
  });

  it('share-locks the fiscal-year row and trusts its committed isClosed over the first read', async () => {
    // A close committed while this transaction waited on the row lock.
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy, $queryRaw: lockRows({ ...openFy, isClosed: true }) });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-1' }, 'invoice'));
    expect(e.code).toBe(PERIOD_CLOSED);
    const [sql, id] = fn('$queryRaw').mock.calls[0]!;
    expect(sql.join('?')).toMatch(/FROM fiscal_years WHERE id = \? FOR SHARE/);
    expect(id).toBe('fy-1');
  });

  it('locks the row found by date too', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy, $queryRaw: lockRows(openFy) });
    await assertPeriodOpen(tx, { date: new Date('2026-03-01T00:00:00Z') }, 'jurnal');
    expect(fn('$queryRaw').mock.calls[0]![1]).toBe('fy-1');
  });

  it('reports FISCAL_YEAR_MISSING when the row is gone by the time it is locked', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy });
    expect((await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-1' }, 'jurnal'))).code).toBe(FISCAL_YEAR_MISSING);
  });

  it('messages translate to English with the label', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy, $queryRaw: lockRows(closedFy) });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0' }, 'jurnal'));
    expect(translateMessage(e.message, 'en')).toBe(
      'Fiscal year 2025 is closed; this journal cannot be posted, changed or cancelled in that period. Make the correction in the current period.',
    );
  });
});
