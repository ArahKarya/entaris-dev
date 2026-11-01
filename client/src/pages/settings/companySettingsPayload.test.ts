import { describe, expect, it } from 'vitest';
import { companySettingsPayload } from './companySettingsPayload';

const FORM = { companyName: 'PT Maju', taxId: '01.234' };
const INVOICE = { sales: { footerNote: 'Terima kasih' } };

describe('companySettingsPayload', () => {
  it('sends back the loaded fiscal start month so a save does not reset it to January', () => {
    expect(companySettingsPayload(FORM, INVOICE, { fiscalYearStartMonth: 4 })).toEqual({
      companyName: 'PT Maju',
      taxId: '01.234',
      invoiceSettings: INVOICE,
      fiscalYearStartMonth: 4,
    });
  });

  it('never sends a currency, even when the loaded row still has a foreign one', () => {
    const payload = companySettingsPayload(FORM, INVOICE, { fiscalYearStartMonth: 1, defaultCurrency: 'USD' } as never);
    expect(payload).not.toHaveProperty('defaultCurrency');
    expect(payload).not.toHaveProperty('currency');
  });

  it('leaves the month out when nothing valid was loaded', () => {
    for (const loaded of [null, undefined, {}, { fiscalYearStartMonth: 13 }, { fiscalYearStartMonth: '4' }]) {
      expect(companySettingsPayload(FORM, INVOICE, loaded)).not.toHaveProperty('fiscalYearStartMonth');
    }
  });
});
