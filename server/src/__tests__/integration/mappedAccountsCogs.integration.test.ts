/**
 * COGS, sales returns and the production conversion post to the mapped accounts (E2-R9, PR-4.13a).
 *
 * - COGS mapped to a fixture account and HPP Beras (5.1) inactive: the sales invoice COGS journal
 *   debits the mapped account, never 5.1; the sales return reversal credits it.
 * - SALES_RETURN mapped to a fixture account: the return debits it, not 4.3.
 * - PRODUCTION_CONVERSION unmapped and a production gain: ACCOUNT_MAPPING_MISSING.
 * - A database still mapping PRODUCTION_CONVERSION to 6.39: the loose SQL moves it to 5.12 once
 *   (second run changes nothing), a mapping the accountant chose is left alone, and the conversion
 *   cost is then credited to 5.12 by a production run.
 *
 * Everything runs in a rollback transaction on fixtures made here, in fiscal year 2164.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { txPrismaProxy, type Tx } from '../helpers/routeHarness';
import { createFiscalYear } from '../helpers/periodFixture';

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock('../../lib/prisma', () => ({ prisma: txPrismaProxy(state) }));

import { systemAccounts } from '../../services/systemAccounts';
import { submitDeliveryOrderInTx } from '../../services/deliveryOrderSubmit';
import { submitSalesInvoiceInTx } from '../../services/salesInvoiceSubmit';
import { submitSalesReturnInTx } from '../../services/salesReturnSubmit';
import { submitProductionRunInTx } from '../../services/productionRunSubmit';
import { ACCOUNT_MAPPING_MISSING } from '../../types/systemAccounts';
import { ACCOUNT_GROUP, ACCOUNT_INACTIVE } from '../../services/ledger/accountGuard';
import { BusinessError } from '../../utils/errors';
import { seedStock } from '../helpers/inventoryFixture';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const Y = 2164;
const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../prisma/migrations/2026110800000_production_conversion_mapping.sql'),
  'utf8',
);

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
        await createFiscalYear(tx, { year: Y });
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

async function fixtureAccount(tx: Tx, label: string, type: 'EXPENSE' | 'REVENUE') {
  return tx.account.create({
    data: { name: `IT-4.13a ${label}`, accountNumber: `IT-413A-${label}-${tag()}`, accountType: type, rootType: type },
  });
}

async function mapRole(tx: Tx, role: string, accountId: string | null) {
  await tx.systemAccountMapping.deleteMany({ where: { role } });
  if (accountId) await tx.systemAccountMapping.create({ data: { role, accountId } });
  systemAccounts.invalidateCache();
}

async function warehouse(tx: Tx) {
  return tx.warehouse.create({ data: { code: `IT-W-${tag()}`, name: 'IT-4.13a warehouse' } as any });
}

async function stockedItem(tx: Tx, warehouseId: string, stock: number, cost: number, label: string) {
  const item = await tx.inventoryItem.create({
    data: { code: `IT-413A-${label}-${tag()}`, name: `IT-4.13a ${label}`, unit: 'kg', isActive: true },
  });
  if (stock > 0) await seedStock(tx, { itemId: item.id, warehouseId, qty: stock, avg: cost, date: `${Y}-01-02` });
  return item;
}

/** Debit and credit of one journal entry on one account. */
async function lineOn(tx: Tx, entryNumber: string, accountId: string) {
  const je = await tx.journalEntry.findUniqueOrThrow({ where: { entryNumber }, include: { items: true } });
  const rows = je.items.filter((i) => i.accountId === accountId);
  return {
    debit: rows.reduce((s, r) => s + Number(r.debit), 0),
    credit: rows.reduce((s, r) => s + Number(r.credit), 0),
    accountIds: je.items.map((i) => i.accountId),
  };
}

