// GET /parties/dashboard per side (E5-R3 acceptance, PR-5.10): a Both party with a 30 jt payable and
// a 20 jt receivable adds 30 jt to totalHutang and 20 jt to totalPiutang, and appears in each top
// list with that side's amount only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Prisma } from '@prisma/client';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    party: { findMany: vi.fn() },
    salesInvoice: { findMany: vi.fn() },
    purchaseInvoice: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
  },
}));
vi.mock('../../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../middleware/auth', () => ({
  requireCap: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import partiesRouter from '../parties';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/parties', partiesRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const d = (v: string) => new Prisma.Decimal(v);
const party = (id: string, partyType: string, receivable: string, payable: string) => ({
  id, name: `Mitra ${id}`, partyType, isActive: true,
  outstandingAmount: d(receivable).plus(d(payable)),
  receivableOutstanding: d(receivable),
  payableOutstanding: d(payable),
  depositBalance: d('0'),
  customerDepositBalance: d('0'),
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.salesInvoice.findMany.mockResolvedValue([]);
  prismaMock.purchaseInvoice.findMany.mockResolvedValue([]);
  prismaMock.payment.findMany.mockResolvedValue([]);
});

describe('GET /parties/dashboard', () => {
  it('splits a Both party per side: totalHutang 30 jt, totalPiutang 20 jt', async () => {
    prismaMock.party.findMany.mockResolvedValue([party('b', 'Both', '20000000', '30000000')]);
    const res = await fetch(`${base}/parties/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ totalCustomers: 1, totalSuppliers: 1, totalPiutang: 20_000_000, totalHutang: 30_000_000 });
    expect(body.topCustomers).toEqual([{ id: 'b', name: 'Mitra b', outstanding: 20_000_000 }]);
    expect(body.topVendors).toEqual([{ id: 'b', name: 'Mitra b', outstanding: 30_000_000 }]);
  });

  it('ranks each top list by its own side and reads the side columns', async () => {
    prismaMock.party.findMany.mockResolvedValue([
      party('c', 'Customer', '5000000', '0'),
      party('s', 'Supplier', '0', '7000000'),
      party('b', 'Both', '9000000', '1000000'),
      party('z', 'Customer', '0', '0'),
    ]);
    const body = await (await fetch(`${base}/parties/dashboard`)).json();
    expect(body.summary).toMatchObject({ totalPiutang: 14_000_000, totalHutang: 8_000_000 });
    expect(body.topCustomers.map((t: { id: string }) => t.id)).toEqual(['b', 'c']);
    expect(body.topVendors.map((t: { id: string; outstanding: number }) => [t.id, t.outstanding])).toEqual([['s', 7_000_000], ['b', 1_000_000]]);
    const select = prismaMock.party.findMany.mock.calls[0]?.[0]?.select;
    expect(select).toMatchObject({ receivableOutstanding: true, payableOutstanding: true });
  });
});
