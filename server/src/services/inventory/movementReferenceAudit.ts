import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Read-only findings behind scripts/repair/e3-movement-reference-audit.ts (E3-R2). Before the
 * document lock, clients could write referenceType/referenceId freely, cancel document movements
 * per row (a TransferOut with the wrong sign), and link any movement as a batch. Nothing here
 * writes; corrections are stock adjustments decided by the accountant.
 *
 *  a. referenceType without referenceId (other than OpeningBalance, the drift repair's
 *     StockDriftRepair and the value-ledger migration's ValuationBaseline): a manual row typed by a client.
 *  b. cancelled movement of a document that is still active. `certain` for transfers and opnames
 *     (they never cancel their own rows while active); `review` for the rest, whose edit paths
 *     also cancel replaced rows.
 *  c. invalid batch link: an active outbound row whose source is missing, of another item,
 *     cancelled or not inbound, or an active inbound row that still links a batch.
 *  d. referenceId without referenceType (left by the old edit path, not caught by the new lock),
 *     or a document type whose referenceId names no such document.
 *  e. active movement of an active opname or transfer whose type or quantity no longer matches its
 *     document line (the old per-row edit changed them in place and kept the reference).
 *  f. movement of a cancelled transfer whose warehouse stock differs from that warehouse's active
 *     movements: typically a row cancelled per row (wrong sign) before the old transfer cancel
 *     reversed the whole transfer again. `review`: any other drift in that warehouse also shows.
 */
export type AuditList = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';

export interface MovementAuditRow {
  list: AuditList;
  id: string;
  movementNumber: string;
  date: Date;
  itemId: string;
  movementType: string;
  quantity: string;
  referenceType: string | null;
  referenceId: string | null;
  referenceNumber: string | null;
  isCancelled: boolean;
  note: string;
}

const COLUMNS = Prisma.sql`m.id, m.movement_number AS "movementNumber", m.date, m.item_id AS "itemId",
  m.movement_type::text AS "movementType", m.quantity::text AS quantity, m.reference_type AS "referenceType",
  m.reference_id AS "referenceId", m.reference_number AS "referenceNumber", m.is_cancelled AS "isCancelled"`;

/** Document type -> SQL that is true when `m.reference_id` names an active document of that type. */
const ACTIVE_DOCUMENT: Record<string, Prisma.Sql> = {
  StockTransfer: Prisma.sql`EXISTS (SELECT 1 FROM stock_transfers d WHERE d.id = m.reference_id AND d.status::text <> 'Cancelled')`,
  StockOpname: Prisma.sql`EXISTS (SELECT 1 FROM stock_opnames d WHERE d.id = m.reference_id AND d.status::text <> 'Cancelled')`,
  ProductionRun: Prisma.sql`EXISTS (SELECT 1 FROM production_runs d WHERE d.id = m.reference_id AND NOT d.is_cancelled)`,
  GoodsReceipt: Prisma.sql`EXISTS (SELECT 1 FROM goods_receipts d WHERE d.id = m.reference_id AND d.status::text <> 'Cancelled')`,
  DeliveryOrder: Prisma.sql`EXISTS (SELECT 1 FROM delivery_orders d WHERE d.id = m.reference_id AND d.status::text <> 'Cancelled')`,
  SalesReturn: Prisma.sql`EXISTS (SELECT 1 FROM sales_returns d WHERE d.id = m.reference_id AND d.status <> 'Cancelled')`,
  PurchaseInvoice: Prisma.sql`EXISTS (SELECT 1 FROM purchase_invoices d WHERE d.id = m.reference_id AND d.status::text <> 'Cancelled')`,
  SalesInvoice: Prisma.sql`EXISTS (SELECT 1 FROM sales_invoices d WHERE d.id = m.reference_id AND d.status::text <> 'Cancelled')`,
};

const DOCUMENT_TABLE: Record<string, string> = {
  StockTransfer: 'stock_transfers', StockOpname: 'stock_opnames', ProductionRun: 'production_runs', GoodsReceipt: 'goods_receipts',
  DeliveryOrder: 'delivery_orders', SalesReturn: 'sales_returns', PurchaseInvoice: 'purchase_invoices', SalesInvoice: 'sales_invoices',
};

const CERTAIN_B = new Set(['StockTransfer', 'StockOpname']);

type Raw = Omit<MovementAuditRow, 'list' | 'note'> & { note?: string };

export async function findMovementReferenceIssues(db: Db): Promise<MovementAuditRow[]> {
  const out: MovementAuditRow[] = [];
  const push = (list: AuditList, rows: Raw[], note: (r: Raw) => string) => {
    for (const r of rows) out.push({ ...r, list, note: note(r) });
  };

  push('a', await db.$queryRaw<Raw[]>`
    SELECT ${COLUMNS} FROM stock_movements m
    WHERE m.reference_type IS NOT NULL AND m.reference_id IS NULL AND m.reference_type NOT IN ('OpeningBalance', 'StockDriftRepair', 'ValuationBaseline')
    ORDER BY m.date, m.movement_number`, () => 'reference type set by a client, no document');

  for (const [type, active] of Object.entries(ACTIVE_DOCUMENT)) {
    push('b', await db.$queryRaw<Raw[]>`
      SELECT ${COLUMNS} FROM stock_movements m
      WHERE m.is_cancelled AND m.reference_type = ${type} AND ${active}
      ORDER BY m.date, m.movement_number`,
    () => (CERTAIN_B.has(type) ? 'certain: cancelled per row, document still active' : 'review: document still active (its edit may have replaced the row)'));
  }

  push('c', await db.$queryRaw<Raw[]>`
    SELECT ${COLUMNS},
      CASE
        WHEN m.movement_type::text IN ('In', 'AdjustmentIn', 'TransferIn') THEN 'inbound row links a batch'
        WHEN s.id IS NULL THEN 'batch not found'
        WHEN s.item_id <> m.item_id THEN 'batch of another item'
        WHEN s.is_cancelled THEN 'batch cancelled'
        ELSE 'batch is not an inbound movement'
      END AS note
    FROM stock_movements m
    LEFT JOIN stock_movements s ON s.id = m.source_movement_id
    WHERE NOT m.is_cancelled AND m.source_movement_id IS NOT NULL AND (
      m.movement_type::text IN ('In', 'AdjustmentIn', 'TransferIn')
      OR s.id IS NULL OR s.item_id <> m.item_id OR s.is_cancelled
      OR s.movement_type::text NOT IN ('In', 'AdjustmentIn', 'TransferIn'))
    ORDER BY m.date, m.movement_number`, (r) => r.note ?? '');

  push('d', await db.$queryRaw<Raw[]>`
    SELECT ${COLUMNS} FROM stock_movements m
    WHERE m.reference_id IS NOT NULL AND m.reference_type IS NULL
    ORDER BY m.date, m.movement_number`, () => 'document id without reference type (old edit)');
  for (const [type, table] of Object.entries(DOCUMENT_TABLE)) {
    push('d', await db.$queryRaw<Raw[]>`
      SELECT ${COLUMNS} FROM stock_movements m
      WHERE m.reference_type = ${type} AND m.reference_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${Prisma.raw(table)} d WHERE d.id = m.reference_id)
      ORDER BY m.date, m.movement_number`, () => `no ${type} with this id`);
  }

  push('e', await db.$queryRaw<Raw[]>`
    SELECT ${COLUMNS}, 'opname line difference ' || oi.difference::text AS note
    FROM stock_opname_items oi
    JOIN stock_opnames so ON so.id = oi.stock_opname_id AND so.status::text <> 'Cancelled'
    JOIN stock_movements m ON m.id = oi.movement_id
    WHERE NOT m.is_cancelled AND (
      m.quantity <> ABS(oi.difference)
      OR (oi.difference <> 0 AND (oi.difference > 0) <> (m.movement_type::text IN ('In', 'AdjustmentIn', 'TransferIn'))))
    ORDER BY m.date, m.movement_number`, (r) => r.note ?? '');
  push('e', await db.$queryRaw<Raw[]>`
    SELECT ${COLUMNS}, 'transfer line quantity ' || COALESCE(
      (SELECT SUM(ti.quantity) FROM stock_transfer_items ti WHERE ti.transfer_id = t.id AND ti.item_id = m.item_id), 0)::text AS note
    FROM stock_movements m
    JOIN stock_transfers t ON t.id = m.reference_id AND t.status::text <> 'Cancelled'
    WHERE m.reference_type = 'StockTransfer' AND NOT m.is_cancelled AND (
      m.movement_type::text NOT IN ('TransferOut', 'TransferIn')
      OR COALESCE((SELECT SUM(ti.quantity) FROM stock_transfer_items ti WHERE ti.transfer_id = t.id AND ti.item_id = m.item_id), 0)
        <> (SELECT SUM(x.quantity) FROM stock_movements x
            WHERE x.reference_type = 'StockTransfer' AND x.reference_id = t.id AND NOT x.is_cancelled
              AND x.item_id = m.item_id AND x.movement_type = m.movement_type))
    ORDER BY m.date, m.movement_number`, (r) => r.note ?? '');

  push('f', await db.$queryRaw<Raw[]>`
    WITH computed AS (
      SELECT item_id, warehouse_id,
        SUM(CASE WHEN movement_type::text IN ('In', 'AdjustmentIn', 'TransferIn') THEN quantity ELSE -quantity END) AS qty
      FROM stock_movements WHERE NOT is_cancelled AND warehouse_id IS NOT NULL
      GROUP BY item_id, warehouse_id)
    SELECT ${COLUMNS}, (s.current_stock - COALESCE(c.qty, 0))::text AS note
    FROM stock_movements m
    JOIN stock_transfers t ON t.id = m.reference_id AND t.status::text = 'Cancelled'
    JOIN inventory_stocks s ON s.item_id = m.item_id AND s.warehouse_id = m.warehouse_id
    LEFT JOIN computed c ON c.item_id = m.item_id AND c.warehouse_id = m.warehouse_id
    WHERE m.reference_type = 'StockTransfer' AND m.movement_type::text IN ('TransferOut', 'TransferIn')
      AND ABS(s.current_stock - COALESCE(c.qty, 0)) > 0.001
    ORDER BY m.date, m.movement_number`,
  (r) => `review: transfer cancelled; warehouse stock is ${r.note} off its active movements`);
  return out;
}
