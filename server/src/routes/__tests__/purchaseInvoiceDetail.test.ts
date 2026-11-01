import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    purchaseInvoice: { findUnique: vi.fn(), update: vi.fn() },
    paymentAllocation: { findMany: vi.fn() },
    user: { findUnique: vi.fn(async () => ({ fullName: 'Staf Gudang' })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}));
vi.mock('../../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../middleware/auth', () => ({
  requireCap: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/approvalGate', () => ({ needsApproval: vi.fn(async () => false), queueApproval: vi.fn(), approvalsLink: vi.fn() }));
vi.mock('../../services/notificationService', () => ({ notifyAdmins: vi.fn() }));
vi.mock('../../services/threeWayMatchLoad', () => ({ matchPurchaseInvoiceLines: vi.fn(async () => null) }));

import purchaseRouter from '../purchase';
import { needsApproval, queueApproval } from '../../services/approvalGate';
import { PAYMENT_ALLOCATION_PAYMENT_SELECT } from '../../services/paymentAllocationDetail';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u1', role: 'Admin' };
    next();
  });
  app.use('/purchase/invoices', purchaseRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/purchase/invoices`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /purchase/invoices/:id', () => {
  it('selects the same payment allocation fields as the sales invoice detail', async () => {
    prismaMock.purchaseInvoice.findUnique.mockResolvedValue({ id: 'pi-1', items: [], terms: 'Net 30' });
    prismaMock.paymentAllocation.findMany.mockResolvedValue([
      { id: 'a1', payment: { id: 'pay-1', account: { accountNumber: '1.1.2', name: 'Bank BRI' }, splits: [] } },
    ]);
    const res = await fetch(`${base}/pi-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.terms).toBe('Net 30');
    expect(body.paymentAllocations[0].payment.account.accountNumber).toBe('1.1.2');
    expect(prismaMock.paymentAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceType: 'PurchaseInvoice', invoiceId: 'pi-1' },
        include: { payment: { select: PAYMENT_ALLOCATION_PAYMENT_SELECT } },
      }),
    );
  });
});

describe('PUT /purchase/invoices/:id', () => {
  const put = (body: unknown) =>
    fetch(`${base}/pi-1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    prismaMock.purchaseInvoice.findUnique.mockResolvedValue({ id: 'pi-1', status: 'Submitted' });
    prismaMock.purchaseInvoice.update.mockImplementation(async ({ data }: { data: object }) => ({ id: 'pi-1', ...data }));
  });

  it('saves Termin (terms) instead of dropping it', async () => {
    const res = await put({ notes: 'n', terms: '  Net 30 ' });
    expect(res.status).toBe(200);
    expect(prismaMock.purchaseInvoice.update).toHaveBeenCalledWith({ where: { id: 'pi-1' }, data: { notes: 'n', terms: 'Net 30' } });
  });

  it('clears terms with an empty string and leaves them untouched when omitted', async () => {
    await put({ terms: '' });
    expect(prismaMock.purchaseInvoice.update.mock.calls[0][0].data).toEqual({ terms: null });
    await put({ notes: 'x' });
    expect(prismaMock.purchaseInvoice.update.mock.calls[1][0].data).not.toHaveProperty('terms');
  });
});

describe('CreatePurchaseInvoiceSchema', () => {
  it('keeps terms so create and approval payloads persist Termin', async () => {
    const { CreatePurchaseInvoiceSchema } = await import('../../utils/schemas');
    const parsed = CreatePurchaseInvoiceSchema.safeParse({
      date: '2026-10-10',
      partyId: 'party-1',
      terms: 'Net 14',
      items: [{ itemName: 'Gabah', quantity: 1, rate: 1000 }],
    });
    expect(parsed.success && parsed.data.terms).toBe('Net 14');
  });
});

describe('POST /purchase/invoices (approval queue)', () => {
  const post = (body: unknown) =>
    fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = (over: Record<string, unknown> = {}) => ({
    date: '2026-10-10',
    partyId: 'party-1',
    items: [
      { itemName: 'Gabah', quantity: 1000, rate: 6500, timbanganDiterima: 1000, potonganItem: 100_000 },
      { itemName: 'Gabah Kering Giling', quantity: 1, rate: 3_600_000 },
    ],
    ...over,
  });

  beforeEach(() => {
    vi.mocked(needsApproval).mockResolvedValue(true);
    vi.mocked(queueApproval).mockImplementation(async (_tx, input) => ({ id: 'req-1', ...input }) as never);
  });
  afterEach(() => {
    vi.mocked(needsApproval).mockResolvedValue(false);
  });

  it('queues the invoice grand total: Σ line totals (after potongan per line) + biayaLain', async () => {
    const res = await post(payload());
    expect(res.status).toBe(202);
    expect(vi.mocked(queueApproval).mock.calls[0][1]).toMatchObject({ documentType: 'PurchaseInvoice', amount: 10_000_000 });
  });

  it('accepts a header potongan equal to Σ potonganItem and does not subtract it again', async () => {
    const res = await post(payload({ potongan: 100_000, biayaLain: -50_000 }));
    expect(res.status).toBe(202);
    expect(vi.mocked(queueApproval).mock.calls[0][1].amount).toBe(9_950_000);
  });

  it('refuses a header potongan the lines do not carry', async () => {
    const res = await post(payload({ items: [{ itemName: 'Gabah', quantity: 1, rate: 10_000_000 }], potongan: 500_000 }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('Potongan header harus sama dengan jumlah potongan per baris.');
    expect(queueApproval).not.toHaveBeenCalled();
  });
});

describe('CreatePurchaseInvoiceSchema header potongan', () => {
  const items = [{ itemName: 'Gabah', quantity: 1, rate: 1000, potonganItem: 200 }];

  it('passes when the header potongan is zero or not sent', async () => {
    const { CreatePurchaseInvoiceSchema } = await import('../../utils/schemas');
    expect(CreatePurchaseInvoiceSchema.safeParse({ date: '2026-10-10', partyId: 'p', items }).success).toBe(true);
    expect(CreatePurchaseInvoiceSchema.safeParse({ date: '2026-10-10', partyId: 'p', items, potongan: 0 }).success).toBe(true);
  });

  it('fails on the potongan path when the header differs from the lines', async () => {
    const { CreatePurchaseInvoiceSchema } = await import('../../utils/schemas');
    const parsed = CreatePurchaseInvoiceSchema.safeParse({ date: '2026-10-10', partyId: 'p', items, potongan: 500 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ['potongan'],
      message: 'Potongan header harus sama dengan jumlah potongan per baris. Isi potongan di baris item.',
    });
  });
});
