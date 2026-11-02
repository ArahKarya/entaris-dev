/**
 * GA bills and purchase invoice price revisions post to the mapped accounts (E5-R3, E2-R9 AP, PR-4.13b).
 *
 * With AP mapped to a detail account other than 2.1.1, a GA vehicle tax bill (purchase invoice
 * path), its payment and a later price revision all land on that account and 2.1.1 stays at 0.
 * An unmapped PURCHASE_PRICE_VARIANCE role fails the revision with ACCOUNT_MAPPING_MISSING.
 *
 * Everything runs in a rollback transaction on fixtures made here, in fiscal year 2163.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { payVehicleTaxInTx } from '../../services/gaFinance';
import { submitPaymentInTx } from '../../services/paymentSubmit';
import { revisePurchaseInvoiceInTx } from '../../services/purchaseInvoiceRevise';
import { ACCOUNT_MAPPING_MISSING } from '../../types/systemAccounts';

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
  userId = user!.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

class RollbackSentinel extends Error {
  constructor() { super('rollback'); this.name = 'RollbackSentinel'; }
}

async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      state.tx = tx;
      systemAccounts.invalidateCache();
      try {
        await fn(tx);
      } finally {
        state.tx = null;
        systemAccounts.invalidateCache();
      }
      throw new RollbackSentinel();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof RollbackSentinel)) throw e;
  }
}

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Net ledger movement (debit - credit) of an account over the whole transaction. */
async function net(tx: Tx, accountId: string): Promise<number> {
  const agg = await tx.accountingLedgerEntry.aggregate({
    where: { accountId, isCancelled: false },
    _sum: { debit: true, credit: true },
  });
  return Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
}

async function seedFixture(tx: Tx) {
  await createFiscalYear(tx, { year: 2163 });
  // The revision journal is dated now, so the current year needs an open fiscal year as well.
  const today = new Date();
  const current = await tx.fiscalYear.findFirst({
    where: { startDate: { lte: today }, endDate: { gte: today } },
  });
  if (!current) await createFiscalYear(tx, { year: today.getUTCFullYear() });

  const ap = await tx.account.create({
    data: { name: 'IT-GA Hutang Usaha Lain', accountNumber: `IT-GA-AP-${tag()}`, accountType: 'LIABILITY', rootType: 'LIABILITY' },
  });
  const expense = await tx.account.create({
    data: { name: 'IT-GA Beban', accountNumber: `IT-GA-EXP-${tag()}`, accountType: 'EXPENSE', rootType: 'EXPENSE' },
  });
  await tx.systemAccountMapping.deleteMany({ where: { role: 'AP' } });
  await tx.systemAccountMapping.create({ data: { role: 'AP', accountId: ap.id } });
  systemAccounts.invalidateCache();

  const defaultAp = await tx.account.findFirst({ where: { accountNumber: '2.1.1' } });
  const supplier = await tx.party.create({
    data: { name: `IT-GA Supplier ${tag()}`, partyType: 'Supplier', isActive: true, openingOutstanding: 0, outstandingAmount: 0 },
  });
  const branch = await tx.gaBranch.create({ data: { code: `IT-B-${tag()}`, name: 'IT branch' } });
  const category = await tx.gaAssetCategory.create({ data: { code: `IT-C-${tag()}`, name: 'IT category' } });
  const asset = await tx.gaAsset.create({
    data: { code: `IT-A-${tag()}`, name: 'B 1234 IT', categoryId: category.id, branchId: branch.id },
  });
  const tax = await tx.gaVehicleTax.create({
    data: { assetId: asset.id, type: 'PAJAK_KENDARAAN', periodYear: 2163, amount: 1_000_000, dueDate: new Date('2163-03-01') },
  });
  const cash = await tx.account.findFirst({ where: { accountNumber: { startsWith: '1.1.' }, isGroup: false } });
  return { ap, expense, defaultAp, supplier, tax, cash: cash! };
}

