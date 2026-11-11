// Inventory import never writes the unit of an existing item (E3-R5): a row whose unit differs from
// the stored one is a row error (preview and import alike), a row with the same unit goes in, and the
// upsert update leaves `unit` out.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const db = vi.hoisted(() => ({
  inventoryItem: { findMany: vi.fn(), upsert: vi.fn() },
  rows: [] as Record<string, string>[],
}));
vi.mock('../../lib/prisma', () => ({ prisma: db }));
vi.mock('../import/shared', () => ({
  upload: { single: () => (req: any, _res: any, next: any) => { req.file = { buffer: Buffer.from(''), originalname: 'x.csv' }; next(); } },
  parseFile: vi.fn(async () => db.rows),
  sanitizeCellValue: (v: unknown) => String(v ?? ''),
}));
vi.mock('../../services/openingStockImport', () => ({ postOpeningStockInTx: vi.fn() }));

import inventoryImportRouter from '../import/inventory';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: 'u-1' }; next(); });
  app.use('/api/import', inventoryImportRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = async (url: string) => {
  const r = await fetch(base + url, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as any };
};

beforeEach(() => {
  db.inventoryItem.findMany.mockReset();
  db.inventoryItem.upsert.mockReset();
  db.inventoryItem.findMany.mockResolvedValue([{ code: 'BKT', unit: 'Kg' }]);
  db.inventoryItem.upsert.mockImplementation(async ({ create }: any) => ({ id: 'i-1', ...create }));
  db.rows = [
    { code: 'BKT', name: 'Bekatul', unit: 'Ton' },
    { code: 'MNR', name: 'Menir', unit: 'Kg' },
    { code: 'BKT', name: 'Bekatul halus', unit: 'Kg' },
  ];
});

describe('POST /import/inventory unit lock', () => {
  it('reports a differing unit on the spreadsheet row in the preview, keeping the other rows', async () => {
    const r = await post('/api/import/inventory?preview=true');
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([expect.objectContaining({ row: 2, message: expect.stringContaining('"Ton"') })]);
    expect(r.body.data.map((x: any) => x.code)).toEqual(['MNR', 'BKT']);
  });

  it('imports the rows that pass and never writes the unit on an existing item', async () => {
    const r = await post('/api/import/inventory');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(2);
    expect(r.body.failed).toBe(1);
    expect(r.body.errors).toHaveLength(1);
    for (const [arg] of db.inventoryItem.upsert.mock.calls) {
      expect(Object.keys(arg.update)).not.toContain('unit');
    }
    expect(db.inventoryItem.upsert).toHaveBeenCalledTimes(2);
  });
});
