// Journal import (E7-R9): every row is checked and nothing posts unless every journal is good;
// a re-upload skips journals already imported by content.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { BusinessError } from '../../utils/errors';
import { Prisma } from '@prisma/client';
import { businessDayOf } from '../../utils/businessDate';

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, string>[],
    numeric: [] as Array<Record<string, boolean>>,
    canControl: false,
    parseError: null as Error | null,
    periodBusyDay: null as string | null,
    calls: [] as string[],
    closedDays: new Set<string>(),
    journals: [] as Array<{ id: string; sourceKey: string | null; status: string; date: Date; items: any[] }>,
    posts: [] as Array<{ input: any; opts: any }>,
    parties: [
      { id: 'p-1', name: 'PT Maju', partyType: 'Customer' },
      { id: 'p-2', name: 'PT Kembar', partyType: 'Customer' },
      { id: 'p-3', name: 'pt kembar', partyType: 'Customer' },
      { id: 'p-4', name: 'CV Pemasok', partyType: 'Supplier' },
    ] as Array<{ id: string; name: string; partyType: string }>,
  };
  const accounts = [
    { id: 'a-kas', accountNumber: '1.1.1', name: 'Kas', rootType: 'ASSET', isGroup: false, isActive: true },
    { id: 'a-jual', accountNumber: '4.1', name: 'Penjualan', rootType: 'REVENUE', isGroup: false, isActive: true },
    { id: 'a-beban', accountNumber: '6.1', name: 'Beban', rootType: 'EXPENSE', isGroup: false, isActive: true },
    { id: 'a-grup', accountNumber: '1.1', name: 'Kas dan Bank', rootType: 'ASSET', isGroup: true, isActive: true },
    { id: 'a-ar', accountNumber: '1.2.1', name: 'Piutang Usaha', rootType: 'ASSET', isGroup: false, isActive: true },
  ];
  let seq = 0;
  const tx: any = {
    $executeRaw: vi.fn(async () => { state.calls.push('lock'); return 1; }),
    account: { findMany: vi.fn(async ({ where }: any) => accounts.filter((a) => where.accountNumber.in.includes(a.accountNumber))) },
    journalEntry: {
      findMany: vi.fn(async ({ where }: any) => {
        state.calls.push('lookup');
        return state.journals.filter((j) => where.sourceKey.in.includes(j.sourceKey) && j.status !== 'Cancelled').map((j) => ({ sourceKey: j.sourceKey }));
      }),
    },
    party: { findMany: vi.fn(async () => state.parties) },
  };
  // The shared posting path is covered by its own tests; here it records what the import hands it.
  const createJournal = vi.fn(async (_tx: any, input: any, opts: any) => {
    state.posts.push({ input, opts });
    const items = input.items.map((c: any, i: number) => ({
      id: `ji-${seq}-${i}`, ...c, debit: new Prisma.Decimal(c.debit ?? 0), credit: new Prisma.Decimal(c.credit ?? 0),
    }));
    const row = { id: `je-${++seq}`, sourceKey: opts.sourceKey, status: 'Submitted', date: new Date(input.date), items };
    state.journals.push(row);
    return { journal: { ...row, entryNumber: `JV-${seq}` }, fiscalYear: { id: 'fy-1' } };
  });
  return {
    state,
    accounts,
    tx,
    createJournal,
    $transaction: vi.fn(async (fn: any) => {
      // Real rollback: undo journals created by a transaction that throws.
      const before = state.journals.length;
      try { return await fn(tx); } catch (e) { state.journals.length = before; throw e; }
    }),
    reset() { seq = 0; state.journals.length = 0; state.posts.length = 0; },
  };
});

vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../../middleware/auth', () => ({ requirePerm: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../import/shared', () => ({
  upload: { single: () => (req: any, _res: any, next: any) => { req.file = { buffer: Buffer.from(''), originalname: 'x.csv' }; next(); } },
  parseFileDetailed: vi.fn(async () => {
    if (db.state.parseError) throw db.state.parseError;
    return { rows: db.state.rows, numericCells: db.state.numeric };
  }),
  sanitizeCellValue: (v: unknown) => String(v ?? ''),
}));
vi.mock('../../services/permissionService', () => ({ hasCap: vi.fn(async () => db.state.canControl) }));
vi.mock('../../services/manualJournal', () => ({ createManualJournalInTx: db.createJournal }));
vi.mock('../../services/ledger/partyRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/ledger/partyRules')>()),
  // a-ar is the receivables account: the only one with a party role
  loadPartyRoleMap: vi.fn(async () => new Map([['a-ar', 'AR']])),
}));
vi.mock('../../utils/periodGuard', () => ({
  PERIOD_BUSY: 'PERIOD_BUSY',
  assertPeriodOpen: vi.fn(async (_tx: any, ref: { date: Date }) => {
    if (db.state.periodBusyDay === businessDayOf(ref.date)) throw new BusinessError('Periode sibuk.', 'PERIOD_BUSY');
    if (db.state.closedDays.has(businessDayOf(ref.date))) throw new BusinessError('Tahun buku 2026 sudah ditutup.', 'PERIOD_CLOSED');
    return { id: 'fy-1' };
  }),
}));
vi.mock('../../services/ledger/accountGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/ledger/accountGuard')>()),
  // a-ar is the receivables control account
  loadControlAccountMap: vi.fn(async () => new Map([['a-ar', ['AR']]])),
}));

import journalsRouter from '../import/journals';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use((req: any, _res, next) => { req.user = { userId: 'u-1', role: 'Accountant' }; next(); });
  app.use('/api/import', journalsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = async (query = '') => {
  const r = await fetch(`${base}/api/import/journals${query}`, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as any };
};

type Row = Record<string, string>;
const row = (date: string, narration: string, accountNumber: string, debit: string, credit: string, extra: Row = {}): Row =>
  ({ date, narration, accountNumber, debit, credit, description: '', ref: '', ...extra });
const sale = (narration: string, amount = '5000000', date = '2026-03-05'): Row[] => [
  row(date, narration, '1.1.1', amount, '0'),
  row(date, narration, '4.1', '0', amount),
];
const setFile = (rows: Row[], numeric: Array<Record<string, boolean>> = []) => {
  db.state.rows = rows;
  db.state.numeric = rows.map((_, i) => numeric[i] ?? {});
};

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  db.state.canControl = false;
  db.state.closedDays.clear();
  db.state.parseError = null;
  db.state.periodBusyDay = null;
  db.state.calls = [];
});

describe('POST /api/import/journals line checks', () => {
  it('a row with both debit and credit is an error on that sheet row and posts nothing', async () => {
    setFile([row('2026-03-05', 'Salah', '1.1.1', '5000000', '5000000'), row('2026-03-05', 'Salah', '4.1', '0', '5000000')]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(0);
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, message: expect.stringContaining('debit dan kredit sekaligus') })]);
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('a negative debit is an error', async () => {
    setFile([row('2026-03-05', 'Minus', '1.1.1', '-5000000', '0'), row('2026-03-05', 'Minus', '4.1', '0', '5000000')]);
    const res = await post();
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, message: expect.stringContaining('negatif') })]);
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('a thousands-separated text amount is refused instead of read as 5', async () => {
    setFile([row('2026-03-05', 'Titik', '1.1.1', '5.000.000', '0'), row('2026-03-05', 'Titik', '4.1', '0', '5000000')]);
    const res = await post();
    expect(res.body.errors.map((e: any) => e.row)).toEqual([2]);
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('reads 05/03/2026 as 5 March', async () => {
    setFile(sale('Hari lima', '5000000', '05/03/2026'));
    const preview = await post('?preview=true');
    expect(preview.body.data[0].date).toBe('2026-03-05');
    const res = await post();
    expect(res.body.success).toBe(1);
    expect(businessDayOf(db.state.journals[0].date)).toBe('2026-03-05');
  });

  it('refuses an ambiguous date layout', async () => {
    setFile(sale('Aneh', '5000000', '05-03-2026'));
    const res = await post();
    expect(res.body.errors.length).toBe(2);
    expect(res.body.errors[0].message).toContain('dua cara');
  });

  it('accepts a formula cell holding 110000.00000000001 as 110.000,00', async () => {
    setFile(
      [row('2026-03-05', 'Rumus', '1.1.1', '110000.00000000001', '0'), row('2026-03-05', 'Rumus', '4.1', '0', '110000')],
      [{ debit: true }, {}],
    );
    const res = await post();
    expect(res.body).toMatchObject({ success: 1, failed: 0, errors: [] });
    expect(db.state.journals[0].items.map((i: any) => i.debit.toFixed(2))).toEqual(['110000.00', '0.00']);
  });

  it('refuses a text cell holding the same float', async () => {
    setFile([row('2026-03-05', 'Teks', '1.1.1', '110000.00000000001', '0'), row('2026-03-05', 'Teks', '4.1', '0', '110000')]);
    expect((await post()).body.success).toBe(0);
  });

  it('groups rows by ref and requires one date and narration per ref', async () => {
    setFile([
      row('2026-03-05', 'Satu', '1.1.1', '100', '0', { ref: 'A' }),
      row('2026-03-05', 'Satu', '4.1', '0', '100', { ref: 'A' }),
      row('2026-03-06', 'Dua', '1.1.1', '50', '0', { ref: 'B' }),
      row('2026-03-07', 'Dua lain', '4.1', '0', '50', { ref: 'B' }),
    ]);
    const res = await post();
    expect(res.body.success).toBe(0);
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 5, message: expect.stringContaining('ref "B"') })]);
  });

  it('posts a ref group whose rows are not adjacent', async () => {
    setFile([
      row('2026-03-05', 'Satu', '1.1.1', '100', '0', { ref: 'A' }),
      row('2026-03-06', 'Dua', '1.1.1', '50', '0', { ref: 'B' }),
      row('2026-03-05', 'Satu', '4.1', '0', '100', { ref: 'A' }),
      row('2026-03-06', 'Dua', '4.1', '0', '50', { ref: 'B' }),
    ]);
    expect((await post()).body).toMatchObject({ success: 2, failed: 0 });
  });
});

