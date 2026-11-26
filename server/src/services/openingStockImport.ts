import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { updateBalancesForItems } from '../utils/accountBalance';
import { generateDocumentNumber } from '../utils/documentNumber';
import { getOpenFiscalYear } from '../utils/fiscalYear';
import { BusinessError } from '../utils/errors';
import { resolveWarehouseId } from '../utils/warehouseStock';
import { systemAccounts } from './systemAccounts';
import { lockInventoryRows } from './inventory/stockLocks';
import { postInbound } from './inventory/inventoryLedger';
import { VALUE_DP } from './inventory/inventoryValueMath';

type Tx = Prisma.TransactionClient;

/** The imported item; its stock, average and account are read again under the row lock. */
export interface OpeningStockItem {
  id: string;
  code: string;
}

export interface OpeningStockInput {
  item: OpeningStockItem;
  quantity: number;
  /** The file's unit price; the row stores totalValue / quantity (the ledger's one definition). */
  unitCost: number;
  /** Booked at 2 dp: the journal and the ledger take the same amount. */
  totalValue: number;
  /** Optional warehouse code from the import file; the default warehouse is used when empty. */
  warehouseCode?: string;
  userId: string;
  now?: Date;
}

/** Resolve the import row's warehouse: explicit code first, else the default warehouse. */
async function resolveImportWarehouseId(tx: Tx, warehouseCode?: string): Promise<string> {
  if (warehouseCode) {
    const wh = await tx.warehouse.findUnique({ where: { code: warehouseCode }, select: { id: true } });
    if (!wh) throw new BusinessError(`Gudang dengan kode "${warehouseCode}" tidak ditemukan.`);
    return wh.id;
  }
  const id = await resolveWarehouseId(tx, null);
  if (!id) {
    throw new BusinessError('Gudang belum ditentukan: isi kolom warehouseCode atau set salah satu gudang sebagai default.');
  }
  return id;
}

/**
 * Post an imported opening stock balance: GL DR Persediaan / CR Ekuitas Saldo Awal, then an In
 * movement through the value ledger (postInbound) at the same amount, linked to that journal
 * (warehouse, counter account and journal stored). An item whose inventory account is gone is
 * refused: its value would have no journal.
 */
export async function postOpeningStockInTx(tx: Tx, input: OpeningStockInput) {
  const { quantity, totalValue, userId } = input;
  const now = input.now ?? new Date();
  const fiscalYear = await getOpenFiscalYear(tx, now);
  const warehouseId = await resolveImportWarehouseId(tx, input.warehouseCode);

  // Lock the item and its row at the warehouse before the JV/SM numbers and the account locks
  // (lock order in services/inventory/stockLocks.ts). The route upserted the item outside this
  // transaction, so its stock, average and account are taken from the locked row, not that read.
  const locked = await lockInventoryRows(tx, { itemIds: [input.item.id], pairs: [{ itemId: input.item.id, warehouseId }] });
  const lockedItem = locked.items.get(input.item.id);
  if (!lockedItem) throw new BusinessError('Item stok tidak ditemukan.');
  const item = { ...lockedItem, code: input.item.code };

  // GL: DR Inventory / CR Ekuitas Saldo Awal, of the amount the ledger books (2 dp), so book = GL.
  // The account must exist: value without its journal would leave the book above the GL.
  const value = new Decimal(totalValue).toDecimalPlaces(VALUE_DP);
  const invAccount = item.accountId
    ? await tx.account.findUnique({ where: { id: item.accountId } })
    : await systemAccounts.getAccount('INVENTORY');
  if (!invAccount) throw new BusinessError(`Akun persediaan item '${item.code}' tidak ditemukan.`);
  const openingEquity = await systemAccounts.getAccount('OPENING_EQUITY');

  const description = `Saldo awal stok: ${item.code}`;
  const jvNumber = await generateDocumentNumber(tx, 'JV', now, fiscalYear.id);
  const mvNumber = await generateDocumentNumber(tx, 'SM', now, fiscalYear.id);
  const journal = await tx.journalEntry.create({
    data: {
      entryNumber: jvNumber,
      date: now,
      narration: `Saldo awal stok: ${item.code} - ${item.name}`,
      status: 'Submitted',
      fiscalYearId: fiscalYear.id,
      createdBy: userId,
      submittedAt: now,
      sourceType: 'OPENING',
      items: {
        create: [
          { accountId: invAccount.id, debit: value.toNumber(), credit: 0, description },
          { accountId: openingEquity.id, debit: 0, credit: value.toNumber(), description },
        ],
      },
    },
    include: { items: true },
  });

  await tx.accountingLedgerEntry.createMany({
    data: journal.items.map((ji) => ({
      date: now,
      accountId: ji.accountId,
      debit: ji.debit,
      credit: ji.credit,
      referenceType: 'JournalEntry' as const,
      referenceId: journal.id,
      description: ji.description || description,
      fiscalYearId: fiscalYear.id,
    })),
  });

  await updateBalancesForItems(
    tx,
    journal.items.map((i) => ({ accountId: i.accountId, debit: Number(i.debit), credit: Number(i.credit) })),
  );
  const journalEntryId = journal.id;

  // The In row through the value ledger: stock, warehouse row, book value and average together.
  const { movement } = await postInbound(tx, {
    movementType: 'In',
    movementNumber: mvNumber,
    itemId: item.id,
    warehouseId,
    quantity,
    value,
    date: now,
    referenceType: 'OpeningBalance',
    offsetAccountId: openingEquity.id,
    journalEntryId,
    notes: `Stok awal dari import: ${item.code} - ${item.name}`,
    createdById: userId,
    fiscalYearId: fiscalYear.id,
  });

  return { movementId: movement.id, journalEntryId, warehouseId };
}
