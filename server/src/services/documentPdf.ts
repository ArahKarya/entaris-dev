// Penyedia PDF dokumen untuk tautan unduh. Fase 1: belum ada renderer, jadi selalu menolak jelas.
// Fase PDF mengganti isi berkas ini dengan render server (templat client yang sama).
import type { AttachmentActor } from './attachmentAccess';

export type DocumentPdfResult =
  | { ok: true; buffer: Buffer; fileName: string }
  | { ok: false; status: 404 | 403 | 501; error: string };

export async function resolveDocumentPdf(_actor: AttachmentActor, _ref: string): Promise<DocumentPdfResult> {
  return { ok: false, status: 501, error: 'PDF dokumen belum tersedia di server ini.' };
}
