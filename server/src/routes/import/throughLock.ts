import { AuthRequest } from '../../middleware/auth';
import { hasCap } from '../../services/permissionService';
import { OPENING_LOCK_RIGHT } from '../../services/ledger/openingBalance';

const THROUGH_LOCK_MIN = 10;

/**
 * The keys (account numbers; row numbers for parties) the user confirmed one by one: repeated form fields, or one comma-separated
 * value (body or query). Each row is confirmed on its own, so ticking one replacement never lets
 * another row (a running balance further down the file) through.
 */
export function confirmedKeys(...values: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const v of values.flat()) {
    if (typeof v !== 'string') continue;
    for (const n of v.split(',')) if (n.trim()) out.add(n.trim());
  }
  return out;
}

export type ThroughLockResult =
  | { ok: true; throughLock: { reason: string } | undefined }
  | { ok: false; status: number; body: { error: string; code?: string } };

/**
 * `throughLockReason` of an import that posts opening balances: posting into a locked month is for
 * period.lock holders only, never AIRA, and the reason goes to the audit trail (owner decision #10).
 * A preview writes nothing, so it ignores the field.
 */
export async function resolveThroughLock(req: AuthRequest, isPreview: boolean): Promise<ThroughLockResult> {
  const reasonRaw = req.body?.throughLockReason;
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  if (!reason || isPreview) return { ok: true, throughLock: undefined };
  if (reason.length < THROUGH_LOCK_MIN) {
    return { ok: false, status: 400, body: { error: 'Alasan menembus kunci periode minimal 10 karakter.' } };
  }
  if (req.user!.via === 'mcp') {
    return { ok: false, status: 403, body: { error: 'AIRA tidak dapat menembus kunci periode untuk saldo awal.', code: OPENING_LOCK_RIGHT } };
  }
  if (!(await hasCap(req.user!.role, 'period.lock'))) {
    return { ok: false, status: 403, body: { error: 'Menembus kunci periode untuk saldo awal butuh hak Kunci Periode (period.lock).', code: OPENING_LOCK_RIGHT } };
  }
  return { ok: true, throughLock: { reason } };
}
