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

/** Only one primary contact per Customer: setting one clears the others. */
async function clearOtherPrimary(tx: Prisma.TransactionClient, partyId: string, keepId: string): Promise<void> {
  await tx.partyContact.updateMany({ where: { partyId, id: { not: keepId }, isPrimary: true }, data: { isPrimary: false } });
}

export async function createContact(partyId: string, input: ContactInput) {
  const phone = cleanPhone(input.phone);
  return prisma.$transaction(async (tx) => {
    const party = await tx.party.findUnique({ where: { id: partyId }, select: { id: true } });
    if (!party) throw new BusinessError('Customer tidak ditemukan.');
    const isFirst = (await tx.partyContact.count({ where: { partyId } })) === 0;
    const contact = await tx.partyContact.create({
      data: {
        partyId,
        name: input.name.trim(),
        position: input.position?.trim() || null,
        phone,
        email: input.email?.trim() || null,
        isPrimary: input.isPrimary ?? isFirst,
        notes: input.notes?.trim() || null,
      },
    });
    if (contact.isPrimary) await clearOtherPrimary(tx, partyId, contact.id);
    return { contact, warning: await phoneWarning(tx, partyId, phone) };
  });
}

export async function updateContact(id: string, input: ContactInput) {
  const phone = cleanPhone(input.phone);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.partyContact.findUnique({ where: { id } });
    if (!existing) throw new BusinessError('Kontak tidak ditemukan.');
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
    if (contact.isPrimary) await clearOtherPrimary(tx, contact.partyId, contact.id);
    return { contact, warning: await phoneWarning(tx, contact.partyId, phone) };
  });
}

export async function listContacts(partyId: string, db: Db = prisma) {
  return db.partyContact.findMany({
    where: { partyId },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  });
}
