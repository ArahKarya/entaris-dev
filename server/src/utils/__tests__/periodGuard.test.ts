import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';
import { BusinessError } from '../errors';
import {
  assertPeriodOpen, assertPeriodsOpen, firstOpenBusinessDay, resolveJournalFiscalYear,
  FISCAL_YEAR_MISSING, PERIOD_BUSY, PERIOD_CLOSED, PERIOD_LOCKED, YEAR_LOCK_WAIT_MS,
} from '../periodGuard';
import { getOpenFiscalYear } from '../fiscalYear';
import { translateMessage } from '../../i18n/translateMessage';

const openFy = { id: 'fy-1', name: '2026', isClosed: false };
const closedFy = { id: 'fy-0', name: '2025', isClosed: true };

/** The FOR SHARE row read: answers with the committed isClosed of the given rows, by id. */
const lockRows =
  (...rows: { id: string; isClosed: boolean }[]) =>
  (_sql: TemplateStringsArray, id: string) =>
    rows.filter((r) => r.id === id).map((r) => ({ is_closed: r.isClosed }));

/** The $queryRaw calls as [sql with ? for each value, ...values]. */
const rawCalls = (f: { mock: { calls: unknown[][] } }) =>
  f.mock.calls.map(([sql, ...values]) => [(sql as string[]).join('?'), ...values] as [string, ...unknown[]]);
const forShareCall = (f: { mock: { calls: unknown[][] } }) => rawCalls(f).find(([sql]) => /FOR SHARE/.test(sql))!;

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
  it('returns the open fiscal year by id, not by the date that comes with it', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy, $queryRaw: lockRows(openFy) });
    await expect(assertPeriodOpen(tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-01T00:00:00Z') }, 'jurnal')).resolves.toEqual(openFy);
    expect(fn('fiscalYear.findUnique')).toHaveBeenCalledWith({ where: { id: 'fy-1' } });
    expect(fn('fiscalYear.findFirst')).not.toHaveBeenCalled();
  });

  it('throws FISCAL_YEAR_MISSING when no fiscal year exists', async () => {
    const { tx } = makeAutoTx();
    const e = await caught(assertPeriodOpen(tx, { date: new Date('2026-03-01T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(FISCAL_YEAR_MISSING);
    expect(e.message).toMatch(/Tahun buku untuk invoice tidak ditemukan/);
  });

  it('throws PERIOD_CLOSED for a closed fiscal year', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy, $queryRaw: lockRows(closedFy) });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0', date: new Date('2025-03-01T00:00:00Z') }, 'pembayaran'));
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
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-01T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(PERIOD_CLOSED);
    const [sql, id] = forShareCall(fn('$queryRaw'));
    expect(sql).toMatch(/FROM fiscal_years WHERE id = \? FOR SHARE/);
    expect(id).toBe('fy-1');
  });

  it('locks the row found by date too', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy, $queryRaw: lockRows(openFy) });
    await assertPeriodOpen(tx, { date: new Date('2026-03-01T00:00:00Z') }, 'jurnal');
    expect(forShareCall(fn('$queryRaw'))[1]).toBe('fy-1');
  });

  it('bounds the row-lock wait with a local lock_timeout and puts the previous one back afterwards', async () => {
    const queryRaw = (sql: TemplateStringsArray, id: string) => {
      const text = sql.join('?');
      if (text.includes('current_setting')) return [{ lock_timeout: '7s' }];
      if (text.includes('FOR SHARE')) return lockRows(openFy)(sql, id);
      return [{}];
    };
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy, $queryRaw: queryRaw });
    await assertPeriodOpen(tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-01T00:00:00Z') }, 'jurnal');
    const calls = rawCalls(fn('$queryRaw'));
    const lockAt = calls.findIndex(([sql]) => sql.includes('FOR SHARE'));
    expect(calls[lockAt - 1]).toEqual(["SELECT set_config('lock_timeout', ?, true)", `${YEAR_LOCK_WAIT_MS}ms`]);
    expect(calls[lockAt + 1]).toEqual(["SELECT set_config('lock_timeout', ?, true)", '7s']);
    // Shorter than Prisma's default 5 s interactive-transaction timeout.
    expect(YEAR_LOCK_WAIT_MS).toBeLessThan(5000);
  });

  it('reports PERIOD_BUSY when a close or reopen still holds the year row after the wait', async () => {
    const lockTimeout = Object.assign(new Error('Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`'), {
      code: 'P2010',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'postgres', code: '55P03', originalCode: '55P03' } } },
    });
    const queryRaw = (sql: TemplateStringsArray) => {
      if (sql.join('?').includes('FOR SHARE')) throw lockTimeout;
      return [{}];
    };
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy, $queryRaw: queryRaw });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-01T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(PERIOD_BUSY);
    expect(e.message).toBe('Tahun buku 2026 sedang ditutup atau dibuka kembali; invoice belum bisa diproses. Coba lagi beberapa saat lagi.');
    expect(translateMessage(e.message, 'en')).toBe('Fiscal year 2026 is being closed or reopened; this invoice cannot be processed yet. Try again in a moment.');
  });

  it('passes any other error of the row lock through unchanged', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 'P1017' });
    const queryRaw = (sql: TemplateStringsArray) => {
      if (sql.join('?').includes('FOR SHARE')) throw boom;
      return [{}];
    };
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy, $queryRaw: queryRaw });
    await expect(assertPeriodOpen(tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-01T00:00:00Z') }, 'invoice')).rejects.toBe(boom);
  });

  it('reports FISCAL_YEAR_MISSING when the row is gone by the time it is locked', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy });
    expect((await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-01T00:00:00Z') }, 'jurnal'))).code).toBe(FISCAL_YEAR_MISSING);
  });

  it('messages translate to English with the label', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy, $queryRaw: lockRows(closedFy) });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0', date: new Date('2025-03-01T00:00:00Z') }, 'jurnal'));
    expect(translateMessage(e.message, 'en')).toBe(
      'Fiscal year 2025 is closed; this journal cannot be posted, changed or cancelled in that period. Make the correction in the current period.',
    );
  });
});

