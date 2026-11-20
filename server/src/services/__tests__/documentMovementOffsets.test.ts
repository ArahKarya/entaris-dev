/**
 * Document-generated stock movements store the counter account ("akun lawan")
 * their own journal (or the invoice's COGS journal for DO) posts against.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../utils/documentNumber', () => ({ generateDocumentNumber: vi.fn(async (_tx, prefix: string) => `${prefix}-202610-0001`) }));
vi.mock('../../utils/accountBalance', () => ({
  updateAccountBalance: vi.fn(async () => undefined),
  recalcPartyOutstanding: vi.fn(async () => undefined),
}));
vi.mock('../../utils/fiscalYear', () => ({ getOpenFiscalYear: vi.fn(async () => ({ id: 'fy-2026' })) }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const ACCOUNTS: Record<string, string> = {
  INVENTORY: 'acc-inv',
  ACCRUED_PAYABLE: 'acc-2.1.5',
  AR: 'acc-ar',
  CUSTOMER_DEPOSIT: 'acc-dep',
  COGS: 'acc-cogs',
  TAX_OUTPUT: 'acc-ppn',
};
vi.mock('../systemAccounts', () => ({
  systemAccounts: {
    getAccount: vi.fn(async (role: string) => ({ id: ACCOUNTS[role] })),
    getAccounts: vi.fn(async (role: string) => [{ id: ACCOUNTS[role] }]),
  },
  mappedAccount: vi.fn(async (_tx: unknown, role: string) => ({ id: `acc-${role}`, accountNumber: role, name: role })),
}));
vi.mock('../temporaryDeliveryNote', () => ({ linkTemporaryNotesToDoInTx: vi.fn(async () => undefined) }));
vi.mock('../salesOrderDelivery', () => ({
  recomputeDeliveredQtyInTx: vi.fn(async () => undefined),
  relinkDoItemsToSOInTx: vi.fn(async () => undefined),
}));

import { submitGoodsReceiptInTx } from '../goodsReceiptSubmit';
import { submitDeliveryOrderInTx } from '../deliveryOrderSubmit';
import { editDeliveryOrderInTx, DELIVERY_ORDER_MONTH_CHANGE } from '../deliveryOrderEdit';
import { submitSalesReturnInTx } from '../salesReturnSubmit';
import { makeAutoTx } from '../../__tests__/helpers/autoTx';

const movementData = (fn: ReturnType<typeof makeAutoTx>['fn']) =>
  fn('stockMovement.create').mock.calls.map((c) => c[0].data);

beforeEach(() => vi.clearAllMocks());

describe('goods receipt movements', () => {
  const grTx = (averageCost: string) =>
    makeAutoTx({
      'party.findUnique': () => ({ id: 'sup', name: 'Supplier', isActive: true, partyType: 'Supplier' }),
      'inventoryItem.findUnique': () => ({ id: 'i1', name: 'GKP', isActive: true, accountId: null, averageCost, currentStock: '0' }),
      'warehouse.findUnique': () => ({ id: 'wh-1' }),
    });
  const body = (extra: object = {}) => ({
    date: '2026-10-10',
    partyId: 'sup',
    items: [{ inventoryItemId: 'i1', warehouseId: 'wh-1', itemName: 'GKP', quantity: 10, unit: 'Kg', lockedUnitCost: 5000 }],
    ...extra,
  });

  it('stores Hutang Belum Tagih as the counter account', async () => {
    const { tx, fn } = grTx('0');
    await submitGoodsReceiptInTx(tx, body(), 'u1');
    expect(movementData(fn)[0]).toMatchObject({ referenceType: 'GoodsReceipt', offsetAccountId: 'acc-2.1.5', totalValue: 50000 });
    const je = fn('journalEntry.create').mock.calls[0]![0].data.items.create;
    expect(je.find((l: any) => l.credit > 0).accountId).toBe('acc-2.1.5');
  });

  it('leaves it empty for customer-owned goods (no journal)', async () => {
    const { tx, fn } = grTx('0');
    await submitGoodsReceiptInTx(tx, body({ isCustomerOwned: true }), 'u1');
    expect(movementData(fn)[0]).toMatchObject({ totalValue: 0, offsetAccountId: null });
    expect(fn('journalEntry.create')).not.toHaveBeenCalled();
  });
});

describe('delivery order movements', () => {
  const doHandlers = () => ({
    'party.findUnique': () => ({ id: 'cust', name: 'Cust', isActive: true, partyType: 'Customer' }),
    // lockInventoryRows reads the items back after locking them; the average comes from here.
    'inventoryItem.findMany': () => [{ id: 'i1', name: 'Beras', unit: 'Kg', isActive: true, accountId: null, currentStock: '100', averageCost: '9000' }],
    'inventoryItem.findUnique': () => ({ id: 'i1', name: 'Beras', unit: 'Kg', averageCost: '9000' }),
    'warehouse.findMany': () => [{ id: 'wh-1', name: 'Gudang' }],
    'inventoryStock.findMany': () => [{ itemId: 'i1', warehouseId: 'wh-1', currentStock: '100' }],
    'inventoryStock.findUnique': () => ({ currentStock: '100' }),
    'deliveryOrder.findUniqueOrThrow': () => ({ id: 'do-1', items: [] }),
    'deliveryOrder.findUnique': () => ({
      id: 'do-1', doNumber: 'DO-1', status: 'Submitted', invoiceId: null, items: [],
      date: new Date('2026-10-03'), fiscalYearId: 'fy-2026',
    }),
    'fiscalYear.findFirst': () => ({ id: 'fy-2026', name: '2026', isClosed: false }),
    // assertPeriodOpen's FOR SHARE read of the fiscal-year row.
    $queryRaw: () => [{ is_closed: false }],
  });
  const body = {
    date: '2026-10-10',
    partyId: 'cust',
    items: [{ inventoryItemId: 'i1', warehouseId: 'wh-1', itemName: 'Beras', quantity: 2, unit: 'Kg' }],
  };

  it('submit stores the COGS account the invoice will debit (the mapped one)', async () => {
    const { tx, fn } = makeAutoTx(doHandlers());
    await submitDeliveryOrderInTx(tx, body, 'u1');
    expect(movementData(fn)[0]).toMatchObject({ referenceType: 'DeliveryOrder', movementType: 'Out', offsetAccountId: 'acc-cogs' });
  });

  it('edit stores it on the re-created movements', async () => {
    const { tx, fn } = makeAutoTx(doHandlers());
    await editDeliveryOrderInTx(tx, 'do-1', body, 'u1');
    expect(movementData(fn)[0]).toMatchObject({ referenceType: 'DeliveryOrder', offsetAccountId: 'acc-cogs' });
  });

  it('edit moves the header fiscal year with the date', async () => {
    const { tx, fn } = makeAutoTx(doHandlers());
    await editDeliveryOrderInTx(tx, 'do-1', body, 'u1');
    expect(fn('deliveryOrder.update').mock.calls[0]![0].data).toMatchObject({ date: new Date('2026-10-10'), fiscalYearId: 'fy-2026' });
  });

  it('edit rejects moving the note to another month, before touching stock', async () => {
    const { tx, fn } = makeAutoTx(doHandlers());
    await expect(editDeliveryOrderInTx(tx, 'do-1', { ...body, date: '2026-11-02' }, 'u1')).rejects.toMatchObject({
      code: DELIVERY_ORDER_MONTH_CHANGE,
    });
    expect(fn('stockMovement.update')).not.toHaveBeenCalled();
    expect(fn('deliveryOrder.update')).not.toHaveBeenCalled();
  });

  it('edit rejects a note whose date is in a closed fiscal year', async () => {
    const { tx, fn } = makeAutoTx({ ...doHandlers(), $queryRaw: () => [{ is_closed: true }] });
    await expect(editDeliveryOrderInTx(tx, 'do-1', body, 'u1')).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(fn('deliveryOrderItem.deleteMany')).not.toHaveBeenCalled();
  });

  it('no counter account for a zero-value line', async () => {
    const h = doHandlers();
    const { tx, fn } = makeAutoTx({
      ...h,
      'inventoryItem.findMany': () => [{ id: 'i1', name: 'Beras', unit: 'Kg', isActive: true, accountId: null, currentStock: '100', averageCost: '0' }],
    });
    await submitDeliveryOrderInTx(tx, body, 'u1');
    expect(movementData(fn)[0]?.offsetAccountId).toBeNull();
  });
});

describe('sales return restock movements', () => {
  it('stores the mapped COGS account the COGS reversal journal credits', async () => {
    const { tx, fn } = makeAutoTx({
      'salesInvoice.findUnique': () => ({
        id: 'si-1',
        invoiceNumber: 'SI-1',
        partyId: 'cust',
        status: 'Submitted',
        outstanding: '100000',
        grandTotal: '100000',
        customer: { name: 'Cust' },
        items: [
          {
            id: 'sii-1',
            itemName: 'Beras',
            quantity: '5',
            discount: '0',
            rate: '10000',
            taxPct: '0',
            unit: 'Kg',
            accountId: 'acc-4.1',
            warehouseId: 'wh-1',
            inventoryItemId: 'i1',
            unitCostLoaded: '7000',
            deliveryOrderItem: null,
            inventoryItem: { id: 'i1', name: 'Beras', accountId: null, averageCost: '7000', isActive: true },
          },
        ],
      }),
      'account.findUnique': ({ where }) => ({ id: where.id, accountNumber: where.id, name: where.id, rootType: 'EXPENSE', isGroup: false, isActive: true }),
      'journalEntry.create': ({ data }) => ({ id: `je-${data.entryNumber}` }),
    });
    await submitSalesReturnInTx(tx, { salesInvoiceId: 'si-1', date: '2026-10-10', items: [{ salesInvoiceItemId: 'sii-1', quantity: 2 }] }, 'u1');

    expect(movementData(fn)[0]).toMatchObject({ referenceType: 'SalesReturn', totalValue: 14000, offsetAccountId: 'acc-COGS' });
    const cogsJe = fn('journalEntry.create').mock.calls.map((c) => c[0].data).find((d) => d.entryNumber.startsWith('JV-COGS-'));
    expect(cogsJe.items.create.find((l: any) => l.credit > 0).accountId).toBe('acc-COGS');
  });
});
