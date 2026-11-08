import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthRequest } from '../../middleware/auth';
import { BusinessError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import { parsePartyRows } from '../../services/partyImportRows';
import { importPartyRow, previewPartyOpening } from '../../services/partyImport';
import { upload, parseFileDetailed, sanitizeCellValue } from './shared';
import { confirmedKeys, resolveThroughLock } from './throughLock';

const router = Router();

// POST /api/import/parties
// The profile of each party comes from the sheet; its opening balances go through the opening
// balance service at the cut-over date (services/partyImport.ts). ?preview=true writes nothing and
// shows per row what the openings would do; a row that replaces a recorded opening needs its row
// number (sheet row, header = 1) in confirmReplace. throughLockReason posts into a locked month:
// period.lock holders only, never AIRA, the reason goes to the audit trail (owner decision #10).
router.post(
  '/parties',
  upload.single('file'),
  async (req: AuthRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'File wajib diunggah.' });

    try {
      const isPreview = req.query.preview === 'true';
      const confirmReplace = confirmedKeys(req.body?.confirmReplace, req.query.confirmReplace);
      const lock = await resolveThroughLock(req, isPreview);
      if (!lock.ok) return res.status(lock.status).json(lock.body);

      const { rows, numericCells } = await parseFileDetailed(req.file.buffer, req.file.originalname);
      const { rows: validRows, errors } = parsePartyRows(rows, numericCells, sanitizeCellValue);

      if (isPreview) {
        const data = [];
        for (const r of validRows) {
          data.push({
            rowNum: r.rowNum,
            name: r.name,
            partyType: r.partyType,
            phone: r.phone,
            email: r.email,
            address: r.address,
            taxId: r.taxId,
            ...r.shown,
            opening: await previewPartyOpening(prisma, r),
          });
        }
        return res.json({ data, errors, total: rows.length });
      }

      let success = 0;
      const openings: Array<{ row: number; name: string; kind: string; action: string; journalNumber: string | null }> = [];
      for (const row of validRows) {
        try {
          const result = await importPartyRow(prisma, row, {
            userId: req.user!.userId,
            confirmed: confirmReplace.has(String(row.rowNum)),
            throughLock: lock.throughLock,
          });
          for (const o of result.openings) openings.push({ row: row.rowNum, name: row.name, ...o });
          for (const issue of result.issues) errors.push({ row: row.rowNum, ...issue });
          success++;
        } catch (err: any) {
          if (!(err instanceof BusinessError)) logger.error({ error: err, party: row.name }, 'POST /import/parties row error');
          errors.push({ row: row.rowNum, message: `Gagal insert "${row.name}": ${err.message}`, ...(err instanceof BusinessError && err.code ? { code: err.code } : {}) });
        }
      }

      return res.json({ success, failed: rows.length - success, errors, openings });
    } catch (error: any) {
      logger.error({ error }, 'POST /import/parties error');
      return res.status(400).json({ error: error.message || 'Gagal memproses file.' });
    }
  }
);

export default router;