/** Delivered-and-invoiced product sale: 8 kg at a locked cost of 10.000.000 = HPP 80.000.000. */
async function soldInvoice(tx: Tx) {
  const wh = await warehouse(tx);
  const customer = await tx.party.create({ data: { name: `IT-4.13a Customer ${tag()}`, partyType: 'Customer', isActive: true } });
  const item = await stockedItem(tx, wh.id, 20, 10_000_000, 'FG');
  const date = `${Y}-03-01`;
  const delivery = await submitDeliveryOrderInTx(
    tx,
    { date, partyId: customer.id, items: [{ inventoryItemId: item.id, warehouseId: wh.id, itemName: item.name, quantity: 8, unit: 'kg' }] } as any,
    userId,
  );
  const invoice = await submitSalesInvoiceInTx(
    tx,
    {
      date,
      partyId: customer.id,
      items: [{
        itemName: item.name, itemType: 'product', inventoryItemId: item.id, warehouseId: wh.id,
        deliveryOrderItemId: delivery.items[0].id, quantity: 8, unit: 'kg', rate: 15_000_000,
      }],
    } as any,
    userId,
  );
  return { invoice, item, wh };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BusinessError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

/** 60 kg in at 10.000, 60 kg out at 20.000 with a 30.000 fixed conversion cost: a gain well over it. */
async function gainRun(tx: Tx) {
  const wh = await warehouse(tx);
  const input = await stockedItem(tx, wh.id, 100, 10_000, 'IN');
  const output = await stockedItem(tx, wh.id, 0, 0, 'OUT');
  return submitProductionRunInTx(
    tx,
    {
      date: `${Y}-03-05`,
      warehouseId: wh.id,
      inputs: [{ itemId: input.id, quantity: 60 }],
      outputs: [{ itemId: output.id, quantity: 60, unitPrice: 20_000 }],
      costs: [{ description: 'IT conversion', costSide: 'InputSide', basis: 'Fixed', rate: 30_000 }],
    } as any,
    userId,
  );
}

d('COGS and sales return post to mapped accounts', () => {
  it('debits the account mapped to COGS and leaves HPP Beras (5.1) alone', async () => {
    await inRollback(async (tx) => {
      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      await mapRole(tx, 'COGS', cogs.id);
      const hpp = await tx.account.findFirst({ where: { accountNumber: '5.1' } });
      if (hpp) await tx.account.update({ where: { id: hpp.id }, data: { isActive: false } });

      const { invoice } = await soldInvoice(tx);
      const line = await lineOn(tx, `JV-COGS-${invoice.invoiceNumber}`, cogs.id);
      expect(line.debit).toBe(80_000_000);
      if (hpp) expect(line.accountIds).not.toContain(hpp.id);
    });
  });

  it('fails the invoice with ACCOUNT_MAPPING_MISSING when COGS is unmapped', async () => {
    await inRollback(async (tx) => {
      await mapRole(tx, 'COGS', null);
      const customer = await tx.party.create({ data: { name: `IT-4.13a Customer ${tag()}`, partyType: 'Customer', isActive: true } });
      const code = await codeOf(
        submitSalesInvoiceInTx(
          tx,
          { date: `${Y}-03-01`, partyId: customer.id, items: [{ itemName: 'jasa', itemType: 'service', quantity: 1, rate: 1_000 }] } as any,
          userId,
        ),
      );
      expect(code).toBe(ACCOUNT_MAPPING_MISSING);
    });
  });

  it.each([
    ['a group account', { isGroup: true }, ACCOUNT_GROUP],
    ['an inactive account', { isActive: false }, ACCOUNT_INACTIVE],
  ])('rejects the invoice when COGS is mapped to %s', async (_label, patch, expected) => {
    await inRollback(async (tx) => {
      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      await tx.account.update({ where: { id: cogs.id }, data: patch });
      await mapRole(tx, 'COGS', cogs.id);
      const customer = await tx.party.create({ data: { name: `IT-4.13a Customer ${tag()}`, partyType: 'Customer', isActive: true } });
      const code = await codeOf(
        submitSalesInvoiceInTx(
          tx,
          { date: `${Y}-03-01`, partyId: customer.id, items: [{ itemName: 'jasa', itemType: 'service', quantity: 1, rate: 1_000 }] } as any,
          userId,
        ),
      );
      expect(code).toBe(expected);
    });
  });

  it('debits the account mapped to SALES_RETURN and credits the mapped COGS on the reversal', async () => {
    await inRollback(async (tx) => {
      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      const ret = await fixtureAccount(tx, 'RET', 'REVENUE');
      await mapRole(tx, 'COGS', cogs.id);
      await mapRole(tx, 'SALES_RETURN', ret.id);
      const old = await tx.account.findFirst({ where: { accountNumber: '4.3' } });

      const { invoice, wh } = await soldInvoice(tx);
      const src = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      const salesReturn = await submitSalesReturnInTx(
        tx,
        {
          salesInvoiceId: invoice.id, date: `${Y}-03-10`,
          items: [{ salesInvoiceItemId: src.id, quantity: 2, restock: true, warehouseId: wh.id }],
        } as any,
        userId,
      );
      const entry = await tx.journalEntry.findFirstOrThrow({
        where: { items: { some: { accountId: ret.id } }, entryNumber: { contains: salesReturn!.returnNumber } },
        include: { items: true },
      });
      const retLine = entry.items.filter((i) => i.accountId === ret.id);
      expect(retLine.reduce((s, r) => s + Number(r.debit), 0)).toBe(30_000_000);
      if (old) expect(entry.items.map((i) => i.accountId)).not.toContain(old.id);

      const entries = await tx.journalEntry.findMany({
        where: { entryNumber: { contains: salesReturn!.returnNumber } },
        include: { items: true },
      });
      const cogsRows = entries.flatMap((e) => e.items).filter((i) => i.accountId === cogs.id);
      expect(cogsRows.reduce((s, r) => s + Number(r.credit), 0)).toBe(20_000_000);
    });
  });

  it('fails the return with ACCOUNT_MAPPING_MISSING when SALES_RETURN is unmapped', async () => {
    await inRollback(async (tx) => {
      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      await mapRole(tx, 'COGS', cogs.id);
      const { invoice } = await soldInvoice(tx);
      await mapRole(tx, 'SALES_RETURN', null);
      const src = await tx.salesInvoiceItem.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } });
      const code = await codeOf(
        submitSalesReturnInTx(
          tx,
          { salesInvoiceId: invoice.id, date: `${Y}-03-10`, items: [{ salesInvoiceItemId: src.id, quantity: 1, restock: false }] } as any,
          userId,
        ),
      );
      expect(code).toBe(ACCOUNT_MAPPING_MISSING);
    });
  });
});

