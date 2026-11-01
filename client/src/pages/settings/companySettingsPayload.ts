/**
 * Body of PUT /settings/company from the company profile tab. The endpoint is a full upsert: a
 * field left out is reset (fiscalYearStartMonth to 1). The tab does not edit the fiscal start
 * month, so it sends back the loaded value. No currency is sent: bookkeeping is rupiah only and
 * the server always stores IDR.
 */
export function companySettingsPayload<F extends object, I>(
  form: F,
  invoiceSettings: I,
  loaded: { fiscalYearStartMonth?: unknown } | null | undefined,
): F & { invoiceSettings: I; fiscalYearStartMonth?: number } {
  const month = loaded?.fiscalYearStartMonth;
  const keepMonth = typeof month === 'number' && Number.isInteger(month) && month >= 1 && month <= 12;
  return { ...form, invoiceSettings, ...(keepMonth && { fiscalYearStartMonth: month }) };
}
