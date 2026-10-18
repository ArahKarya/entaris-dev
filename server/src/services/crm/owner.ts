/**
 * Sales-owner filter shared by the CRM lists. A user sees what they own plus unowned records,
 * so nothing falls through while PIC is filled in gradually.
 */
export interface OwnerFilter {
  /** Owner user id, 'unassigned' for records without PIC, or undefined for everyone. */
  ownerId?: string;
  /** Match the owner only, without unowned records. */
  strictOwner?: boolean;
}

export function ownerClause(
  filter: OwnerFilter,
): { salesOwnerId?: string | null; OR?: { salesOwnerId: string | null }[] } {
  if (!filter.ownerId) return {};
  if (filter.ownerId === 'unassigned') return { salesOwnerId: null };
  if (filter.strictOwner) return { salesOwnerId: filter.ownerId };
  return { OR: [{ salesOwnerId: filter.ownerId }, { salesOwnerId: null }] };
}
