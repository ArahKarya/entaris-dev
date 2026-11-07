// The one definition of a legacy cancel pair (E1-R6, PR-6b): an original journal cancelled the old
// way, by posting a reversing "<number>-CXL" journal, but never marked as reversed. The model of
// E1-R6 voids the original instead (no CXL); a reversal posted today sets reversed_by_id. Used by
// the ALE sync cause legacy-stt-pair (aleSyncCheck.ts) and the legacy STT data planner (PR-6b).
import { Prisma } from '@prisma/client';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL predicate on the journal_entries row aliased `alias`: a Submitted journal numbered
 * "<entry_number>-CXL" exists and the row's own reversed_by_id is empty. It says nothing about the
 * row's status; callers add that.
 */
export function legacyCxlPairSql(alias: string): Prisma.Sql {
  if (!ALIAS.test(alias)) throw new Error(`Invalid SQL alias ${alias}`);
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.reversed_by_id IS NULL AND EXISTS (
    SELECT 1 FROM journal_entries cxl_pair
     WHERE cxl_pair.entry_number = ${a}.entry_number || '-CXL' AND cxl_pair.status = 'Submitted'))`;
}
