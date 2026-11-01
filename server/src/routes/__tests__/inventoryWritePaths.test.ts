/**
 * Write paths that used to leave UI cells empty: manual stock movement GL
 * lines without description, and stock opname without a header warehouse.
 * Also the closed fiscal year guard on movement edit/cancel and opname cancel.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';

let current = makeAutoTx();
vi.mock('../../lib/prisma', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(current.tx)) },
}));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// Pass-through gate tagged with its capability, so tests can read which cap a route requires.
vi.mock('../../middleware/auth', () => ({
  requireCap: (cap: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { cap }),
}));
vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async (_tx, prefix: string) => `${prefix}-202610-0001`) }));
vi.mock('../../utils/accountBalance', () => ({
  updateAccountBalance: vi.fn(async () => undefined),
  recalculateAccountBalances: vi.fn(async () => undefined),
}));
vi.mock('../../services/ledger/cancelJournals', () => ({
  findDocumentJournals: vi.fn(async () => []),
  cancelJournalsInTx: vi.fn(async () => []),
}));
vi.mock('../../services/systemAccounts', () => ({
  systemAccounts: {
    getAccount: vi.fn(async (role: string) => ({ id: { INVENTORY: 'acc-inv', OPENING_EQUITY: 'acc-3.1', INVENTORY_VARIANCE: 'acc-var' }[role] })),
  },
}));
vi.mock('../../services/cogsBackfillService', () => ({ settleCogsBackfillForItem: vi.fn(async () => undefined) }));
vi.mock('../../services/cogsBackfillReverse', () => ({ reverseCogsSettlementsByTrigger: vi.fn(async () => undefined) }));
vi.mock('../../services/averageCostRecompute', () => ({ recomputeAverageCostFromReplay: vi.fn(async () => undefined) }));

import movementsRouter from '../inventory/movements';
import stockOpnameRouter from '../stockOpname';
import { settleCogsBackfillForItem } from '../../services/cogsBackfillService';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u1', role: 'Admin' };
    next();
  });
  app.use('/movements', movementsRouter);
  app.use('/stock-opname', stockOpnameRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const send = (method: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ITEM_ID = '0b8a3f0e-0000-4000-8000-0000000000a1';
const ITEM = { id: ITEM_ID, name: 'Beras', unit: 'Kg', isActive: true, accountId: null, currentStock: '50', averageCost: '9000' };
const WH = '0b8a3f0e-0000-4000-8000-000000000001';

const FY_2026 = { id: 'fy-2026', name: '2026', isClosed: false };
const FY_2027 = { id: 'fy-2027', name: '2027', isClosed: false };

/** Fiscal years by id and by date (2026 / 2027), plus their FOR SHARE row read; `closed` ids read as closed. */
const fiscalYearHandlers = (closed: string[] = []) => ({
  'fiscalYear.findFirst': ({ where }: any) => (where.endDate.gte >= new Date('2026-12-31T17:00:00Z') ? FY_2027 : FY_2026),
  'fiscalYear.findUnique': ({ where }: any) => [FY_2026, FY_2027].find((fy) => fy.id === where.id) ?? null,
  $queryRaw: (_sql: unknown, id: string) => [{ is_closed: closed.includes(id) }],
});

const journalHandlers = {
  ...fiscalYearHandlers(),
  'inventoryItem.findUnique': () => ITEM,
  'journalEntry.create': ({ data }: any) => ({ id: 'je-1', ...data, items: data.items.create }),
};

const OLD_MOVEMENT = {
  id: 'sm-1', itemId: ITEM_ID, warehouseId: WH, movementType: 'In', quantity: '10', isCancelled: false, date: new Date('2026-12-20'),
  referenceType: null, journalEntryId: null, fiscalYearId: 'fy-2026', movementNumber: 'SM-1', item: ITEM,
};

