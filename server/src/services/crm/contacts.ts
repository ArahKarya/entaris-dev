/** Customer contacts (CRM F5): several PICs per Customer, phone kept as 62xxx for wa.me. */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { BusinessError } from '../../utils/errors';
import { normalizePhone } from './phone';

type Db = Prisma.TransactionClient | typeof prisma;

export interface ContactInput {
  name: string;
  position?: string | null;
  phone?: string | null;
  email?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

export interface ContactWarning {
  /** Other Customers already using the same phone number. */
  phoneUsedBy: { partyId: string; partyName: string }[];
}

function cleanPhone(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const phone = normalizePhone(raw);
  if (!phone) throw new BusinessError('Nomor telepon tidak valid.');
  return phone;
}

async function phoneWarning(db: Db, partyId: string, phone: string | null): Promise<ContactWarning> {
  if (!phone) return { phoneUsedBy: [] };
  const others = await db.partyContact.findMany({
    where: { phone, partyId: { not: partyId } },
    select: { party: { select: { id: true, name: true } } },
    take: 5,
  });
  const seen = new Map(others.map((o) => [o.party.id, o.party.name]));
  return { phoneUsedBy: [...seen].map(([partyId, partyName]) => ({ partyId, partyName })) };
}

/**
 * Serialise contact writes per Customer: the party row lock makes the "first contact" count and the
 * primary switch safe under concurrency (a partial unique index backs the one-primary rule).
 */
async function lockParty(tx: Prisma.TransactionClient, partyId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM parties WHERE id = ${partyId} FOR UPDATE`;
  return rows.length > 0;
}

/** Only one primary contact per Customer: clear the others before setting one. */
async function clearOtherPrimary(tx: Prisma.TransactionClient, partyId: string, keepId?: string): Promise<void> {
  await tx.partyContact.updateMany({
    where: { partyId, isPrimary: true, ...(keepId ? { id: { not: keepId } } : {}) },
    data: { isPrimary: false },
  });
}

/** After a primary contact is removed or unflagged, promote the oldest remaining one. */
async function ensurePrimary(tx: Prisma.TransactionClient, partyId: string): Promise<void> {
  if (await tx.partyContact.count({ where: { partyId, isPrimary: true } })) return;
  const next = await tx.partyContact.findFirst({ where: { partyId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (next) await tx.partyContact.update({ where: { id: next.id }, data: { isPrimary: true } });
}

export async function createContact(partyId: string, input: ContactInput) {
  const phone = cleanPhone(input.phone);
  return prisma.$transaction(async (tx) => {
    if (!(await lockParty(tx, partyId))) throw new BusinessError('Customer tidak ditemukan.');
    const isFirst = (await tx.partyContact.count({ where: { partyId } })) === 0;
    const isPrimary = input.isPrimary ?? isFirst;
    if (isPrimary) await clearOtherPrimary(tx, partyId);
    const contact = await tx.partyContact.create({
      data: {
        partyId,
        name: input.name.trim(),
        position: input.position?.trim() || null,
        phone,
        email: input.email?.trim() || null,
        isPrimary,
        notes: input.notes?.trim() || null,
      },
    });
    await ensurePrimary(tx, partyId);
    return { contact, warning: await phoneWarning(tx, partyId, phone) };
  });
}

export async function updateContact(id: string, input: ContactInput) {
  const phone = cleanPhone(input.phone);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.partyContact.findUnique({ where: { id } });
    if (!existing) throw new BusinessError('Kontak tidak ditemukan.');
    await lockParty(tx, existing.partyId);
    if (input.isPrimary) await clearOtherPrimary(tx, existing.partyId, id);
    const contact = await tx.partyContact.update({
      where: { id },
      data: {
        name: input.name.trim(),
        position: input.position?.trim() || null,
        phone,
        email: input.email?.trim() || null,
        ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
        notes: input.notes?.trim() || null,
      },
    });
    await ensurePrimary(tx, contact.partyId);
    return { contact: await tx.partyContact.findUniqueOrThrow({ where: { id } }), warning: await phoneWarning(tx, contact.partyId, phone) };
  });
}

export async function listContacts(partyId: string, db: Db = prisma) {
  return db.partyContact.findMany({
    where: { partyId },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  });
}

/** Delete a contact; activities keep their text (contact link set null by the FK). */
export async function deleteContact(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.partyContact.findUnique({ where: { id } });
    if (!existing) return false;
    await lockParty(tx, existing.partyId);
    await tx.partyContact.delete({ where: { id } });
    await ensurePrimary(tx, existing.partyId);
    return true;
  });
}
