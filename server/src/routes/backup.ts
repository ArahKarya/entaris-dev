// Database backups (mounted at /api/backup behind requirePerm('audit')). Dump, restore and rotation
// live in services/backupService.ts; this file only maps them to HTTP.

import { Router, type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { requireCap } from '../middleware/auth';
import { logger } from '../lib/logger';
import {
  BACKUP_FILE_INVALID,
  BackupOperationError,
  RESTORE_UNCERTAIN,
  SAFETY_BACKUP_FAILED,
  createBackup,
  ensureBackupDir,
  listBackups,
  resolveBackupPath,
  restoreBackup,
  rotateBackups,
  uploadFileName,
} from '../services/backupService';

const router = Router();

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// GET /api/backup/list — list backup files
router.get('/list', async (_req, res) => {
  try {
    return res.json(await listBackups());
  } catch (error) {
    logger.error({ error }, 'GET /backup/list error');
    return res.status(500).json({ error: 'Gagal membaca daftar backup.' });
  }
});

// POST /api/backup/create — trigger pg_dump
router.post('/create', async (_req, res) => {
  try {
    const { filename, size, date } = await createBackup('backup');
    return res.json({ filename, size, date });
  } catch (error: unknown) {
    logger.error({ error: error instanceof Error ? error.message : error }, 'POST /backup/create error');
    return res.status(500).json({ error: 'Gagal membuat backup. Silakan coba lagi atau hubungi administrator.' });
  }
});

// GET /api/backup/download/:filename — download a backup file
router.get('/download/:filename', async (req, res) => {
  try {
    const filepath = resolveBackupPath(req.params.filename);
    if (!filepath) return res.status(400).json({ error: 'Format file tidak valid.' });
    try {
      await fs.promises.access(filepath);
    } catch {
      return res.status(404).json({ error: 'File backup tidak ditemukan.' });
    }

    const name = path.basename(filepath);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    fs.createReadStream(filepath).pipe(res);
  } catch (error) {
    logger.error({ error }, 'GET /backup/download error');
    return res.status(500).json({ error: 'Gagal mengunduh backup.' });
  }
});

// POST /api/backup/upload — upload backup file from external source. The stored name is always
// a fresh upload-<ts>-<rand>.sql.gz, so an upload never overwrites another file.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureBackupDir().then((dir) => cb(null, dir), (err: Error) => cb(err, ''));
    },
    filename: (_req, _file, cb) => cb(null, uploadFileName()),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.sql.gz') || file.mimetype === 'application/gzip' || file.mimetype === 'application/x-gzip') {
      cb(null, true);
    } else {
      cb(new Error('Hanya file .sql.gz yang diperbolehkan.'));
    }
  },
});

/** upload.single('file') with its errors answered as 400 instead of reaching the error handler. */
function receiveUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Ukuran file backup melebihi 500 MB.' });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'File backup tidak ditemukan dalam request.' });
    }
    logger.warn({ error: err instanceof Error ? err.message : err }, 'POST /backup/upload rejected');
    return res.status(400).json({ error: 'Hanya file .sql.gz yang diperbolehkan.' });
  });
}

// The capability gate runs before multer, so a refused upload is never written to disk.
router.post('/upload', requireCap('doc.cancel'), receiveUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File backup tidak ditemukan dalam request.' });
    }

    const filename = req.file.filename;
    const size = req.file.size;
    await rotateBackups();

    logger.info({ filename, size, originalName: req.file.originalname }, 'Backup file uploaded');
    return res.json({
      message: `File ${filename} diunggah.`,
      filename,
      size,
    });
  } catch (error: unknown) {
    logger.error({ error: error instanceof Error ? error.message : error }, 'POST /backup/upload error');
    return res.status(500).json({ error: 'Gagal mengupload file backup.' });
  }
});

// POST /api/backup/restore — restore from backup: safety backup first, then one all-or-nothing
// psql transaction.
router.post('/restore', requireCap('doc.cancel'), async (req, res) => {
  const { filename } = req.body ?? {};
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Parameter filename wajib diisi.' });
  }
  const filepath = resolveBackupPath(filename);
  if (!filepath) return res.status(400).json({ error: 'Format file tidak valid.' });
  try {
    await fs.promises.access(filepath);
  } catch {
    return res.status(404).json({ error: 'File backup tidak ditemukan.' });
  }
  const sanitized = path.basename(filepath);

  try {
    const { safetyBackup } = await restoreBackup(filepath);
    logger.info({ restored: sanitized, safetyBackup }, 'Backup restored');
    return res.json({
      message: `Backup dipulihkan dari ${sanitized}. Data sebelumnya disimpan sebagai ${safetyBackup}. Mulai ulang aplikasi agar pembaruan database diterapkan ulang, lalu masuk kembali.`,
      safetyBackup,
    });
  } catch (error: unknown) {
    if (error instanceof BackupOperationError && error.code === BACKUP_FILE_INVALID) {
      logger.warn({ error: error.message, restore: sanitized }, 'POST /backup/restore archive check failed');
      return res.status(400).json({
        error: 'File cadangan rusak atau terpotong (pemeriksaan gzip gagal), jadi restore dibatalkan. Data tidak berubah.',
        code: error.code,
      });
    }
    if (error instanceof BackupOperationError && error.code === RESTORE_UNCERTAIN) {
      logger.error({ error: error.message, restore: sanitized, safetyBackup: error.safetyBackup }, 'POST /backup/restore may have been applied');
      return res.status(500).json({
        error: `Restore tidak selesai dengan bersih dan database mungkin sudah berubah. Pulihkan cadangan pengaman ${error.safetyBackup} untuk kembali ke data sebelum restore.`,
        code: error.code,
        safetyBackup: error.safetyBackup,
      });
    }
    if (error instanceof BackupOperationError && error.code === SAFETY_BACKUP_FAILED) {
      logger.error({ error: error.message, restore: sanitized }, 'POST /backup/restore safety backup failed');
      return res.status(500).json({
        error: 'Cadangan pengaman gagal dibuat, jadi restore dibatalkan. Data tidak berubah.',
        code: error.code,
      });
    }
    if (error instanceof BackupOperationError) {
      logger.error({ error: error.message, restore: sanitized, safetyBackup: error.safetyBackup }, 'POST /backup/restore failed');
      return res.status(500).json({
        error: 'Restore gagal dan dibatalkan seluruhnya; data tidak berubah. Kemungkinan penyebab: file bukan cadangan Entaris yang dibuat dengan --clean, file rusak, atau dibuat pg_dump yang lebih baru dari server database.',
        code: error.code,
        safetyBackup: error.safetyBackup,
      });
    }
    logger.error({ error: error instanceof Error ? error.message : error }, 'POST /backup/restore error');
    return res.status(500).json({ error: 'Gagal restore backup. Silakan coba lagi atau hubungi administrator.' });
  }
});

export default router;
