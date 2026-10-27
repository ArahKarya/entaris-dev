import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';
import { BusinessError } from '../errors';
import { assertPeriodOpen, resolveJournalFiscalYear, FISCAL_YEAR_MISSING, PERIOD_CLOSED } from '../periodGuard';
import { translateMessage } from '../../i18n/translateMessage';

const openFy = { id: 'fy-1', name: '2026', isClosed: false };
const closedFy = { id: 'fy-0', name: '2025', isClosed: true };

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
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => openFy });
    await expect(assertPeriodOpen(tx, { fiscalYearId: 'fy-1' }, 'jurnal')).resolves.toBe(openFy);
  });

  it('throws FISCAL_YEAR_MISSING when no fiscal year exists', async () => {
    const { tx } = makeAutoTx();
    const e = await caught(assertPeriodOpen(tx, { date: new Date('2026-03-01T00:00:00Z') }, 'invoice'));
    expect(e.code).toBe(FISCAL_YEAR_MISSING);
    expect(e.message).toMatch(/Tahun buku untuk invoice tidak ditemukan/);
  });

  it('throws PERIOD_CLOSED for a closed fiscal year', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0' }, 'pembayaran'));
    expect(e.code).toBe(PERIOD_CLOSED);
    expect(e.message).toMatch(/Tahun buku 2025 sudah ditutup; pembayaran/);
  });

  it('looks a date up by its WIB business day, without an isClosed filter', async () => {
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy });
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
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy });
    await assertPeriodOpen(tx, { date: new Date('2026-12-31T20:00:00Z') }, 'jurnal');
    expect(fn('fiscalYear.findFirst').mock.calls[0]![0].where).toEqual({
      startDate: { lt: new Date('2027-01-01T17:00:00Z') },
      endDate: { gte: new Date('2026-12-31T17:00:00Z') },
    });
  });

  it('follows APP_UTC_OFFSET', async () => {
    vi.stubEnv('APP_UTC_OFFSET', '+08:00');
    const { tx, fn } = makeAutoTx({ 'fiscalYear.findFirst': () => openFy });
    await assertPeriodOpen(tx, { date: new Date('2026-06-10T16:30:00Z') }, 'jurnal'); // 00:30 WITA 11 Jun
    expect(fn('fiscalYear.findFirst').mock.calls[0]![0].where.endDate).toEqual({ gte: new Date('2026-06-10T16:00:00Z') });
  });

  it('messages translate to English with the label', async () => {
    const { tx } = makeAutoTx({ 'fiscalYear.findUnique': () => closedFy });
    const e = await caught(assertPeriodOpen(tx, { fiscalYearId: 'fy-0' }, 'jurnal'));
    expect(translateMessage(e.message, 'en')).toBe(
      'Fiscal year 2025 is closed; this journal cannot be posted, changed or cancelled in that period. Make the correction in the current period.',
    );
  });
});