describe('manual stock movement GL descriptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST writes the narration on both journal lines and both ledger rows', async () => {
    current = makeAutoTx(journalHandlers);
    const res = await send('POST', '/movements', {
      itemId: ITEM_ID, warehouseId: WH, movementType: 'In', quantity: 10, unitCost: 1000, date: '2026-10-10', notes: 'stok awal',
    });
    expect(res.status).toBe(201);
    const narration = 'Stok Masuk: Beras 10 Kg - stok awal';
    const je = current.fn('journalEntry.create').mock.calls[0]![0].data;
    expect(je.narration).toBe(narration);
    expect(je.items.create).toEqual([
      { accountId: 'acc-inv', debit: 10000, credit: 0, description: narration },
      { accountId: 'acc-3.1', debit: 0, credit: 10000, description: narration },
    ]);
    const ledger = current.fn('accountingLedgerEntry.createMany').mock.calls[0]![0].data;
    expect(ledger.map((l: any) => [l.accountId, l.debit, l.credit, l.description])).toEqual([
      ['acc-inv', 10000, 0, narration],
      ['acc-3.1', 0, 10000, narration],
    ]);
  });

  it('PUT writes the "(Edit)" narration on the re-posted journal and ledger', async () => {
    current = makeAutoTx({
      ...journalHandlers,
      'stockMovement.findUnique': () => OLD_MOVEMENT,
    });
    const res = await send('PUT', '/movements/sm-1', { movementType: 'Out', quantity: 4, unitCost: 1000, date: '2026-10-10' });
    expect(res.status).toBe(200);
    const narration = 'Stok Keluar: Beras 4 Kg (Edit)';
    const je = current.fn('journalEntry.create').mock.calls[0]![0].data;
    expect(je.items.create).toEqual([
      { accountId: 'acc-3.1', debit: 4000, credit: 0, description: narration },
      { accountId: 'acc-inv', debit: 0, credit: 4000, description: narration },
    ]);
    const ledger = current.fn('accountingLedgerEntry.createMany').mock.calls[0]![0].data;
    expect(ledger.every((l: any) => l.description === narration)).toBe(true);
  });
});

describe('stock opname header warehouse', () => {
  beforeEach(() => vi.clearAllMocks());

  const opnameTx = (systemStock: string) =>
    makeAutoTx({
      ...fiscalYearHandlers(),
      'inventoryItem.findMany': () => [{ ...ITEM, currentStock: systemStock }],
      'inventoryStock.findMany': () => [{ itemId: ITEM_ID, currentStock: systemStock }],
      'stockOpname.create': ({ data }: any) => ({ id: 'so-1', ...data }),
    });

  it('stores the warehouse on the header and lines even when nothing differs', async () => {
    current = opnameTx('10');
    const res = await send('POST', '/stock-opname', {
      date: '2026-10-10', warehouseId: WH, items: [{ itemId: ITEM_ID, actualStock: 10 }],
    });
    expect(res.status).toBe(201);
    const data = current.fn('stockOpname.create').mock.calls[0]![0].data;
    expect(data.warehouseId).toBe(WH);
    expect(data.items.create[0]).toMatchObject({ itemId: ITEM_ID, difference: 0, warehouseId: WH });
    expect(current.fn('stockMovement.create')).not.toHaveBeenCalled();
  });

  it('falls back to the default warehouse when none is picked', async () => {
    current = makeAutoTx({
      ...fiscalYearHandlers(),
      'inventoryItem.findMany': () => [{ ...ITEM, currentStock: '10' }],
      'warehouse.findFirst': () => ({ id: 'wh-default' }),
      'stockOpname.create': ({ data }: any) => ({ id: 'so-1', ...data }),
    });
    const res = await send('POST', '/stock-opname', { date: '2026-10-10', items: [{ itemId: ITEM_ID, actualStock: 12 }] });
    expect(res.status).toBe(201);
    expect(current.fn('stockOpname.create').mock.calls[0]![0].data.warehouseId).toBe('wh-default');
    expect(current.fn('stockMovement.create').mock.calls[0]![0].data.warehouseId).toBe('wh-default');
  });
});

