// delete-dummy removes ledger rows by dummy party, marker or dummy journal. A ledger group is
// (referenceType, referenceId); a row of a dummy party can sit in a group that also holds the rows of
// a real journal. Deleting only the dummy rows would leave that group unbalanced (and a balance
// trigger would reject it), so such a delete is refused instead of widened to the whole group.
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';

export const DUMMY_GROUP_SHARED = 'DUMMY_GROUP_SHARED';

interface GroupRow {
  id: string;
  referenceType: string;
  referenceId: string;
}

const groupKey = (r: { referenceType: string; referenceId: string }) => `${r.referenceType}\u0000${r.referenceId}`;

/** Groups touched by `selected` that also hold active rows outside it, as printable labels. */
export async function findSharedLedgerGroups(tx: Prisma.TransactionClient, selected: readonly GroupRow[]): Promise<string[]> {
  if (selected.length === 0) return [];
  const selectedIds = new Set(selected.map((r) => r.id));
  const groups = new Set(selected.map(groupKey));
  const candidates = await tx.accountingLedgerEntry.findMany({
    where: { referenceId: { in: [...new Set(selected.map((r) => r.referenceId))] }, isCancelled: false },
    select: { id: true, referenceType: true, referenceId: true },
  });
  const outside = candidates.filter((r) => !selectedIds.has(r.id) && groups.has(groupKey(r)));
  if (outside.length === 0) return [];

  const shared = new Map(outside.map((r) => [groupKey(r), r]));
  const journalIds = [...shared.values()].filter((r) => r.referenceType === 'JournalEntry').map((r) => r.referenceId);
  const journals = journalIds.length > 0
    ? await tx.journalEntry.findMany({ where: { id: { in: journalIds } }, select: { id: true, entryNumber: true } })
    : [];
  const numbers = new Map(journals.map((j) => [j.id, j.entryNumber]));
  return [...shared.values()]
    .map((r) => (r.referenceType === 'JournalEntry' ? numbers.get(r.referenceId) ?? r.referenceId : `${r.referenceType} ${r.referenceId}`))
    .sort();
}

/** Throws DUMMY_GROUP_SHARED (before anything is deleted) when a selected ledger row shares its group with a real one. */
export async function assertNoSharedLedgerGroups(tx: Prisma.TransactionClient, selected: readonly GroupRow[]): Promise<void> {
  const shared = await findSharedLedgerGroups(tx, selected);
  if (shared.length > 0) {
    throw new BusinessError(`Data dummy berbagi grup buku besar dengan transaksi asli, jadi penghapusan dibatalkan. Periksa dulu: ${shared.join(', ')}`, DUMMY_GROUP_SHARED);
  }
}
