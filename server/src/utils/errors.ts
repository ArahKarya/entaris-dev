import { Response } from 'express';
import { logger } from '../lib/logger';

export class BusinessError extends Error {
  /** Stable machine-readable code for clients; the message may be translated. */
  readonly code?: string;
  /** HTTP status handleRouteError answers with: 400 by default, 409 for a retryable conflict. */
  readonly status: 400 | 409;
  constructor(message: string, code?: string, status: 400 | 409 = 400) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.status = status;
  }
}

/**
 * True for a Postgres check_violation (SQLSTATE 23514) raised by the deferred ledger balance
 * triggers: they say "unbalanced" or "fiscal year split". Prisma's driver adapter keeps the SQLSTATE
 * on the error itself, on `meta` or on `cause`, depending on where the failure surfaced (COMMIT
 * included), so all three are read. Ordinary CHECK constraint failures also carry 23514 and are
 * excluded by the message.
 */
export function isLedgerUnbalanced(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown; message?: unknown }; cause?: { code?: unknown; message?: unknown }; message?: unknown } | null | undefined;
  if (!e) return false;
  const hasState = [e.code, e.meta?.code, e.cause?.code].includes('23514');
  if (!hasState) return false;
  const text = [e.message, e.meta?.message, e.cause?.message].filter((m): m is string => typeof m === 'string').join(' ');
  return /unbalanced|fiscal year split/i.test(text);
}

/**
 * Standardized error handler for route catch blocks.
 * Handles BusinessError, Prisma errors, and transaction timeouts consistently.
 */
export function handleRouteError(res: Response, error: any, context: string, fallbackMsg: string) {
  if (error instanceof BusinessError) {
    return res.status(error.status).json(error.code ? { error: error.message, code: error.code } : { error: error.message });
  }
  if (isLedgerUnbalanced(error)) {
    logger.error({ error }, `Ledger balance trigger rejected the transaction: ${context}`);
    return res.status(409).json({ error: 'Jurnal tidak seimbang di buku besar; transaksi dibatalkan.', code: 'LEDGER_UNBALANCED' });
  }
  if (error?.code === 'P2025') {
    return res.status(400).json({ error: 'Data terkait tidak ditemukan. Periksa referensi yang dipilih.' });
  }
  if (error?.code === 'P2002') {
    return res.status(400).json({ error: 'Data duplikat terdeteksi. Silakan coba lagi.' });
  }
  if (error?.code === 'P2003') {
    return res.status(400).json({ error: 'Referensi data tidak valid. Periksa data yang dipilih.' });
  }
  if (error?.message?.includes('Transaction already closed') || error?.message?.includes('Unable to start')) {
    logger.error({ error }, `Transaction timeout: ${context}`);
    return res.status(503).json({ error: 'Server sibuk, silakan coba lagi dalam beberapa detik.' });
  }
  logger.error({ error, stack: error?.stack, code: error?.code }, context);
  return res.status(500).json({ error: fallbackMsg });
}
