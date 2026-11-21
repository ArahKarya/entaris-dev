/**
 * Runs the data part of the value-ledger migration (E3-R6, PR-6.4b1) inside the caller's
 * transaction and reports what it changed. The SQL is read from the migration folder itself, between
 * its value-ledger-data markers: one source, no copy here. Used by scripts/repair/e3-value-baseline.ts
 * (dry run in a rolled-back transaction; --apply on dev/staging) and the integration test.
 *
 * The SQL backfills value_delta, writes one Revaluation per live purchase invoice delta on an STT
 * receipt and one 'ValuationBaseline' Revaluation per item whose stock_value is not explained by its
 * movements. It is safe to run again: on a database the ledger keeps it adds nothing. A condition it
 * cannot meet (item vs warehouse drift, no open fiscal year or user for a needed baseline, a broken
 * self-check) raises and the caller's transaction fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { VALUATION_BASELINE_REFERENCE } from './inventoryValueMath';

type Tx = Prisma.TransactionClient;

export const VALUE_LEDGER_MIGRATION = '20261112200000_inventory_value_ledger';
export const VALUE_BASELINE_AUDIT_ACTION = 'e3-value-baseline';

const BEGIN_MARKER = '-- value-ledger-data:begin';
const END_MARKER = '-- value-ledger-data:end';

/** server/prisma/migrations/<folder>/migration.sql, from src/ and from dist/ alike. */
export function valueLedgerMigrationPath(): string {
  return join(__dirname, '../../../prisma/migrations', VALUE_LEDGER_MIGRATION, 'migration.sql');
}

/** The DO block between the markers of the migration file. */
export function readValueBaselineSql(file: string = valueLedgerMigrationPath()): string {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start < 0 || end < start) throw new Error(`Value-ledger data markers not found in ${file}`);
  const sql = text.slice(start + BEGIN_MARKER.length, end).trim();
  if (!sql.startsWith('DO ')) throw new Error(`Value-ledger data part of ${file} is not a single DO block`);
  return sql;
}

/** A Revaluation row the run created (a baseline or a purchase invoice delta). */
export interface NewValueRow {
  id: string;
  movementNumber: string;
  itemId: string;
  itemCode: string;
  date: Date;
  valueDelta: Decimal;
  referenceType: string | null;
  referenceNumber: string | null;
  adjustsMovementId: string | null;
}

export interface StockValueChange {
  itemId: string;
  itemCode: string;
  before: Decimal;
  after: Decimal;
}

export interface ValueBaselineReport {
  newRows: NewValueRow[];
  /** Movements whose value_delta the run set. */
  backfilled: number;
  stockValueChanges: StockValueChange[];
}

async function snapshot(tx: Tx) {
  const [revaluations, movements, items] = await Promise.all([
    tx.stockMovement.findMany({ where: { movementType: 'Revaluation' }, select: { id: true } }),
    tx.stockMovement.findMany({ select: { id: true, valueDelta: true } }),
    tx.inventoryItem.findMany({ select: { id: true, code: true, stockValue: true } }),
  ]);
  return {
    revaluationIds: new Set(revaluations.map((r) => r.id)),
    valueDeltas: new Map(movements.map((m) => [m.id, m.valueDelta.toString()])),
    items,
  };
}

/** Runs the migration's data part in `tx` and reports the rows it added and the values it set. */
export async function runValueBaselineData(tx: Tx, sql: string = readValueBaselineSql()): Promise<ValueBaselineReport> {
  const before = await snapshot(tx);
  await tx.$executeRawUnsafe(sql);

  const created = await tx.stockMovement.findMany({
    where: { movementType: 'Revaluation', id: { notIn: [...before.revaluationIds] } },
    select: {
      id: true, movementNumber: true, itemId: true, date: true, valueDelta: true,
      referenceType: true, referenceNumber: true, adjustsMovementId: true, item: { select: { code: true } },
    },
    orderBy: { movementNumber: 'asc' },
  });
  const movements = await tx.stockMovement.findMany({
    where: { id: { in: [...before.valueDeltas.keys()] } },
    select: { id: true, valueDelta: true },
  });
  const backfilled = movements.filter((m) => before.valueDeltas.get(m.id) !== m.valueDelta.toString()).length;
  const afterValues = new Map(
    (await tx.inventoryItem.findMany({ select: { id: true, stockValue: true } })).map((i) => [i.id, i.stockValue.toString()]),
  );
  const stockValueChanges = before.items.flatMap((i) => {
    const after = afterValues.get(i.id);
    if (after === undefined || after === i.stockValue.toString()) return [];
    return [{ itemId: i.id, itemCode: i.code, before: new Decimal(i.stockValue.toString()), after: new Decimal(after) }];
  });

  return {
    newRows: created.map((r) => ({
      id: r.id,
      movementNumber: r.movementNumber,
      itemId: r.itemId,
      itemCode: r.item.code,
      date: r.date,
      valueDelta: new Decimal(r.valueDelta.toString()),
      referenceType: r.referenceType,
      referenceNumber: r.referenceNumber,
      adjustsMovementId: r.adjustsMovementId,
    })),
    backfilled,
    stockValueChanges,
  };
}