describe('POST /api/import/journals all-or-nothing', () => {
  it('one unbalanced journal stops the others too and reports every row of it', async () => {
    setFile([
      ...sale('Baik'),
      row('2026-03-06', 'Timpang', '1.1.1', '100', '0'),
      row('2026-03-06', 'Timpang', '4.1', '0', '90'),
    ]);
    const res = await post();
    expect(res.body).toMatchObject({ success: 0, failed: 1 });
    expect(res.body.errors.map((e: any) => e.row)).toEqual([4, 5]);
    expect(res.body.errors[0].message).toContain('tidak seimbang');
    expect(db.state.journals).toHaveLength(0);
  });

  it('reports bad rows of several journals in one answer', async () => {
    setFile([
      row('2026-03-05', 'X', '9.9.9', '10', '0'),
      row('2026-03-05', 'X', '4.1', '0', '10'),
      row('2026-03-06', 'Y', '1.1', '10', '0'),
      row('2026-03-06', 'Y', '4.1', '0', '10'),
    ]);
    const res = await post();
    expect(res.body.errors).toEqual([
      expect.objectContaining({ row: 2, message: expect.stringContaining('tidak ditemukan') }),
      expect.objectContaining({ row: 4, message: expect.stringContaining('akun grup') }),
    ]);
    expect(db.state.journals).toHaveLength(0);
  });

  it('a control account needs journal.control, and deposit-style refusals stay with the guard', async () => {
    setFile([row('2026-03-05', 'Piutang', '1.2.1', '10', '0', { partyCode: 'PT Maju' }), row('2026-03-05', 'Piutang', '4.1', '0', '10')]);
    const denied = await post();
    expect(denied.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'ACCOUNT_CONTROL', message: expect.stringContaining('journal.control') })]);

    db.state.canControl = true;
    expect((await post()).body.success).toBe(1);
  });

  it('a closed period refuses the journals dated in it and posts nothing', async () => {
    db.state.closedDays.add('2026-03-06');
    setFile([...sale('Maret 5'), ...sale('Maret 6', '100', '2026-03-06')]);
    const res = await post();
    expect(res.body.success).toBe(0);
    expect(res.body.errors.map((e: any) => e.row)).toEqual([4, 5]);
    expect(res.body.errors[0].message).toContain('ditutup');
    expect(db.state.journals).toHaveLength(0);
  });

  it('rolls back journals already written when a later write fails', async () => {
    setFile([...sale('Satu'), ...sale('Dua', '100', '2026-03-06')]);
    db.createJournal.mockImplementationOnce(db.createJournal.getMockImplementation()!)
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    const res = await post();
    expect(res.status).toBe(500);
    expect(db.state.journals).toHaveLength(0);
  });

  it('refuses a file with more than 500 journals', async () => {
    setFile(Array.from({ length: 501 }, (_, i) => sale(`J${i}`)).flat());
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('500');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/import/journals idempotent re-upload', () => {
  it('posts each journal once; the same file again skips them all', async () => {
    setFile([...sale('Satu'), ...sale('Dua', '700000', '2026-03-06')]);
    const first = await post();
    expect(first.body).toMatchObject({ success: 2, failed: 0, totalJournals: 2 });
    expect(first.body.journals).toHaveLength(2);
    expect(db.state.journals.every((j) => j.sourceKey?.startsWith('IMPORT:'))).toBe(true);

    const again = await post();
    expect(again.body).toMatchObject({ success: 0, failed: 0, totalJournals: 2 });
    expect(again.body.alreadyImported).toHaveLength(2);
    expect(db.state.journals).toHaveLength(2);
  });

  it('a corrected file posts only the journals that changed, with no duplicates', async () => {
    setFile([...sale('Satu'), ...sale('Dua', '700000', '2026-03-06'), ...sale('Tiga', '100', '2026-03-07')]);
    await post();
    expect(db.state.journals).toHaveLength(3);

    // "Dua" corrected to another amount, a new journal inserted at the top, "Satu" and "Tiga" untouched.
    setFile([...sale('Baru', '42', '2026-03-04'), ...sale('Satu'), ...sale('Dua', '750000', '2026-03-06'), ...sale('Tiga', '100', '2026-03-07')]);
    const res = await post();
    expect(res.body).toMatchObject({ success: 2, totalJournals: 4 });
    expect(res.body.alreadyImported.map((s: any) => s.narration).sort()).toEqual(['Satu', 'Tiga']);
    expect(db.state.journals).toHaveLength(5);
  });

  it('reordered lines inside a journal are the same journal', async () => {
    setFile(sale('Satu'));
    await post();
    setFile([...sale('Satu')].reverse());
    const res = await post();
    expect(res.body.success).toBe(0);
    expect(res.body.alreadyImported).toHaveLength(1);
  });

  it('a cancelled import can be imported again', async () => {
    setFile(sale('Satu'));
    await post();
    db.state.journals[0].status = 'Cancelled';
    const res = await post();
    expect(res.body.success).toBe(1);
  });

  it('two identical journals in one file both post, and a re-upload skips both', async () => {
    setFile([
      row('2026-03-05', 'Kembar', '1.1.1', '10', '0', { ref: 'K1' }), row('2026-03-05', 'Kembar', '4.1', '0', '10', { ref: 'K1' }),
      row('2026-03-05', 'Kembar', '1.1.1', '10', '0', { ref: 'K2' }), row('2026-03-05', 'Kembar', '4.1', '0', '10', { ref: 'K2' }),
    ]);
    expect((await post()).body.success).toBe(2);
    const again = await post();
    expect(again.body.success).toBe(0);
    expect(again.body.alreadyImported).toHaveLength(2);
  });
});