describe('assertPeriodsOpen', () => {
  it('checks each distinct date and fiscal year once, skipping empty refs', async () => {
    const { tx, fn } = makeAutoTx({
      'fiscalYear.findUnique': () => openFy,
      'fiscalYear.findFirst': () => openFy,
      $queryRaw: lockRows(openFy),
    });
    const day = new Date('2026-03-01T00:00:00Z');
    await assertPeriodsOpen(tx, [{ date: day }, { fiscalYearId: 'fy-1', date: day }, null, { date: new Date(day) }, { fiscalYearId: 'fy-1', date: new Date('2026-04-01T00:00:00Z') }, undefined], 'mutasi stok');
    expect(fn('fiscalYear.findFirst')).toHaveBeenCalledTimes(1);
    expect(fn('fiscalYear.findUnique')).toHaveBeenCalledTimes(1);
  });

  it('throws PERIOD_CLOSED when any of the references is in a closed year', async () => {
    const { tx } = makeAutoTx({
      'fiscalYear.findFirst': () => openFy,
      'fiscalYear.findUnique': () => closedFy,
      $queryRaw: lockRows(openFy, closedFy),
    });
    const e = await caught(assertPeriodsOpen(tx, [{ date: new Date('2026-03-01T00:00:00Z') }, { fiscalYearId: 'fy-0', date: new Date('2025-03-01T00:00:00Z') }], 'surat jalan'));
    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/surat jalan di periode ini/);
  });
});

/** FOR SHARE reads: the fiscal-year row by id, and the period_lock row answering `lockDate`. */
const withLock =
  (lockDate: string | null, ...rows: { id: string; isClosed: boolean }[]) =>
  (sql: TemplateStringsArray, id: string) =>
    sql.join('?').includes('period_lock') ? [{ lock_date: lockDate }] : lockRows(...rows)(sql, id);

