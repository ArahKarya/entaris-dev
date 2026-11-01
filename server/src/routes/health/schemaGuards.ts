// Schema guards for /api/health-check: database objects the app relies on for integrity but that
// Prisma does not model (triggers today). Detection only, never fixable from the UI: the boot
// migration recreates them. Later guards (constraints, other triggers) add entries here.
import { prisma } from '../../lib/prisma';
import type { CheckResult } from './checks';

export interface RequiredTrigger {
  table: string;
  name: string;
}

/** audit_trail append-only (E7-R11, migration 20261106000000_audit_trail_append_only). */
export const REQUIRED_TRIGGERS: readonly RequiredTrigger[] = [
  { table: 'audit_trail', name: 'audit_trail_append_only_row' },
  { table: 'audit_trail', name: 'audit_trail_append_only_truncate' },
];

interface TriggerRow {
  table: string;
  name: string;
  /** pg_trigger.tgenabled: 'D' = disabled; 'O', 'R', 'A' fire. */
  enabled: string;
}

/** Error when a required trigger is missing or disabled. */
export async function checkRequiredTriggers(): Promise<CheckResult> {
  const tables = [...new Set(REQUIRED_TRIGGERS.map((t) => t.table))];
  const rows = await prisma.$queryRaw<TriggerRow[]>`
    SELECT c.relname AS "table", t.tgname AS "name", t.tgenabled::text AS "enabled"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = ANY(${tables}::text[])
       AND NOT t.tgisinternal
  `;
  const found = new Map(rows.map((r) => [`${r.table}.${r.name}`, r.enabled]));
  const problems = REQUIRED_TRIGGERS.flatMap((t): Array<RequiredTrigger & { problem: 'missing' | 'disabled' }> => {
    const enabled = found.get(`${t.table}.${t.name}`);
    if (enabled === undefined) return [{ ...t, problem: 'missing' }];
    if (enabled === 'D') return [{ ...t, problem: 'disabled' }];
    return [];
  });

  return {
    name: 'Required Database Triggers',
    status: problems.length > 0 ? 'error' : 'ok',
    message: problems.length > 0
      ? `${problems.length} trigger database hilang atau nonaktif; jejak audit bisa diubah. Mulai ulang aplikasi agar migrasi berjalan lagi.`
      : 'Semua trigger database aktif',
    count: problems.length,
    details: problems,
    fixable: false,
  };
}
