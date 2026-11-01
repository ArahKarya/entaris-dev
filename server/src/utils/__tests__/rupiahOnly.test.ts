import { describe, it, expect } from 'vitest';
import {
  CreateAccountSchema,
  PaymentRequestInputSchema,
  RUPIAH,
  UpdateAccountSchema,
  UpdateCompanySettingsSchema,
} from '../schemas';

// Bookkeeping and payment requests are rupiah only (E2-R7, E8-R12 stage 1): every currency field
// accepts IDR (any case, trimmed) or nothing, and rejects other codes with its own message.

const ACCOUNT = { accountNumber: '1.1.99', name: 'Kas Uji', accountType: 'ASSET', rootType: 'ASSET' };
const REQUEST = {
  typeId: 't-1',
  payeeKind: 'EMPLOYEE',
  payeeName: 'Budi',
  purpose: 'Beli ATK kantor',
  lines: [{ description: 'Kertas', amount: 2000 }],
};

const firstMessage = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  r.success ? null : r.error!.issues[0].message;

describe('RUPIAH', () => {
  it('is IDR', () => {
    expect(RUPIAH).toBe('IDR');
  });
});

describe('account currency', () => {
  it('rejects USD on create and update with the bookkeeping message', () => {
    const msg = 'Pembukuan hanya rupiah: mata uang akun harus IDR.';
    expect(firstMessage(CreateAccountSchema.safeParse({ ...ACCOUNT, currency: 'USD' }))).toBe(msg);
    expect(firstMessage(UpdateAccountSchema.safeParse({ currency: 'USD' }))).toBe(msg);
  });

  it('accepts IDR, lower case and missing', () => {
    expect(CreateAccountSchema.parse({ ...ACCOUNT, currency: ' idr ' }).currency).toBe('IDR');
    expect(CreateAccountSchema.parse(ACCOUNT).currency).toBeUndefined();
    expect(UpdateAccountSchema.parse({ currency: 'IDR' }).currency).toBe('IDR');
  });
});

describe('company currency', () => {
  it('rejects USD with the settings message', () => {
    expect(firstMessage(UpdateCompanySettingsSchema.safeParse({ currency: 'USD' })))
      .toBe('Mata uang perusahaan hanya IDR (pembukuan hanya rupiah).');
  });

  it('accepts idr and missing', () => {
    expect(UpdateCompanySettingsSchema.parse({ currency: 'idr' }).currency).toBe('IDR');
    expect(UpdateCompanySettingsSchema.parse({}).currency).toBeUndefined();
  });
});

describe('payment request currency', () => {
  it('rejects USD with exactly "Pengajuan hanya rupiah"', () => {
    expect(firstMessage(PaymentRequestInputSchema.safeParse({ ...REQUEST, currency: 'USD' })))
      .toBe('Pengajuan hanya rupiah');
  });

  it('rejects a non-string currency with the same message', () => {
    expect(firstMessage(PaymentRequestInputSchema.safeParse({ ...REQUEST, currency: 1 })))
      .toBe('Pengajuan hanya rupiah');
  });

  it('accepts IDR and a request without currency', () => {
    expect(PaymentRequestInputSchema.parse({ ...REQUEST, currency: 'Idr' }).currency).toBe('IDR');
    const parsed = PaymentRequestInputSchema.parse({ ...REQUEST, extra: 'x' });
    expect(parsed.currency).toBeUndefined();
    expect(parsed).not.toHaveProperty('extra');
  });
});