describe('period lock date', () => {
  // Lock date 31 Mar 2026: postings dated up to that business day are rejected.
  const lockedTx = (lockDate: string | null = '2026-03-31') =>
    makeAutoTx({ 'fiscalYear.findFirst': () => openFy, 'fiscalYear.findUnique': () => openFy, $queryRaw: withLock(lockDate, openFy) });

  it('rejects a 15 Mar invoice with PERIOD_LOCKED and an English translation', async () => {
    const e = await caught(assertPeriodOpen(lockedTx().tx, { date: new Date('2026-03-15T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(PERIOD_LOCKED);
    expect(e.message).toBe(
      'Periode s.d. 2026-03-31 sudah dikunci; invoice bertanggal 2026-03-15 tidak bisa diposting, diubah, atau dibatalkan. Minta pemegang hak Kunci Periode memundurkan kunci.',
    );
    expect(translateMessage(e.message, 'en')).toBe(
      'The period up to 2026-03-31 is locked; this invoice dated 2026-03-15 cannot be posted, changed or cancelled. Ask a holder of the Period Lock right to move the lock back.',
    );
  });

  it('rejects the lock date itself and accepts the day after', async () => {
    expect((await caught(assertPeriodOpen(lockedTx().tx, { date: new Date('2026-03-31T00:00:00Z') }, 'jurnal'))).code).toBe(PERIOD_LOCKED);
    await expect(assertPeriodOpen(lockedTx().tx, { date: new Date('2026-04-01T00:00:00Z') }, 'jurnal')).resolves.toEqual(openFy);
  });

  it('compares the WIB business day: 1 Apr 03:00 WIB (31 Mar UTC) is open, 31 Mar 23:30 WIB is locked', async () => {
    await expect(assertPeriodOpen(lockedTx().tx, { date: new Date('2026-03-31T20:00:00Z') }, 'jurnal')).resolves.toEqual(openFy);
    expect((await caught(assertPeriodOpen(lockedTx().tx, { date: new Date('2026-03-31T16:30:00Z') }, 'jurnal'))).code).toBe(PERIOD_LOCKED);
  });

  it('checks the document date on cancel paths that pass the stored fiscal year', async () => {
    const e = await caught(assertPeriodOpen(lockedTx().tx, { fiscalYearId: 'fy-1', date: new Date('2026-03-20T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(PERIOD_LOCKED);
  });

  it('share-locks the period_lock row', async () => {
    const { tx, fn } = lockedTx();
    await assertPeriodOpen(tx, { date: new Date('2026-05-01T00:00:00Z') }, 'jurnal');
    expect(rawCalls(fn('$queryRaw')).map(([sql]) => sql)).toContain('SELECT lock_date::text AS lock_date FROM period_lock WHERE id = 1 FOR SHARE');
  });

  it('passes every date when no lock is set or the row is missing', async () => {
    await expect(assertPeriodOpen(lockedTx(null).tx, { date: new Date('2020-01-01T00:00:00Z') }, 'jurnal')).resolves.toEqual(openFy);
    const { tx } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy, $queryRaw: lockRows(openFy) });
    await expect(assertPeriodOpen(tx, { date: new Date('2020-01-01T00:00:00Z') }, 'jurnal')).resolves.toEqual(openFy);
  });

  it('ignoreLock skips the lock date but not the fiscal-year checks', async () => {
    const { tx, fn } = lockedTx();
    await expect(getOpenFiscalYear(tx, new Date('2026-03-15T00:00:00Z'), { ignoreLock: true })).resolves.toEqual(openFy);
    expect(rawCalls(fn('$queryRaw')).some(([sql]) => sql.includes('period_lock'))).toBe(false);
    const closed = makeAutoTx({ 'fiscalYear.findFirst': () => closedFy, $queryRaw: withLock('2026-03-31', closedFy) });
    expect((await caught(getOpenFiscalYear(closed.tx, new Date('2025-03-15T00:00:00Z'), { ignoreLock: true }))).code).toBe(PERIOD_CLOSED);
  });

  it('getOpenFiscalYear applies the lock by default', async () => {
    expect((await caught(getOpenFiscalYear(lockedTx().tx, new Date('2026-02-10T00:00:00Z')))).code).toBe(PERIOD_LOCKED);
  });

  it('a closed year reports PERIOD_CLOSED before the lock date is read', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy, $queryRaw: withLock('2026-03-31', closedFy) });
    expect((await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0', date: new Date('2025-03-01T00:00:00Z') }, 'jurnal'))).code).toBe(PERIOD_CLOSED);
    expect(rawCalls(fn('$queryRaw')).some(([sql]) => sql.includes('period_lock'))).toBe(false);
  });

  it('assertPeriodsOpen checks the lock for every distinct day, even within one fiscal year', async () => {
    const { tx, fn } = lockedTx();
    const e = await caught(
      assertPeriodsOpen(tx, [{ fiscalYearId: 'fy-1', date: new Date('2026-04-10T00:00:00Z') }, { fiscalYearId: 'fy-1', date: new Date('2026-03-10T00:00:00Z') }], 'produksi'),
    );
    expect(e.code).toBe(PERIOD_LOCKED);
    expect(e.message).toMatch(/produksi bertanggal 2026-03-10/);
    expect(fn('fiscalYear.findUnique')).toHaveBeenCalledTimes(1);
  });

  it('firstOpenBusinessDay is the day after the lock date, or null without a lock', async () => {
    expect(await firstOpenBusinessDay(lockedTx('2026-03-31').tx)).toBe('2026-04-01');
    expect(await firstOpenBusinessDay(lockedTx('2026-12-31').tx)).toBe('2027-01-01');
    expect(await firstOpenBusinessDay(lockedTx(null).tx)).toBeNull();
  });
});