/** A live purchase invoice with a price revision whose STT delta the baseline absorbed (no Revaluation row). */
export interface RevisedInvoiceDelta {
  invoiceNumber: string;
  movementNumber: string;
  itemCode: string;
  delta: Decimal;
}

/**
 * An item whose last baseline is dated before movements that already existed when it was written:
 * the baseline amount comes from the state at the run, so a replay from the baseline (6.5a) would
 * re-value those movements. Expected empty when the train is deployed right after the year close
 * (decision #19); checked on the dump rehearsal (§8 7c).
 */
export interface MovementsAfterBaseline {
  itemCode: string;
  baselineNumber: string;
  baselineDate: Date;
  movements: number;
}

export interface ValueBaselineNotes {
  revisedInvoices: RevisedInvoiceDelta[];
  movementsAfterBaseline: MovementsAfterBaseline[];
}

/** What the reviewer of a run must see beside its rows; read-only. */
export async function findValueBaselineNotes(tx: Tx): Promise<ValueBaselineNotes> {
  const [stt] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT COUNT(*) = 2 AS ok FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND ((table_name = 'goods_receipt_items' AND column_name = 'stock_movement_id')
         OR (table_name = 'purchase_invoice_items' AND column_name = 'goods_receipt_item_id'))`;
  const revised = stt?.ok
    ? await tx.$queryRaw<{ invoiceNumber: string; movementNumber: string; itemCode: string; delta: string }[]>`
        SELECT pi.invoice_number AS "invoiceNumber", sm.movement_number AS "movementNumber", i.code AS "itemCode",
               (sm.total_value - ROUND(gri.locked_unit_cost * sm.quantity, 2))::text AS delta
          FROM stock_movements sm
          JOIN inventory_items i ON i.id = sm.item_id
          JOIN goods_receipt_items gri ON gri.stock_movement_id = sm.id
          JOIN purchase_invoice_items pii ON pii.goods_receipt_item_id = gri.id
          JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id AND pi.status::text NOT IN ('Draft', 'Cancelled')
         WHERE sm.movement_type::text = 'In' AND NOT sm.is_cancelled
           AND sm.total_value <> ROUND(gri.locked_unit_cost * sm.quantity, 2)
           AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.adjusts_movement_id = sm.id)
           AND EXISTS (SELECT 1 FROM journal_entries je WHERE starts_with(je.narration, 'Revisi harga ' || pi.invoice_number || ' ('))
         ORDER BY pi.invoice_number, sm.movement_number`
    : [];
  const after = await tx.$queryRaw<{ itemCode: string; baselineNumber: string; baselineDate: Date; movements: number }[]>`
    SELECT i.code AS "itemCode", b.movement_number AS "baselineNumber", b.date AS "baselineDate", COUNT(m.id)::int AS movements
      FROM (SELECT DISTINCT ON (item_id) * FROM stock_movements
             WHERE reference_type = ${VALUATION_BASELINE_REFERENCE} AND NOT is_cancelled
             ORDER BY item_id, date DESC, created_at DESC) b
      JOIN inventory_items i ON i.id = b.item_id
      JOIN stock_movements m ON m.item_id = b.item_id AND NOT m.is_cancelled AND m.movement_type::text <> 'Revaluation'
                            AND m.date > b.date AND m.created_at < b.created_at
     GROUP BY i.code, b.movement_number, b.date
     ORDER BY i.code`;
  return {
    revisedInvoices: revised.map((r) => ({ ...r, delta: new Decimal(r.delta) })),
    movementsAfterBaseline: after,
  };
}

/** One audit row per Revaluation the run created (an --apply of the repair script). */
export async function auditValueBaselineRows(
  tx: Tx,
  report: ValueBaselineReport,
  ctx: { userId: string; approvedBy: string },
): Promise<void> {
  for (const r of report.newRows) {
    await tx.auditLog.create({
      data: {
        userId: ctx.userId,
        action: VALUE_BASELINE_AUDIT_ACTION,
        entityType: 'StockMovement',
        entityId: r.id,
        newValues: {
          movementNumber: r.movementNumber, itemCode: r.itemCode, valueDelta: r.valueDelta.toFixed(2),
          referenceType: r.referenceType, referenceNumber: r.referenceNumber, adjustsMovementId: r.adjustsMovementId,
          day: r.date.toISOString().slice(0, 10),
        },
        via: 'repair',
        viaMeta: { script: VALUE_BASELINE_AUDIT_ACTION, approvedBy: ctx.approvedBy },
      },
    });
  }
}