describe('closed fiscal year on movement edit/cancel and opname cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  const movementTx = (closed: string[], movement: object = OLD_MOVEMENT) =>
    makeAutoTx({ ...journalHandlers, ...fiscalYearHandlers(closed), 'stockMovement.findUnique': () => movement });

  it('PUT requires doc.cancel, like cancel', () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { cap?: string } }> } };
    const capOf = (path: string) =>
      (movementsRouter.stack as Layer[]).find((l) => l.route?.path === path && l.route.methods.put)?.route?.stack[0]?.handle.cap;
    expect(capOf('/:id')).toBe('doc.cancel');
    expect(capOf('/:id/cancel')).toBe('doc.cancel');
  });

  it('PUT moving a movement into the next year books the movement, journal and auto-settle in that year', async () => {
    current = movementTx([]);
    const res = await send('PUT', '/movements/sm-1', { movementType: 'In', quantity: 10, unitCost: 1000, date: '2027-01-05' });
    expect(res.status).toBe(200);
    expect(current.fn('stockMovement.update').mock.calls[0]![0].data).toMatchObject({ fiscalYearId: 'fy-2027', date: new Date('2027-01-05') });
    expect(current.fn('journalEntry.create').mock.calls[0]![0].data.fiscalYearId).toBe('fy-2027');
    expect(vi.mocked(settleCogsBackfillForItem).mock.calls[0]![1]).toMatchObject({ fiscalYearId: 'fy-2027', settleDate: new Date('2027-01-05') });
  });

  it('PUT out of a closed year is rejected with PERIOD_CLOSED before any stock is reversed', async () => {
    current = movementTx(['fy-2026']);
    const res = await send('PUT', '/movements/sm-1', { movementType: 'In', quantity: 10, unitCost: 1000, date: '2027-01-05' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PERIOD_CLOSED');
    expect(current.fn('inventoryItem.update')).not.toHaveBeenCalled();
  });

  it('PUT into a closed year is rejected even when no journal would be posted (unit cost 0)', async () => {
    current = movementTx(['fy-2026'], { ...OLD_MOVEMENT, date: new Date('2027-01-10'), fiscalYearId: 'fy-2027' });
    const res = await send('PUT', '/movements/sm-1', { movementType: 'In', quantity: 10, unitCost: 0, date: '2026-12-20' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PERIOD_CLOSED');
    expect(current.fn('inventoryItem.update')).not.toHaveBeenCalled();
  });

  it('PUT is rejected when the old journal sits in a closed year', async () => {
    current = makeAutoTx({
      ...journalHandlers,
      ...fiscalYearHandlers(['fy-old']),
      'fiscalYear.findUnique': ({ where }: any) => [FY_2026, FY_2027, { id: 'fy-old', name: '2025', isClosed: true }].find((fy) => fy.id === where.id) ?? null,
      'stockMovement.findUnique': () => ({ ...OLD_MOVEMENT, journalEntryId: 'je-old' }),
      'journalEntry.findUnique': () => ({ id: 'je-old', fiscalYearId: 'fy-old', items: [] }),
    });
    const res = await send('PUT', '/movements/sm-1', { movementType: 'In', quantity: 10, unitCost: 1000, date: '2026-12-20' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PERIOD_CLOSED');
    expect(current.fn('journalEntry.update')).not.toHaveBeenCalled();
  });

  it('cancel in a closed year is rejected with PERIOD_CLOSED', async () => {
    current = movementTx(['fy-2026']);
    const res = await send('PUT', '/movements/sm-1/cancel', {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PERIOD_CLOSED');
    expect(current.fn('inventoryItem.update')).not.toHaveBeenCalled();
    expect(current.fn('stockMovement.update')).not.toHaveBeenCalled();
  });

  it('opname cancel in a closed year is rejected with PERIOD_CLOSED', async () => {
    current = makeAutoTx({
      ...fiscalYearHandlers(['fy-2026']),
      'stockOpname.findUnique': () => ({ id: 'so-1', opnameNumber: 'SO-1', status: 'Submitted', date: new Date('2026-12-20'), fiscalYearId: 'fy-2026', items: [] }),
    });
    const res = await send('PUT', '/stock-opname/so-1/cancel', {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PERIOD_CLOSED');
    expect(current.fn('stockOpname.update')).not.toHaveBeenCalled();
  });
});

describe('document movement lock and references (E3-R2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST ignores referenceType/referenceId from the body and keeps the referenceNumber', async () => {
    current = makeAutoTx(journalHandlers);
    const res = await send('POST', '/movements', {
      itemId: ITEM_ID, warehouseId: WH, movementType: 'In', quantity: 10, unitCost: 0, date: '2026-10-10',
      referenceType: 'SalesReturn', referenceId: 'sr-fake', referenceNumber: 'NOTA-7',
    });
    expect(res.status).toBe(201);
    expect(current.fn('stockMovement.create').mock.calls[0]![0].data).toMatchObject({
      referenceType: null, referenceId: null, referenceNumber: 'NOTA-7',
    });
  });

  it('POST rejects a source batch of another item before writing stock', async () => {
    current = makeAutoTx({
      ...journalHandlers,
      'inventoryStock.findUnique': () => ({ currentStock: '50' }),
      'stockMovement.findUnique': () => ({ id: 'b-1', itemId: 'other-item', isCancelled: false, movementType: 'In', unitCost: '1' }),
    });
    const res = await send('POST', '/movements', {
      itemId: ITEM_ID, warehouseId: WH, movementType: 'Out', quantity: 5, date: '2026-10-10',
      sourceMovementId: '0b8a3f0e-0000-4000-8000-0000000000b1',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MOVEMENT_SOURCE_BATCH_INVALID');
    expect(current.fn('inventoryStock.upsert')).not.toHaveBeenCalled();
    expect(current.fn('stockMovement.create')).not.toHaveBeenCalled();
  });

  it('PUT never writes referenceType and clears the batch when the row becomes inbound', async () => {
    current = makeAutoTx({ ...journalHandlers, 'stockMovement.findUnique': () => ({ ...OLD_MOVEMENT, movementType: 'Out' }) });
    const res = await send('PUT', '/movements/sm-1', {
      movementType: 'In', quantity: 4, unitCost: 0, date: '2026-10-10', referenceType: 'GoodsReceipt',
    });
    expect(res.status).toBe(200);
    const data = current.fn('stockMovement.update').mock.calls[0]![0].data;
    expect(data).not.toHaveProperty('referenceType');
    expect(data.sourceMovementId).toBeNull();
  });

  it.each(['TransferOut', 'TransferIn'])('cancel and edit of a %s row are refused before any stock moves', async (movementType) => {
    current = makeAutoTx({
      ...journalHandlers,
      'stockMovement.findUnique': () => ({ ...OLD_MOVEMENT, movementType, referenceType: 'StockTransfer', referenceId: 'st-1' }),
    });
    const cancel = await send('PUT', '/movements/sm-1/cancel', {});
    expect(cancel.status).toBe(400);
    expect((await cancel.json()).code).toBe('MOVEMENT_DOCUMENT_LOCKED');
    const edit = await send('PUT', '/movements/sm-1', { movementType: 'In', quantity: 1, date: '2026-10-10' });
    expect(edit.status).toBe(400);
    expect((await edit.json()).code).toBe('MOVEMENT_DOCUMENT_LOCKED');
    expect(current.fn('inventoryItem.update')).not.toHaveBeenCalled();
    expect(current.fn('stockMovement.update')).not.toHaveBeenCalled();
  });

  it('opname cancel skips a line whose movement was already cancelled', async () => {
    current = makeAutoTx({
      ...fiscalYearHandlers(),
      'stockOpname.findUnique': () => ({
        id: 'so-1', opnameNumber: 'SO-1', status: 'Submitted', date: new Date('2026-10-10'), fiscalYearId: 'fy-2026',
        items: [
          { itemId: ITEM_ID, difference: '2', movementId: 'm-live', item: ITEM },
          { itemId: ITEM_ID, difference: '-3', movementId: 'm-dead', item: ITEM },
        ],
      }),
      'stockMovement.findUnique': ({ where }: any) =>
        where.id === 'm-dead'
          ? { warehouseId: WH, isCancelled: true, movementType: 'AdjustmentOut', quantity: '3' }
          : { warehouseId: WH, isCancelled: false, movementType: 'AdjustmentIn', quantity: '2' },
    });
    const res = await send('PUT', '/stock-opname/so-1/cancel', {});
    expect(res.status).toBe(200);
    expect(current.fn('inventoryItem.update').mock.calls.map((c) => c[0].data.currentStock.increment)).toEqual([-2]);
    expect(current.fn('stockMovement.update').mock.calls.map((c) => c[0].where.id)).toEqual(['m-live']);
  });
});
