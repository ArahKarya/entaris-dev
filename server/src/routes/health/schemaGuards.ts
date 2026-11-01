// Schema guards for /api/health-check: database objects the app relies on for integrity but that
// Prisma does not model (triggers today). Detection only, never fixable from the UI; the message
// names the remedy for each problem. Later guards (constraints, other triggers) add entries here.
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

  // The remedy depends on the problem: a restart re-applies the migration only when
  // _prisma_migrations no longer lists it (restore of an older dump); a trigger disabled or dropped
  // by hand stays broken after a restart (MIGRATION.md, "Migrasi trigger jejak audit").
  const missing = problems.filter((p) => p.problem === 'missing').length;
  const disabled = problems.filter((p) => p.problem === 'disabled').map((p) => p.name).join(', ');
  return {
    name: 'Required Database Triggers',
    status: problems.length > 0 ? 'error' : 'ok',
    message: problems.length === 0
      ? 'Semua trigger database aktif'
      : missing > 0 && disabled
        ? `${missing} trigger database hilang dan ${problems.length - missing} nonaktif; jejak audit bisa diubah. Jalankan ulang SQL migrasi trigger sesuai MIGRATION.md (Migrasi trigger jejak audit).`
        : missing > 0
          ? `${missing} trigger database hilang; jejak audit bisa diubah. Setelah restore cadangan lama, mulai ulang aplikasi; bila tetap merah, jalankan ulang SQL migrasi trigger sesuai MIGRATION.md (Migrasi trigger jejak audit).`
          : `${problems.length} trigger database nonaktif; jejak audit bisa diubah. Aktifkan lagi dengan ALTER TABLE audit_trail ENABLE TRIGGER <nama> untuk: ${disabled}.`,
    count: problems.length,
    details: problems,
    fixable: false,
  };
}
