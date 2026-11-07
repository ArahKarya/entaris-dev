// Year-close checklist runner without a database (E1-R8, PR-8b): the built-in registry and its
// order, the baseline rule (same key and amount skips an item, a different amount does not), the
// item cap, block vs warn, and the CLOSE_CHECKLIST_FAILED error. The checks' queries are covered by
// fiscalYearCloseChecklist.integration.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';
import { systemAccounts } from '../systemAccounts';
import {
  CLOSE_CHECKLIST_FAILED,
  CLOSE_CHECK_ITEM_LIMIT,
  CloseChecklistFailedError,
  assertBaselineCaptureAllowed,
  assertCloseChecklistPasses,
  baselineCaptureChecks,
  captureCloseBaseline,
  closeCheckYear,
  closeChecks,
  registerCloseCheck,
  runCloseChecklist,
  type CloseCheck,
} from '../fiscalYearClose';

const YEAR = { id: 'fy-1', name: '2025', startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31'), isClosed: false };

afterEach(() => vi.restoreAllMocks());

/** Mapping present, so the built-in system-accounts check passes on the auto tx. */
function mapped() {
  vi.spyOn(systemAccounts, 'getAccounts').mockResolvedValue([{ id: 'a', accountNumber: '3.x', name: 'x' }]);
}

describe('close check registry', () => {
  it('registers the built-in checks first, in order', () => {
    // The plug-in checks below register while the file is collected, so they come after these.
    expect(closeChecks().slice(0, 8).map((c) => [c.id, c.severity, !!c.baselineAware])).toEqual([
      ['prev-year-open', 'block', false],
      ['drafts-ledger', 'block', false],
      ['drafts-other', 'warn', false],
      ['depreciation-unposted', 'block', false],
      ['ledger-balanced', 'block', true],
      ['ale-vs-journal', 'block', true],
      ['system-accounts', 'block', false],
      ['do-uninvoiced', 'warn', false],
    ]);
  });

  it('refuses a duplicate id', () => {
    expect(() => registerCloseCheck({ ...closeChecks()[0]!, run: async () => ({ count: 0, items: [] }) })).toThrow(/already registered/);
  });

  it('gives the year its WIB business-day bounds', () => {
    expect(closeCheckYear(YEAR)).toMatchObject({
      startDay: '2025-01-01',
      endDay: '2025-12-31',
      gte: new Date('2024-12-31T17:00:00.000Z'),
      lt: new Date('2025-12-31T17:00:00.000Z'),
    });
  });
});

describe('runCloseChecklist', () => {
  // Plug-in checks with fixed outcomes; registered once for this file (the registry is module state).
  const plugged = {
    block: [] as Array<{ key: string; amount: string }>,
    warn: 0,
    many: 0,
  };
  const blockCheck: CloseCheck = {
    id: 'test-baselined-block',
    severity: 'block',
    baselineAware: true,
    run: async () => ({ count: plugged.block.length, items: plugged.block.map((i) => ({ ...i, kind: 'Test', label: i.key })) }),
  };
  const warnCheck: CloseCheck = {
    id: 'test-warn',
    severity: 'warn',
    run: async () => ({ count: plugged.warn, items: Array.from({ length: plugged.warn }, (_, n) => ({ key: `w${n}`, kind: 'Test', label: `w${n}` })) }),
  };
  const manyCheck: CloseCheck = {
    id: 'test-many',
    severity: 'warn',
    run: async () => ({
      count: plugged.many,
      items: Array.from({ length: Math.min(plugged.many, CLOSE_CHECK_ITEM_LIMIT) }, (_, n) => ({ key: `m${n}`, kind: 'Test', label: `m${n}` })),
    }),
  };
  registerCloseCheck(blockCheck);
  registerCloseCheck(warnCheck);
  registerCloseCheck(manyCheck);

  function tx(baseline: Array<{ itemKey: string; amount: string }> = [], closeAccount: { isActive: boolean; isGroup: boolean } = { isActive: true, isGroup: false }) {
    return makeAutoTx({
      // The mapped close accounts, as system-accounts loads them.
      'account.findUnique': (args: { where: { id: string } }) =>
        ({ id: args.where.id, accountNumber: '3.x', name: 'x', rootType: 'EQUITY', ...closeAccount }),
      'closeCheckBaseline.findMany': (args: { where: { checkId: string; itemKey: { in: string[] } } }) =>
        args.where.checkId === blockCheck.id
          ? baseline.filter((b) => args.where.itemKey.in.includes(b.itemKey)).map((b) => ({ ...b, amount: new Prisma.Decimal(b.amount) }))
          : [],
    });
  }

  it('an empty year can close; warnings never block', async () => {
    mapped();
    plugged.block = [];
    plugged.warn = 2;
    plugged.many = 0;
    const list = await runCloseChecklist(tx().tx, YEAR);
    expect(list).toMatchObject({ canClose: true, blocking: 0, warnings: 1, fiscalYear: { id: 'fy-1', startDay: '2025-01-01', endDay: '2025-12-31' } });
    expect(list.checks.find((c) => c.id === 'test-warn')).toMatchObject({ status: 'fail', count: 2 });
    await expect(assertCloseChecklistPasses(tx().tx, YEAR)).resolves.toMatchObject({ canClose: true });
  });

  it('skips an item the baseline has with the same amount, not one whose amount changed', async () => {
    mapped();
    plugged.warn = 0;
    plugged.block = [{ key: 'j1', amount: '10.00' }, { key: 'j2', amount: '5.00' }];
    const list = await runCloseChecklist(tx([{ itemKey: 'j1', amount: '10' }, { itemKey: 'j2', amount: '4.99' }]).tx, YEAR);
    const result = list.checks.find((c) => c.id === blockCheck.id)!;
    expect(result).toMatchObject({ status: 'fail', count: 1, baselinedCount: 1 });
    // Counted items first, then the baselined ones.
    expect(result.items.map((i) => [i.key, i.baselined ?? false])).toEqual([['j2', false], ['j1', true]]);
    expect(list).toMatchObject({ canClose: false, blocking: 1 });

    const all = await runCloseChecklist(tx([{ itemKey: 'j1', amount: '10' }, { itemKey: 'j2', amount: '5' }]).tx, YEAR);
    expect(all.checks.find((c) => c.id === blockCheck.id)).toMatchObject({ status: 'ok', count: 0, baselinedCount: 2 });
    expect(all.canClose).toBe(true);
  });

  it('a closed year cannot close even with nothing failing', async () => {
    mapped();
    plugged.block = [];
    const list = await runCloseChecklist(tx().tx, { ...YEAR, isClosed: true });
    expect(list).toMatchObject({ canClose: false, blocking: 0 });
  });

  it('keeps the full count but caps the items', async () => {
    mapped();
    plugged.many = CLOSE_CHECK_ITEM_LIMIT + 25;
    const list = await runCloseChecklist(tx().tx, YEAR);
    const result = list.checks.find((c) => c.id === manyCheck.id)!;
    expect(result.count).toBe(CLOSE_CHECK_ITEM_LIMIT + 25);
    expect(result.items).toHaveLength(CLOSE_CHECK_ITEM_LIMIT);
    plugged.many = 0;
  });

  it('assertCloseChecklistPasses throws CLOSE_CHECKLIST_FAILED with the checklist', async () => {
    mapped();
    plugged.block = [{ key: 'j9', amount: '1.00' }];
    const err = await assertCloseChecklistPasses(tx().tx, YEAR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseChecklistFailedError);
    const failed = err as CloseChecklistFailedError;
    expect(failed.code).toBe(CLOSE_CHECKLIST_FAILED);
    expect(failed.message).toBe(
      'Tahun buku 2025 belum bisa ditutup: 1 pemeriksaan daftar cek masih memblokir. Buka daftar cek tutup buku untuk rinciannya.',
    );
    expect(failed.checklist.checks.find((c) => c.id === blockCheck.id)).toMatchObject({ status: 'fail', count: 1 });
    plugged.block = [];
  });

  it('an unmapped close account fails system-accounts', async () => {
    vi.spyOn(systemAccounts, 'getAccounts').mockImplementation(async (role) =>
      role === 'RETAINED_EARNINGS' ? [] : [{ id: 'a', accountNumber: '3.4', name: 'x' }],
    );
    const list = await runCloseChecklist(tx().tx, YEAR);
    expect(list.checks.find((c) => c.id === 'system-accounts')).toMatchObject({
      status: 'fail',
      items: [{ key: 'RETAINED_EARNINGS', kind: 'SystemAccountRole', label: 'Laba Ditahan' }],
    });
  });

  it('a close account mapped to an inactive or group account fails system-accounts', async () => {
    mapped();
    for (const closeAccount of [{ isActive: false, isGroup: false }, { isActive: true, isGroup: true }]) {
      const list = await runCloseChecklist(tx([], closeAccount).tx, YEAR);
      expect(list.checks.find((c) => c.id === 'system-accounts')).toMatchObject({
        status: 'fail',
        items: [{ key: 'CURRENT_PROFIT' }, { key: 'RETAINED_EARNINGS' }],
      });
    }
  });

  describe('baseline capture of one check', () => {
    // Rows already in close_check_baselines, per check id.
    function baselineTx(rows: Record<string, number>) {
      return makeAutoTx({
        'closeCheckBaseline.groupBy': () => Object.entries(rows).map(([checkId, n]) => ({ checkId, _count: { _all: n } })),
      });
    }

    it('captures only the named checks and leaves the ledger checks alone', async () => {
      plugged.block = [{ key: 'n1', amount: '3.00' }];
      const ledgerRuns = closeChecks()
        .filter((c) => c.id === 'ledger-balanced' || c.id === 'ale-vs-journal')
        .map((c) => vi.spyOn(c, 'run'));
      const { tx: t, fn } = baselineTx({});
      const captured = await captureCloseBaseline(t, YEAR, true, [blockCheck.id]);
      expect(captured.map((c) => [c.checkId, c.item.key, c.added])).toEqual([[blockCheck.id, 'n1', true]]);
      for (const run of ledgerRuns) expect(run).not.toHaveBeenCalled();
      expect(fn('closeCheckBaseline.createMany').mock.calls[0]![0].data).toEqual([
        { checkId: blockCheck.id, itemKey: 'n1', fiscalYearId: YEAR.id, amount: new Prisma.Decimal('3.00') },
      ]);
      plugged.block = [];
    });

    it('refuses an id that is unknown or not baseline-aware', () => {
      expect(() => baselineCaptureChecks(['inventory-vs-gl'])).toThrow(/not a baseline-aware close check/);
      expect(() => baselineCaptureChecks(['system-accounts'])).toThrow(/not a baseline-aware close check/);
      expect(baselineCaptureChecks().map((c) => c.id)).toEqual(['ledger-balanced', 'ale-vs-journal', blockCheck.id]);
    });

    it('a second full capture is refused; --allow-existing needs --check', async () => {
      await expect(assertBaselineCaptureAllowed(baselineTx({}).tx, { allowExisting: false })).resolves.toBeUndefined();
      await expect(assertBaselineCaptureAllowed(baselineTx({ 'ale-vs-journal': 4 }).tx, { allowExisting: false })).rejects.toThrow(
        /already has rows for ale-vs-journal \(4\)/,
      );
      await expect(assertBaselineCaptureAllowed(baselineTx({}).tx, { allowExisting: true })).rejects.toThrow(/only goes with --check/);
    });

    it('a later check is captured on its own once, acknowledging the other checks\' rows', async () => {
      const ledgerOnly = { 'ledger-balanced': 2, 'ale-vs-journal': 3 };
      const named = { checkIds: [blockCheck.id] };
      await expect(assertBaselineCaptureAllowed(baselineTx(ledgerOnly).tx, { ...named, allowExisting: false })).rejects.toThrow(
        /already has 5 row\(s\).*--allow-existing/,
      );
      await expect(assertBaselineCaptureAllowed(baselineTx(ledgerOnly).tx, { ...named, allowExisting: true })).resolves.toBeUndefined();
      await expect(
        assertBaselineCaptureAllowed(baselineTx({ ...ledgerOnly, [blockCheck.id]: 1 }).tx, { ...named, allowExisting: true }),
      ).rejects.toThrow(new RegExp(`already has rows for ${blockCheck.id} \\(1\\)`));
      // Naming a ledger check cannot re-open its capture either.
      await expect(
        assertBaselineCaptureAllowed(baselineTx(ledgerOnly).tx, { checkIds: ['ale-vs-journal'], allowExisting: true }),
      ).rejects.toThrow(/already has rows for ale-vs-journal/);
    });
  });
});
