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
