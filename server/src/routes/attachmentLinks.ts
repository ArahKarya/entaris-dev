import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import type { AuthRequest } from '../middleware/auth';
import { handleRouteError } from '../utils/errors';
import { checkAttachmentAccess, isAttachmentRefType } from '../services/attachmentAccess';
import { buildDownloadUrl, FILE_TICKET_TTL_SEC, fileTicketSecret, signFileTicket } from '../services/fileTicket';

const router = Router();
const actorOf = (req: AuthRequest) => (req.user ? { userId: req.user.userId, role: req.user.role } : undefined);

const attachmentLinkSchema = z.object({ attachmentId: z.string().uuid('attachmentId harus UUID.') });

// POST /api/attachments/download-link — tiket unduh isi lampiran (ACL `view` dokumen induk).
router.post('/download-link', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = attachmentLinkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid.' });
    const att = await prisma.transactionAttachment.findUnique({ where: { id: parsed.data.attachmentId } });
    if (!att) return res.status(404).json({ error: 'Lampiran tidak ditemukan.' });
    if (!isAttachmentRefType(att.referenceType)) return res.status(400).json({ error: 'Jenis dokumen lampiran tidak dikenal.' });
    const access = await checkAttachmentAccess(actorOf(req), att.referenceType, att.referenceId, 'view');
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const ticket = signFileTicket(fileTicketSecret(), { uid: req.user!.userId, kind: 'attachment', ref: att.id, fn: att.fileName });
    const { url, absolute } = buildDownloadUrl(ticket);
    return res.json({
      url,
      fileName: att.fileName,
      mimeType: att.mimeType,
      size: att.fileSize,
      expiresInSeconds: FILE_TICKET_TTL_SEC,
      oneTimeUse: true,
      ...(absolute ? {} : { warning: 'PUBLIC_BASE_URL belum diatur: url relatif, tambahkan alamat publik aplikasi di depannya.' }),
    });
  } catch (error) {
    return handleRouteError(res, error, 'POST /attachments/download-link', 'Gagal membuat tautan unduh.');
  }
});

export default router;
