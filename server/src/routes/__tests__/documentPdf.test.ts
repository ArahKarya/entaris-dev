/**
 * PDF dokumen untuk agen: POST /attachments/pdf-link (tiket) + resolveDocumentPdf (render nyata dengan bundel client).
 * Loopback GET detail dimock; bundel SSR nyata dipakai bila sudah dibangun (npm run build:pdf di client).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { existsSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret-value-0123456789';
});

const { prismaMock, permission } = vi.hoisted(() => ({
  prismaMock: { user: { findUnique: vi.fn() }, transactionAttachment: { findUnique: vi.fn() } },
  permission: { can: vi.fn() },
}));
vi.mock('../../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../services/permissionService', async () => {
  const real = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return { ...real, can: permission.can };
});

import { resetUsedJtiForTests, verifyFileTicket, fileTicketSecret } from '../../services/fileTicket';
import { pdfBundlePath, resolveDocumentPdf, isPdfKind } from '../../services/documentPdf';
import attachmentLinks from '../attachmentLinks';

let server: Server;
let base = '';

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PUBLIC_BASE_URL = 'https://erp.contoh.id';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { userId: string; role: string } }).user = { userId: 'u1', role: 'Accountant' };
    next();
  });
  app.use('/attachments', attachmentLinks);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  vi.clearAllMocks();
  resetUsedJtiForTests();
  permission.can.mockResolvedValue(true);
});

const post = (body: unknown) =>
  fetch(`${base}/attachments/pdf-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /attachments/pdf-link', () => {
  it('mengembalikan tiket document-pdf berisi jenis:id', async () => {
    const r = await post({ docType: 'quotation', docId: 'abc-123' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ mimeType: 'application/pdf', oneTimeUse: true, expiresInSeconds: 300, docType: 'quotation' });
    const ticket = String(j.url).split('/api/files/dl/')[1];
    expect(verifyFileTicket(fileTicketSecret(), ticket)).toMatchObject({ uid: 'u1', kind: 'document-pdf', ref: 'quotation:abc-123' });
    expect(permission.can).toHaveBeenCalledWith('Accountant', 'quotation', 'view');
  });

  it('403 bila tak punya izin view modul dokumen', async () => {
    permission.can.mockResolvedValue(false);
    expect((await post({ docType: 'purchase_order', docId: 'x' })).status).toBe(403);
  });

  it('400 untuk docType tak dikenal / input kosong', async () => {
    expect((await post({ docType: 'rahasia', docId: 'x' })).status).toBe(400);
    expect((await post({ docType: 'quotation' })).status).toBe(400);
  });
});

describe('resolveDocumentPdf', () => {
  it('isPdfKind hanya menerima jenis terdaftar', () => {
    expect(isPdfKind('proforma_invoice')).toBe(true);
    expect(isPdfKind('constructor')).toBe(false);
    expect(isPdfKind(undefined)).toBe(false);
  });

  it('ref rusak → 404', async () => {
    expect(await resolveDocumentPdf({ userId: 'u1', role: 'Admin' }, 'tanpa-pemisah')).toMatchObject({ ok: false, status: 404 });
    expect(await resolveDocumentPdf({ userId: 'u1', role: 'Admin' }, 'invoice_x:1')).toMatchObject({ ok: false, status: 404 });
  });

  const hasBundle = existsSync(pdfBundlePath());
  const hasBundle2 = hasBundle;
  (hasBundle ? it : it.skip)('merender PDF nyata dari bundel client untuk 4 jenis dokumen penjualan/pembelian', async () => {
    const item = { itemName: 'Pellet Sekam', quantity: 10, unit: 'Ton', rate: 1500000, discount: 0, taxPct: 11, amount: 15000000, estimatedRate: 1500000, estimatedAmount: 15000000 };
    const base = { date: '2026-10-22', validUntil: '2026-11-22', status: 'Submitted', subtotal: 15000000, potongan: 0, biayaLain: 0, grandTotal: 16650000, totalEstimated: 15000000, customer: { name: 'CV Pembeli' }, supplier: { name: 'PT Pemasok' }, items: [item] };
    const bodies: Record<string, unknown> = {
      quotation: { ...base, quotationNumber: 'QUO-T-1' },
      proforma_invoice: { ...base, proformaNumber: 'PRO-T-1', displayStatus: 'Terkirim', payment: { paid: 1000 } },
      sales_order: { ...base, soNumber: 'SO-T-1' },
      purchase_order: { ...base, poNumber: 'PO-T-1', displayStatus: 'Submitted' },
    };
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url !== 'string' || !url.startsWith('http://127.0.0.1:')) return realFetch(url as never, init);
      calls.push(url);
      if (url.includes('/api/settings/company')) return new Response(JSON.stringify({ companyName: 'PT Contoh Pangan' }), { status: 200 });
      const kind = Object.keys(bodies).find((k) => url.includes({ quotation: '/quotations/', proforma_invoice: '/proforma-invoices/', sales_order: '/sales-orders/', purchase_order: '/purchase-orders/' }[k]!));
      return new Response(JSON.stringify(bodies[kind!]), { status: 200 });
    }));
    for (const [kind, name] of [['quotation', 'QUO-T-1'], ['proforma_invoice', 'PRO-T-1'], ['sales_order', 'SO-T-1'], ['purchase_order', 'PO-T-1']]) {
      const r = await resolveDocumentPdf({ userId: 'u1', role: 'Admin' }, `${kind}:id-1`);
      expect(r.ok, `${kind}`).toBe(true);
      if (r.ok) {
        expect(r.fileName).toBe(`${name}.pdf`);
        expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');
        expect(r.buffer.length).toBeGreaterThan(2000);
      }
    }
    vi.unstubAllGlobals();
    expect(calls.some((c) => c.includes('/api/quotations/id-1'))).toBe(true);
  }, 60_000);

  (hasBundle2 ? it : it.skip)('merender PDF nyata untuk DO, STT, Transfer, Opname, Produksi', async () => {
    const wh = { code: 'GD1', name: 'Gudang Utama' };
    const inv = { code: 'BRG-1' };
    const line = { inventoryItem: inv, itemName: 'Pellet Sekam', quantity: 10, unit: 'Ton', description: 'curah' };
    const common = { date: '2026-10-22', status: 'Submitted', nomorMobil: 'B 1234 XY', driverName: 'Budi', recipientName: 'Sari', notes: 'tes' };
    const bodies: Record<string, unknown> = {
      delivery_order: { ...common, doNumber: 'DO-T-1', customer: { name: 'CV Bumi', address: 'Jl. A', phone: '0812' }, salesOrder: { soNumber: 'SO-1', customerRefNo: 'PO-C' }, items: [line] },
      goods_receipt: { ...common, sttNumber: 'STT-T-1', supplier: { name: 'Pemasok X' }, purchaseOrder: { poNumber: 'PO-1' }, items: [line] },
      stock_transfer: { ...common, transferNumber: 'TRF-T-1', fromWarehouse: wh, toWarehouse: { code: 'GD2', name: 'Gudang Dua' }, items: [{ quantity: 5, item: { code: 'BRG-1', name: 'Pellet', unit: 'Ton' } }] },
      stock_opname: { ...common, opnameNumber: 'OPN-T-1', createdBy: { fullName: 'Admin' }, items: [
        { item: { code: 'BRG-1', name: 'Pellet', unit: 'Ton' }, systemStock: 10, actualStock: 8, difference: -2, unitCost: 1000, totalValue: -2000 },
        { item: { code: 'BRG-2', name: 'Abu', unit: 'Kg' }, systemStock: 5, actualStock: 5, difference: 0, unitCost: 10, totalValue: 0 },
      ] },
      production_run: { runNumber: 'PRD-T-1', date: '2026-10-22', notes: 'tes', yieldPct: 65, computedHpp: 8000, totalMaterialCost: 50000, totalCostInputSide: 1000, totalCostOutputSide: 0, totalByproductValue: 0, runProcesses: [{ process: { name: 'Giling' } }], runCosts: [{ description: 'Listrik', costSide: 'InputSide', basis: 'InputQty', rate: 100, qtyBasis: 10, totalAmount: 1000 }],
        items: [
          { lineType: 'Input', quantity: 10, unitPrice: 5000, warehouse: wh, item: { code: 'GBH', name: 'Gabah', unit: 'Ton' } },
          { lineType: 'Output', quantity: 6, warehouse: wh, item: { code: 'BRS', name: 'Beras', unit: 'Ton', averageCost: 8000 } },
        ] },
    };
    const urlKey: Record<string, string> = { delivery_order: '/delivery-orders/', goods_receipt: '/goods-receipts/', stock_transfer: '/stock-transfers/', stock_opname: '/stock-opname/', production_run: '/inventory/production-runs/' };
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url !== 'string' || !url.startsWith('http://127.0.0.1:')) return realFetch(url as never, init);
      if (url.includes('/api/settings/company')) return new Response(JSON.stringify({ companyName: 'PT Contoh Pangan' }), { status: 200 });
      const kind = Object.keys(urlKey).find((k) => url.includes(urlKey[k]));
      return new Response(JSON.stringify(bodies[kind!]), { status: 200 });
    }));
    const names: Record<string, string> = { delivery_order: 'DO-T-1.pdf', goods_receipt: 'STT-T-1.pdf', stock_transfer: 'TRF-T-1.pdf', stock_opname: 'stok-opname-OPN-T-1.pdf', production_run: 'PRD-T-1.pdf' };
    for (const kind of Object.keys(names)) {
      const r = await resolveDocumentPdf({ userId: 'u1', role: 'Admin' }, `${kind}:id-1`);
      expect(r.ok, kind).toBe(true);
      if (r.ok) {
        expect(r.fileName).toBe(names[kind]);
        expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');
        expect(r.buffer.length, kind).toBeGreaterThan(1500);
        if (process.env.PDF_DUMP_DIR) writeFileSync(`${process.env.PDF_DUMP_DIR}/${names[kind]}`, r.buffer);
      }
    }
    vi.unstubAllGlobals();
  }, 90_000);

  it('meneruskan 403/404 dari endpoint detail (RBAC datang dari endpoint itu)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    expect(await resolveDocumentPdf({ userId: 'u1', role: 'Viewer' }, 'quotation:q1')).toMatchObject({ ok: false, status: 403 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await resolveDocumentPdf({ userId: 'u1', role: 'Admin' }, 'sales_order:nope')).toMatchObject({ ok: false, status: 404 });
    vi.unstubAllGlobals();
  });
});
