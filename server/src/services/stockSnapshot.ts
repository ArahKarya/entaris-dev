// Per-warehouse stock as of the end of a date. The quantity comes from the one as-of walk in
// services/inventory/stockAsOf.ts (live inventory_stocks minus the active movements after the
// business day, WIB). Value uses the item's current averageCost (no running cost per movement), so
// far-past dates are approximate; see `valuationNote`.

import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { UNIT_COST_DP } from './inventory/inventoryValueMath';
import { qtyAsOfByWarehouse } from './inventory/stockAsOf';
import { stockKey } from './inventory/stockLocks';
import { businessDayOf } from '../utils/businessDate';

export interface SnapshotItem {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  category: string | null;  // klasifikasi: Bahan Baku / Produk Jadi / dll
  qty: number;          // stock as-of end-of-date (exact)
  averageCost: number;  // current avg cost (see valuation note)
  value: number;        // qty * averageCost
}

export interface SnapshotWarehouse {
  warehouseId: string;
  code: string;
  name: string;
  location: string | null;
  isDefault: boolean;
  items: SnapshotItem[];   // only non-zero qty, sorted desc by qty
  totalValue: number;
  itemCount: number;
}

export interface StockSnapshot {
  asOfDate: string;        // YYYY-MM-DD
  warehouses: SnapshotWarehouse[];
  grandTotalValue: number;
  valuationNote: string;
}

/**
 * Build a per-warehouse stock snapshot as of the end of `dateStr` (YYYY-MM-DD).
 * @param dateStr - target date (inclusive, end-of-day)
 * @param warehouseIds - optional filter; when omitted, all active warehouses
 */
export async function buildStockSnapshot(
  dateStr: string,
  warehouseIds?: string[],
): Promise<StockSnapshot> {
  // A full timestamp is read as the business day it falls on.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : businessDayOf(new Date(dateStr));

  const warehouses = await prisma.warehouse.findMany({
    where: warehouseIds && warehouseIds.length > 0
      ? { id: { in: warehouseIds } }
      : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  if (warehouses.length === 0) {
    return { asOfDate: dateStr, warehouses: [], grandTotalValue: 0, valuationNote: NOTE };
  }

  // Also covers an item with no live row but movements after the day (fully consumed since).
  const qtyMap = await qtyAsOfByWarehouse(prisma, { warehouseIds: warehouses.map((w) => w.id), day });
  const itemIds = [...new Set([...qtyMap.entries()].filter(([, q]) => !q.isZero()).map(([k]) => k.split('::')[0]!))];
  const items = itemIds.length === 0 ? [] : await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, code: true, name: true, unit: true, averageCost: true, category: true },
  });
  const itemMap = new Map(items.map((it) => [it.id, {
    ...it, category: it.category ?? null, averageCost: new Decimal((it.averageCost ?? 0).toString()),
  }]));

  const result: SnapshotWarehouse[] = warehouses.map((w) => {
    const whItems: SnapshotItem[] = [];
    for (const meta of itemMap.values()) {
      const qtyDec = qtyMap.get(stockKey(meta.id, w.id));
      if (!qtyDec || qtyDec.isZero()) continue;
      const itemId = meta.id;
      const avg = meta.averageCost;
      const qty = qtyDec.toDecimalPlaces(3).toNumber();
      whItems.push({
        itemId,
        code: meta.code,
        name: meta.name,
        unit: meta.unit,
        category: meta.category,
        qty,
        averageCost: avg.toDecimalPlaces(UNIT_COST_DP).toNumber(),
        value: qtyDec.mul(avg).toDecimalPlaces(2).toNumber(),
      });
    }
    whItems.sort((a, b) => b.qty - a.qty);
    const totalValue = whItems.reduce((s, it) => s + it.value, 0);
    return {
      warehouseId: w.id,
      code: w.code,
      name: w.name,
      location: w.location,
      isDefault: w.isDefault,
      items: whItems,
      totalValue,
      itemCount: whItems.length,
    };
  });

  return {
    asOfDate: dateStr,
    warehouses: result,
    grandTotalValue: result.reduce((s, w) => s + w.totalValue, 0),
    valuationNote: NOTE,
  };
}

const NOTE =
  'Kuantitas dihitung tepat dari riwayat pergerakan stok per tanggal. ' +
  'Nilai memakai harga rata-rata (avg cost) terkini sebagai estimasi.';
