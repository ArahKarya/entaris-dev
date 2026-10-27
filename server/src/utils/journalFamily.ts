import { Prisma } from '@prisma/client';

/**
 * Where-clause for a document's journal `base` and its satellites `<base>-…` (revisions `-R2`,
 * `-CORR`, `-CXL`). The dash boundary keeps JV-PR-202601-1000 from matching JV-PR-202601-10000.
 */
export function journalFamilyWhere(base: string): Prisma.JournalEntryWhereInput {
  return { OR: [{ entryNumber: base }, { entryNumber: { startsWith: `${base}-` } }] };
}
