import { describe, it, expect } from 'vitest';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';
import { BusinessError } from '../../utils/errors';
import { translateMessage } from '../../i18n/translateMessage';
import {
  INVOICE_OUTSTANDING_RANGE,
  deriveSalesInvoiceStatus,
  resyncSalesInvoiceStatusInTx,
  setSalesInvoiceOutstandingInTx,
} from '../salesInvoiceStatus';

describe('deriveSalesInvoiceStatus', () => {
  it.each([
    ['0', '1000', 'Paid'],
    ['0.01', '1000', 'Paid'],
    ['0.02', '1000', 'PartiallyPaid'],
    ['999.99', '1000', 'PartiallyPaid'],
    ['1000', '1000', 'Submitted'],
    ['1000.01', '1000', 'Submitted'],
    ['0', '0', 'Paid'],
  ])('outstanding %s of %s is %s', (outstanding, grandTotal, status) => {
    expect(deriveSalesInvoiceStatus(outstanding, grandTotal)).toBe(status);
  });
});

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'si-1', invoiceNumber: 'SI-1', status: 'Submitted', outstanding: '1000', grandTotal: '1000', ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe('setSalesInvoiceOutstandingInTx', () => {
  it('locks the row, then writes the moved outstanding with its derived status', async () => {
    const { tx, fn } = makeAutoTx({ 'salesInvoice.findUnique': () => invoice({ status: 'PartiallyPaid', outstanding: '400' }) });
    const r = await setSalesInvoiceOutstandingInTx(tx, 'si-1', { delta: '-400' });
    expect(r.outstanding.toFixed(2)).toBe('0.00');
    expect(r.status).toBe('Paid');
    const lock = fn('$queryRaw').mock.calls[0]![0] as string[];
    expect(lock.join('?')).toMatch(/FROM sales_invoices WHERE id = \? FOR UPDATE/);
    expect(fn('$queryRaw').mock.invocationCallOrder[0]!).toBeLessThan(fn('salesInvoice.findUnique').mock.invocationCallOrder[0]!);
    expect(fn('salesInvoice.update')).toHaveBeenCalledWith({ where: { id: 'si-1' }, data: { outstanding: 0, status: 'Paid' } });
  });

  it('reopens a paid invoice to PartiallyPaid, and to Submitted when nothing is settled', async () => {
    const paid = makeAutoTx({ 'salesInvoice.findUnique': () => invoice({ status: 'Paid', outstanding: '0' }) });
    expect((await setSalesInvoiceOutstandingInTx(paid.tx, 'si-1', { delta: 200 })).status).toBe('PartiallyPaid');
    const full = makeAutoTx({ 'salesInvoice.findUnique': () => invoice({ status: 'Paid', outstanding: '0' }) });
    expect((await setSalesInvoiceOutstandingInTx(full.tx, 'si-1', { delta: 1000 })).status).toBe('Submitted');
  });

  it('stores a result within the tolerance below 0 as 0', async () => {
    const { tx, fn } = makeAutoTx({ 'salesInvoice.findUnique': () => invoice({ outstanding: '100' }) });
    await setSalesInvoiceOutstandingInTx(tx, 'si-1', { delta: '-100.01' });
    expect(fn('salesInvoice.update').mock.calls[0]![0].data).toEqual({ outstanding: 0, status: 'Paid' });
  });

  it.each([
    ['below 0', { outstanding: '100' }, '-100.02'],
    ['above the grand total', { outstanding: '1000' }, '0.02'],
    ['on a cancelled invoice', { outstanding: '0', status: 'Cancelled' }, '1'],
    ['on a draft invoice', { outstanding: '1000', status: 'Draft' }, '-1'],
  ])('rejects a change %s and writes nothing', async (_label, over, delta) => {
    const { tx, fn } = makeAutoTx({ 'salesInvoice.findUnique': () => invoice(over) });
    expect(await codeOf(setSalesInvoiceOutstandingInTx(tx, 'si-1', { delta }))).toBe(INVOICE_OUTSTANDING_RANGE);
    expect(fn('salesInvoice.update')).not.toHaveBeenCalled();
  });

  it('has English text for both refusals', async () => {
    const out = makeAutoTx({ 'salesInvoice.findUnique': () => invoice() });
    const range = await setSalesInvoiceOutstandingInTx(out.tx, 'si-1', { delta: 5 }).catch((e: Error) => e.message);
    expect(translateMessage(range as string, 'en')).toBe(
      'The outstanding amount of invoice SI-1 would become Rp 1005.00, outside the range Rp 0 to Rp 1000.00. Check this invoice\'s data.',
    );
    const cancelled = makeAutoTx({ 'salesInvoice.findUnique': () => invoice({ status: 'Cancelled' }) });
    const state = await setSalesInvoiceOutstandingInTx(cancelled.tx, 'si-1', { delta: 5 }).catch((e: Error) => e.message);
    expect(translateMessage(state as string, 'en')).toBe('Invoice SI-1 is Cancelled; its outstanding amount cannot be changed.');
  });
});

describe('resyncSalesInvoiceStatusInTx', () => {
  it('writes only the derived status, conditioned on the status and outstanding seen', async () => {
    const { tx, fn } = makeAutoTx({ 'salesInvoice.updateMany': () => ({ count: 1 }) });
    const ok = await resyncSalesInvoiceStatusInTx(tx, { id: 'si-1', status: 'Submitted', outstanding: '0.00', grandTotal: '300.00' });
    expect(ok).toBe(true);
    expect(fn('salesInvoice.updateMany')).toHaveBeenCalledWith({
      where: { id: 'si-1', status: 'Submitted', outstanding: 0 },
      data: { status: 'Paid' },
    });
  });

  it('leaves a matching, draft or cancelled invoice alone', async () => {
    const { tx, fn } = makeAutoTx();
    expect(await resyncSalesInvoiceStatusInTx(tx, { id: 'a', status: 'Paid', outstanding: '0', grandTotal: '10' })).toBe(false);
    expect(await resyncSalesInvoiceStatusInTx(tx, { id: 'b', status: 'Cancelled', outstanding: '0', grandTotal: '10' })).toBe(false);
    expect(await resyncSalesInvoiceStatusInTx(tx, { id: 'c', status: 'Draft', outstanding: '10', grandTotal: '10' })).toBe(false);
    expect(fn('salesInvoice.updateMany')).not.toHaveBeenCalled();
  });

  it('reports false when the invoice changed since the report', async () => {
    const { tx } = makeAutoTx({ 'salesInvoice.updateMany': () => ({ count: 0 }) });
    expect(await resyncSalesInvoiceStatusInTx(tx, { id: 'si-1', status: 'Submitted', outstanding: '0', grandTotal: '10' })).toBe(false);
  });
});
