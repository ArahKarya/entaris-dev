import { useState } from 'react';
import { toast } from 'sonner';
import api from '../api';
import { useCompanyPDF } from './useCompanyPDF';
import type { PaymentRequestPDFData } from './PaymentRequestPDF';
import type { AttachmentRef } from './mergePdfWithAttachments';
import { loadPdfStrings, pdfT } from './pdfFormat';

export type PaymentRequestPdfVariant = 'request' | 'settlement';

type Attachment = { id: string; fileName: string; mimeType: string; scope: 'REQUEST' | 'SETTLEMENT' };

/**
 * Builds the Pengajuan / Pertanggungjawaban PDF on demand (renderer + template lazy-loaded), optionally
 * merging the attachments of that stage (REQUEST or SETTLEMENT scope) behind it, then downloads it.
 */
export function usePaymentRequestPdf() {
  const company = useCompanyPDF();
  const [busy, setBusy] = useState<PaymentRequestPdfVariant | null>(null);

  const download = async (
    pr: Omit<PaymentRequestPDFData, 'attachments'> & { attachments?: Attachment[] },
    variant: PaymentRequestPdfVariant,
    merge: boolean,
  ) => {
    setBusy(variant);
    try {
      const [{ pdf }, mod] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./PaymentRequestPDF'),
        loadPdfStrings(),
      ]);
      const Template = variant === 'settlement' ? mod.PaymentRequestSettlementPDF : mod.PaymentRequestPDF;
      let blob = await pdf(<Template pr={pr} company={company} />).toBlob();

      const scope = variant === 'settlement' ? 'SETTLEMENT' : 'REQUEST';
      const refs: AttachmentRef[] = (pr.attachments ?? [])
        .filter((a) => (scope === 'SETTLEMENT' ? a.scope === 'SETTLEMENT' : a.scope !== 'SETTLEMENT'))
        .map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, fetchUrl: `/payment-requests/attachments/${a.id}` }));
      if (merge && refs.length) {
        const { mergeInvoicePdfWithAttachments } = await import('./mergePdfWithAttachments');
        blob = await mergeInvoicePdfWithAttachments(blob, refs, {
          fetchBinary: async (url) => (await api.get(url, { responseType: 'arraybuffer' })).data as ArrayBuffer,
        });
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${pr.number}${variant === 'settlement' ? '_pertanggungjawaban' : ''}${merge && refs.length ? '_lampiran' : ''}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : pdfT()('paymentRequest.buildFailed'));
    } finally {
      setBusy(null);
    }
  };

  return { download, busy };
}