describe('POST /api/import/journals review fixes', () => {
  it('takes the import lock before looking up existing keys', async () => {
    setFile(sale('Satu'));
    await post();
    expect(db.state.calls.slice(0, 2)).toEqual(['lock', 'lookup']);
  });

  it('an unreadable file answers 400 with the reader message', async () => {
    db.state.parseError = new Error('Invalid Record Length');
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid Record Length');
  });

  it('PERIOD_BUSY stops the import with its own code instead of becoming a row error', async () => {
    setFile([...sale('A', '10', '2026-03-05'), ...sale('B', '10', '2026-03-06')]);
    db.state.periodBusyDay = '2026-03-05';
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PERIOD_BUSY');
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('a numeric accountNumber cell is refused instead of read as another account', async () => {
    setFile(sale('Angka'), [{ accountNumber: true }]);
    const res = await post();
    expect(res.body.success).toBe(0);
    expect(res.body.errors[0]).toMatchObject({ row: 2, message: expect.stringContaining('berformat teks') });
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('a large formula amount with float noise is accepted', async () => {
    setFile(sale('Besar', '10000000000.300001'), [{ debit: true }, { credit: true }]);
    const res = await post('?preview=true');
    expect(res.body.errors).toEqual([]);
    expect(res.body.journalCount).toBe(1);
  });

  it('a bad date on a ref row does not make the good rows of its journal unbalanced', async () => {
    setFile([
      row('2026-03-05', 'Ref', '1.1.1', '5000000', '0', { ref: '7' }),
      row('31/02/2026', 'Ref', '4.1', '0', '5000000', { ref: '7' }),
    ]);
    const res = await post();
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(3);
  });
});

describe('POST /api/import/journals party column', () => {
  const receivable = (partyCode: string | undefined, narration = 'Piutang'): Row[] => [
    row('2026-03-05', narration, '1.2.1', '10000000', '0', partyCode === undefined ? {} : { partyCode }),
    row('2026-03-05', narration, '4.1', '0', '10000000'),
  ];

  beforeEach(() => { db.state.canControl = true; });

  it('posts through createManualJournalInTx as IMPORT with the party resolved from its name, ignoring case', async () => {
    setFile(receivable('pt maju'));
    const res = await post();
    expect(res.body).toMatchObject({ success: 1, failed: 0, errors: [] });
    expect(db.state.posts).toHaveLength(1);
    const { input, opts } = db.state.posts[0];
    expect(opts).toMatchObject({ sourceType: 'IMPORT', canControl: true, userId: 'u-1' });
    expect(opts.sourceKey).toMatch(/^IMPORT:/);
    expect(input.items.map((i: any) => [i.accountId, i.debit, i.credit, i.partyId])).toEqual([
      ['a-ar', '10000000.00', '0.00', 'p-1'],
      ['a-jual', '0.00', '10000000.00', null],
    ]);
  });

  it('takes a party id as well, and the id and the name make the same journal', async () => {
    setFile(receivable('p-1'));
    expect((await post()).body.success).toBe(1);
    setFile(receivable('PT Maju'));
    const again = await post();
    expect(again.body).toMatchObject({ success: 0, failed: 0 });
    expect(again.body.alreadyImported).toHaveLength(1);
  });

  it('a name shared by two parties is an error on its row, naming the id alternative', async () => {
    setFile(receivable('PT Kembar'));
    const res = await post();
    expect(res.body.success).toBe(0);
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_AMBIGUOUS_NAME', message: expect.stringContaining('ID pihak') })]);
    expect(db.createJournal).not.toHaveBeenCalled();
    setFile(receivable('p-2'));
    expect((await post()).body.success).toBe(1);
  });

  it('an unknown party is an error on its row', async () => {
    setFile(receivable('PT Hantu'));
    const res = await post();
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_NOT_FOUND' })]);
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('a receivable line without a party is PARTY_REQUIRED on its row', async () => {
    setFile(receivable(undefined));
    const res = await post();
    expect(res.body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_REQUIRED' })]);
  });

  it('a supplier on the receivable account and a party on a plain account are refused', async () => {
    setFile(receivable('CV Pemasok'));
    expect((await post()).body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_TYPE_MISMATCH' })]);
    setFile([row('2026-03-05', 'Kas', '1.1.1', '10', '0', { partyCode: 'PT Maju' }), row('2026-03-05', 'Kas', '4.1', '0', '10')]);
    expect((await post()).body.errors).toEqual([expect.objectContaining({ row: 2, code: 'PARTY_NOT_ALLOWED' })]);
    expect(db.createJournal).not.toHaveBeenCalled();
  });

  it('one bad party stops the other journals too (all-or-nothing)', async () => {
    setFile([...sale('Baik'), ...receivable('PT Hantu', 'Buruk')]);
    const res = await post();
    expect(res.body).toMatchObject({ success: 0, failed: 2 });
    expect(db.state.journals).toHaveLength(0);
  });

  it('the preview shows the party code and posts nothing', async () => {
    setFile(receivable('PT Maju'));
    const res = await post('?preview=true');
    expect(res.body.errors).toEqual([]);
    expect(res.body.data[0].items[0]).toMatchObject({ accountNumber: '1.2.1', partyCode: 'PT Maju' });
    expect(db.createJournal).not.toHaveBeenCalled();
  });
});
