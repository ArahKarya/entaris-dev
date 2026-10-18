import type { Prisma } from '@prisma/client';

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

/**
 * Owner filter for Inquiries. The effective owner is the Inquiry's PIC, or the Customer's PIC when
 * the Inquiry has none, so an unassigned Inquiry follows its Customer.
 */
export function inquiryOwnerClause(filter: OwnerFilter): Prisma.InquiryWhereInput {
  if (!filter.ownerId) return {};
  const unownedParty: Prisma.InquiryWhereInput[] = [{ partyId: null }, { party: { is: { salesOwnerId: null } } }];
  if (filter.ownerId === 'unassigned') return { salesOwnerId: null, OR: unownedParty };
  const mine: Prisma.InquiryWhereInput[] = [
    { salesOwnerId: filter.ownerId },
    { salesOwnerId: null, party: { is: { salesOwnerId: filter.ownerId } } },
  ];
  if (filter.strictOwner) return { OR: mine };
  return { OR: [...mine, { salesOwnerId: null, OR: unownedParty }] };
}

/** In-memory form of ownerClause for rows that are already loaded. */
export function matchesOwner(salesOwnerId: string | null, filter: OwnerFilter): boolean {
  if (!filter.ownerId) return true;
  if (filter.ownerId === 'unassigned') return salesOwnerId === null;
  return salesOwnerId === filter.ownerId || (!filter.strictOwner && salesOwnerId === null);
}