d('GA bills and PI revision post to mapped accounts', () => {
  it('posts the GA bill, its payment and a price revision to the mapped AP account', async () => {
    await inRollback(async (tx) => {
      const f = await seedFixture(tx);
      const defaultBefore = f.defaultAp ? await net(tx, f.defaultAp.id) : 0;

      const result = await payVehicleTaxInTx(tx, {
        kind: 'VEHICLE_TAX', id: f.tax.id, method: 'PURCHASE_INVOICE', accountId: f.expense.id,
        partyId: f.supplier.id, date: '2163-03-01', userId,
      });
      expect(result.purchaseInvoiceId).toBeTruthy();
      expect(await net(tx, f.ap.id)).toBe(-1_000_000);

      await submitPaymentInTx(
        tx,
        { date: '2163-03-02', partyId: f.supplier.id, paymentType: 'Pay', accountId: f.cash.id, amount: 1_000_000 },
        userId,
      );
      expect(await net(tx, f.ap.id)).toBe(0);
      const invoice = await tx.purchaseInvoice.findUnique({ where: { id: result.purchaseInvoiceId! }, include: { items: true } });
      expect(invoice!.status).toBe('Paid');

      // Revision: the counter entry goes to the mapped AP, the service delta to the mapped variance account.
      await revisePurchaseInvoiceInTx(
        tx,
        { invoiceId: invoice!.id, lines: [{ itemId: invoice!.items[0].id, newRate: 1_250_000 }], reason: 'Penyesuaian tarif resmi' },
        userId,
      );
      expect(await net(tx, f.ap.id)).toBe(-250_000);
      if (f.defaultAp) expect(await net(tx, f.defaultAp.id)).toBe(defaultBefore);
    });
  });

  it('fails the revision with ACCOUNT_MAPPING_MISSING when PURCHASE_PRICE_VARIANCE is unmapped', async () => {
    await inRollback(async (tx) => {
      const f = await seedFixture(tx);
      const result = await payVehicleTaxInTx(tx, {
        kind: 'VEHICLE_TAX', id: f.tax.id, method: 'PURCHASE_INVOICE', accountId: f.expense.id,
        partyId: f.supplier.id, date: '2163-03-01', userId,
      });
      const invoice = await tx.purchaseInvoice.findUnique({ where: { id: result.purchaseInvoiceId! }, include: { items: true } });
      await tx.systemAccountMapping.deleteMany({ where: { role: 'PURCHASE_PRICE_VARIANCE' } });

      await expect(
        revisePurchaseInvoiceInTx(
          tx,
          { invoiceId: invoice!.id, lines: [{ itemId: invoice!.items[0].id, newRate: 1_250_000 }], reason: 'Penyesuaian tarif resmi' },
          userId,
        ),
      ).rejects.toMatchObject({ code: ACCOUNT_MAPPING_MISSING });
    });
  });

  it('refuses a GA service bill when AP is unmapped instead of falling back to 2.1.1', async () => {
    await inRollback(async (tx) => {
      const f = await seedFixture(tx);
      await tx.systemAccountMapping.deleteMany({ where: { role: 'AP' } });
      await expect(
        payVehicleTaxInTx(tx, {
          kind: 'VEHICLE_TAX', id: f.tax.id, method: 'PURCHASE_INVOICE', accountId: f.expense.id,
          partyId: f.supplier.id, date: '2163-03-01', userId,
        }),
      ).rejects.toMatchObject({ code: ACCOUNT_MAPPING_MISSING });
    });
  });

  it('pays a GA bill from the mapped CASH account when no source account is given', async () => {
    await inRollback(async (tx) => {
      const f = await seedFixture(tx);
      await tx.systemAccountMapping.deleteMany({ where: { role: 'CASH' } });
      await tx.systemAccountMapping.create({ data: { role: 'CASH', accountId: f.cash.id } });
      const cashBefore = await net(tx, f.cash.id);
      const result = await payVehicleTaxInTx(tx, {
        kind: 'VEHICLE_TAX', id: f.tax.id, method: 'JOURNAL', accountId: f.expense.id, date: '2163-03-01', userId,
      });
      expect(result.creditAccountId).toBe(f.cash.id);
      expect((await net(tx, f.cash.id)) - cashBefore).toBe(-1_000_000);
    });
  });
});
