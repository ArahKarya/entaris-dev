import { describe, it, expect } from 'vitest';
import { outboundCostFindings, type AuditMovement } from '../manualMovementAudit';

let seq = 0;
/** A row of item I, posted in call order (createdAt). */
function row(movementType: AuditMovement['movementType'], quantity: number, unitCost: number, extra: Partial<AuditMovement> = {}): AuditMovement {
  seq += 1;
  return {
    id: `m${String(seq).padStart(3, '0')}`, movementNumber: `SM-${seq}`, date: new Date('2026-03-01'), itemId: 'I',
    movementType, quantity, unitCost, totalValue: (quantity * unitCost).toFixed(2), createdAt: new Date(1_000 * seq),
    offsetAccountId: null, manual: true, ...extra,
  };
}

describe('manual movement cost audit, list a', () => {
  it('reports a manual Out priced by the client, with the value it over-credited', () => {
    const rows = [row('In', 10_000, 6_000), row('Out', 1_000, 5_000)];
    expect(outboundCostFindings(rows)).toMatchObject([
      { list: 'a', id: rows[1].id, replayedAverage: '6000.000000', difference: '-1000000.00', note: 'unit cost differs from the replayed average' },
    ]);
  });

  it('uses the average before each row: (50 x 10.000 + 100 x 20.000) / 150 after the second inbound', () => {
    const rows = [row('In', 100, 10_000), row('Out', 50, 10_000), row('In', 100, 20_000), row('AdjustmentOut', 10, 16_666.67)];
    expect(outboundCostFindings(rows)).toEqual([]);
  });

  it('skips document rows and inbound rows, and flags an Out with no costed inbound before it', () => {
    const rows = [
      row('Out', 5, 100),
      row('In', 100, 10_000, { manual: false, referenceType: 'GoodsReceipt' }),
      row('Out', 10, 9_000, { manual: false, referenceType: 'DeliveryOrder' }),
      row('AdjustmentIn', 5, 1),
    ];
    const findings = outboundCostFindings(rows);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: rows[0].id, replayedAverage: '0.000000', difference: '500.00', note: 'no costed inbound before the row (stock may predate its movements)' });
  });

  it('accepts a cost within half a cent of the average', () => {
    const rows = [row('In', 3, 10), row('In', 3, 11), row('Out', 1, 10.5)];
    expect(outboundCostFindings(rows)).toEqual([]);
  });
});
