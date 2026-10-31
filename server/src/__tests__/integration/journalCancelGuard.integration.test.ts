/**
 * Integration test: which journals the Journal menu may cancel (audit G-7, G-3).
 *
 * Only hand-made journals in an open fiscal year are cancellable there. This guard is the second
 * layer behind the route's source-type allowlist (journalMenuSource.integration.test.ts). Closing,
 * depreciation and document-derived journals, journals in a closed year, and deposit-module
 * journals (applications and offsets, customer and supplier) must be undone from their own module;
 * deposit refunds from the refund cancel on the deposit page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { journalMenuCancelBlockReason } from '../../services/journalCancelGuard';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

let prisma: PrismaClient;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  const user = await prisma.user.findFirst({ where: { role: 'Admin', isActive: true } });
  if (!user) throw new Error('No admin user.');
  userId = user.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Runs fn in a transaction that is always rolled back. */
async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSentinel();
    }, { timeout: 20000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

async function fiscalYear(tx: Tx, isClosed: boolean) {
  const tag = Math.random().toString(36).slice(2, 8);
  return tx.fiscalYear.create({
    data: {
      name: `IT-${tag}`,
      startDate: new Date('2099-01-01'),
      endDate: new Date('2099-12-31'),
      isClosed,
    },
  });
}

async function journal(tx: Tx, fiscalYearId: string, entryNumber: string, narration = 'Jurnal manual uji') {
  return tx.journalEntry.create({
    data: {
      entryNumber, date: new Date('2099-03-01'), status: 'Submitted', narration,
      fiscalYearId, createdBy: userId,
    },
  });
}

const uniq = () => Math.random().toString(36).slice(2, 8).toUpperCase();

d('journalMenuCancelBlockReason', () => {
  it('allows a manual journal in an open fiscal year', async () => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`);
      expect(await journalMenuCancelBlockReason(tx, je.id)).toBeNull();
    });
  });

  it('blocks any journal in a closed fiscal year', async () => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, true);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`);
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/sudah ditutup/);
    });
  });

  it.each([
    ['closing journal', 'CLOSE-'],
    ['depreciation journal', 'DEP-'],
    ['goods receipt journal', 'JV-STT-'],
    ['production journal', 'JV-PR-'],
    ['sales invoice journal', 'JV-SI-'],
  ])('blocks a %s', async (_label, prefix) => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `${prefix}${uniq()}`);
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/modul asalnya/);
    });
  });

  it.each([
    'Aplikasi Uang Muka Pelanggan: PAY-1 → SI-1',
    'Aplikasi Uang Muka: PAY-2 → PI-2',
    'Offset UM Vendor: PAY-3 → PI-3',
    'Offset UM Pelanggan: PAY-5 → SI-5',
  ])('blocks deposit-module journal "%s"', async (narration) => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`, narration);
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/Uang Muka/);
    });
  });

  it('blocks a purchase-invoice price revision journal (plain JV number, no link column)', async () => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`, 'Revisi harga PI-209903-0001 (PT A): harga naik');
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/revisi harga/);
    });
  });

  it('blocks a journal linked to a stock movement even with a plain JV number', async () => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`);
      const item = await tx.inventoryItem.create({
        data: { code: `IT-JCG-ITEM-${uniq()}`, name: `Barang uji jurnal ${uniq()}`, unit: 'kg', isActive: true },
      });
      await tx.stockMovement.create({
        data: {
          movementNumber: `SM-IT-${uniq()}`, date: new Date('2099-03-01'), movementType: 'In',
          itemId: item.id, quantity: 1, unitCost: 1, totalValue: 1,
          fiscalYearId: fy.id, journalEntryId: je.id, createdById: userId,
        },
      });
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/modul lain/);
    });
  });

  it('blocks a journal linked to a customer deposit application, whatever its narration', async () => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`);
      const customer = await tx.party.create({ data: { name: `IT-JCG-Customer-${uniq()}`, partyType: 'Customer', isActive: true } });
      const account = await tx.account.findFirstOrThrow({ where: { isGroup: false, isActive: true } });
      const deposit = await tx.payment.create({
        data: {
          paymentNumber: `IT-JCG-PAY-${uniq()}`, date: new Date('2099-03-01'), partyId: customer.id, accountId: account.id,
          paymentType: 'CustomerDeposit', amount: 1, status: 'Submitted', fiscalYearId: fy.id, createdBy: userId,
        },
      });
      const invoice = await tx.salesInvoice.create({
        data: {
          invoiceNumber: `IT-JCG-SI-${uniq()}`, date: new Date('2099-03-01'), partyId: customer.id,
          grandTotal: 1, outstanding: 0, status: 'Paid', fiscalYearId: fy.id, createdBy: userId,
        },
      });
      await tx.customerDepositApplication.create({
        data: { depositPaymentId: deposit.id, salesInvoiceId: invoice.id, appliedAmount: 1, journalEntryId: je.id, createdBy: userId },
      });
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/modul lain/);
    });
  });

  it.each([
    'Refund UM Pelanggan: PAY-6 koreksi',
    'Refund UM Vendor: PAY-7 - PT C',
  ])('leaves a MANUAL journal narrated "%s" to the normal manual rules', async (narration) => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`, narration);
      await tx.journalEntry.update({ where: { id: je.id }, data: { sourceType: 'MANUAL' } });
      expect(await journalMenuCancelBlockReason(tx, je.id)).toBeNull();
    });
  });

  it.each([
    ['a customer refund by narration', 'Refund UM Pelanggan: PAY-6 - PT B', null],
    ['a supplier refund by narration', 'Refund UM Vendor: PAY-7 - PT C', null],
    ['a refund tagged DEPOSIT_REFUND', 'Pengembalian uang muka', 'DEPOSIT_REFUND'],
  ] as const)('points %s to the deposit page refund cancel', async (_label, narration, sourceType) => {
    await inRollback(async (tx) => {
      const fy = await fiscalYear(tx, false);
      const je = await journal(tx, fy.id, `JV-209903-${uniq()}`, narration);
      if (sourceType) await tx.journalEntry.update({ where: { id: je.id }, data: { sourceType } });
      expect(await journalMenuCancelBlockReason(tx, je.id)).toMatch(/Batalkan refund/);
    });
  });
});
