// Entry bundel SSR: dipakai server untuk merender PDF dengan templat YANG SAMA dengan UI.
// Pemetaan payload API → props templat di sini meniru drawer terkait (satu-satunya tempat server tahu bentuk props).
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import i18n from '../i18n';
import QuotationPDF from '../lib/pdf/QuotationPDF';
import ProformaInvoicePDF from '../lib/pdf/ProformaInvoicePDF';
import SalesOrderPDF from '../lib/pdf/SalesOrderPDF';
import PurchaseOrderPDF from '../lib/pdf/PurchaseOrderPDF';

export type PdfKind = 'quotation' | 'proforma_invoice' | 'sales_order' | 'purchase_order';

export interface PdfCompany {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  logoUrl: string | null;
  invoiceSettings: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- payload API tak bertipe (sama dengan drawer) */
/** Sama dengan useCompanyPDF: pengaturan perusahaan → header PDF. */
export function companyFromSettings(data: any, fallbackName = 'Perusahaan'): PdfCompany {
  return {
    name: data?.companyName || fallbackName,
    address: data?.address || null,
    phone: data?.phone || null,
    email: data?.email || null,
    taxId: data?.taxId || null,
    logoUrl: data?.logoUrl || null,
    invoiceSettings: data?.invoiceSettings || null,
  };
}

function build(kind: PdfKind, p: any, company: PdfCompany): { element: React.ReactElement; fileName: string } {
  switch (kind) {
    case 'quotation':
      return { element: <QuotationPDF quotation={p} company={company as never} />, fileName: `${p.quotationNumber}.pdf` };
    case 'proforma_invoice': {
      // Sama dengan ProformaDetailDrawer: status tampilan + jumlah terbayar dari ringkasan pembayaran.
      const proforma = { ...p, status: p.displayStatus ?? p.status, paid: p.payment?.paid ?? 0 };
      return { element: <ProformaInvoicePDF proforma={proforma} company={company as never} />, fileName: `${p.proformaNumber}.pdf` };
    }
    case 'sales_order':
      return { element: <SalesOrderPDF so={p} company={company as never} />, fileName: `${p.soNumber}.pdf` };
    case 'purchase_order':
      return { element: <PurchaseOrderPDF po={p} company={company as never} />, fileName: `${p.poNumber}.pdf` };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function renderDoc(
  kind: PdfKind,
  payload: unknown,
  company: PdfCompany,
  lang: 'id' | 'en' = 'id',
): Promise<{ buffer: Uint8Array; fileName: string }> {
  await i18n.changeLanguage(lang);
  await i18n.loadNamespaces('pdf');
  const { element, fileName } = build(kind, payload, company);
  return { buffer: await renderToBuffer(element as never), fileName };
}