d('production conversion posts to the mapped account', () => {
  it('fails with ACCOUNT_MAPPING_MISSING for a gain when PRODUCTION_CONVERSION is unmapped', async () => {
    await inRollback(async (tx) => {
      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      await mapRole(tx, 'COGS', cogs.id);
      await mapRole(tx, 'PRODUCTION_CONVERSION', null);
      expect(await codeOf(gainRun(tx))).toBe(ACCOUNT_MAPPING_MISSING);
    });
  });

  it('credits the conversion cost to the mapped account and the rest to COGS', async () => {
    await inRollback(async (tx) => {
      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      const conv = await fixtureAccount(tx, 'CONV', 'EXPENSE');
      await mapRole(tx, 'COGS', cogs.id);
      await mapRole(tx, 'PRODUCTION_CONVERSION', conv.id);
      const run = await gainRun(tx);
      const convLine = await lineOn(tx, `JV-${run!.runNumber}`, conv.id);
      expect(convLine.credit).toBe(30_000);
      expect(convLine.debit).toBe(0);
      const cogsLine = await lineOn(tx, `JV-${run!.runNumber}`, cogs.id);
      expect(cogsLine.credit).toBeGreaterThan(0);
    });
  });
});

d('production_conversion_mapping loose SQL', () => {
  async function ensureAccount(tx: Tx, accountNumber: string) {
    const found = await tx.account.findFirst({ where: { accountNumber } });
    if (found) return found;
    return tx.account.create({ data: { name: `IT-4.13a ${accountNumber}`, accountNumber, accountType: 'EXPENSE', rootType: 'EXPENSE' } });
  }
  const mappedNumbers = async (tx: Tx) =>
    (await tx.systemAccountMapping.findMany({ where: { role: 'PRODUCTION_CONVERSION' }, include: { account: true } }))
      .map((m) => m.account.accountNumber);

  it('moves a legacy 6.39 mapping to 5.12 once and a second run changes nothing', async () => {
    await inRollback(async (tx) => {
      const target = await ensureAccount(tx, '5.12');
      await tx.account.update({ where: { id: target.id }, data: { isGroup: false, isActive: true, rootType: 'EXPENSE' } });
      const legacy = await ensureAccount(tx, '6.39');
      await mapRole(tx, 'PRODUCTION_CONVERSION', legacy.id);

      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mappedNumbers(tx)).toEqual(['5.12']);
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mappedNumbers(tx)).toEqual(['5.12']);

      const cogs = await fixtureAccount(tx, 'COGS', 'EXPENSE');
      await mapRole(tx, 'COGS', cogs.id);
      const run = await gainRun(tx);
      const line = await lineOn(tx, `JV-${run!.runNumber}`, target.id);
      expect(line.credit).toBe(30_000);
      expect(line.accountIds).not.toContain(legacy.id);
    });
  });

  it('maps an unmapped role to 5.12', async () => {
    await inRollback(async (tx) => {
      const target = await ensureAccount(tx, '5.12');
      await tx.account.update({ where: { id: target.id }, data: { isGroup: false, isActive: true, rootType: 'EXPENSE' } });
      await mapRole(tx, 'PRODUCTION_CONVERSION', null);
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mappedNumbers(tx)).toEqual(['5.12']);
    });
  });

  it('leaves a mapping the accountant chose untouched', async () => {
    await inRollback(async (tx) => {
      const target = await ensureAccount(tx, '5.12');
      await tx.account.update({ where: { id: target.id }, data: { isGroup: false, isActive: true, rootType: 'EXPENSE' } });
      const chosen = await fixtureAccount(tx, 'CHOSEN', 'EXPENSE');
      await mapRole(tx, 'PRODUCTION_CONVERSION', chosen.id);
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mappedNumbers(tx)).toEqual([chosen.accountNumber]);
    });
  });

  it('does nothing when 5.12 is inactive', async () => {
    await inRollback(async (tx) => {
      const target = await ensureAccount(tx, '5.12');
      await tx.account.update({ where: { id: target.id }, data: { isActive: false } });
      const legacy = await ensureAccount(tx, '6.39');
      await mapRole(tx, 'PRODUCTION_CONVERSION', legacy.id);
      await tx.$executeRawUnsafe(MIGRATION_SQL);
      expect(await mappedNumbers(tx)).toEqual(['6.39']);
    });
  });
});
